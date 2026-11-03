"""
Whole-video loudness: the server measures a video's integrated loudness once
so a player can apply one gain to all of it.

The player's leveller used to know only what it had played. Every seek reset
it to unity, so a SponsorBlock skip into a stretch it had been turning down
by 10 dB was loud for the ~2 s it took to measure again. These tests pin the
server half: the measurement reads the *whole* stream (not the start), gets
the level right, is shared between requests, and is reachable from the room.
"""
import asyncio
import os
import re
import shutil
import subprocess
import tempfile

import pytest
from fastapi.testclient import TestClient

import main as main_module
from services import program_loudness

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg is not installed")

AUDIO_URL = "https://media.example.com/audio.m4a?itag=251&clen=1&lmt=1"


@pytest.fixture(autouse=True)
def forget_measurements():
    program_loudness._results.clear()
    program_loudness._tasks.clear()
    yield
    program_loudness._results.clear()
    program_loudness._tasks.clear()


def fragmented_audio(segments) -> bytes:
    """An fMP4 audio file (what YouTube serves), built from (seconds, dB) parts."""
    parts = "".join(f"[s{i}]" for i in range(len(segments)))
    inputs, filters = [], []
    for i, (seconds, gain_db) in enumerate(segments):
        inputs += ["-f", "lavfi", "-i", f"sine=frequency=1000:duration={seconds}:sample_rate=48000"]
        filters.append(f"[{i}:a]volume={gain_db}dB[s{i}]")
    # (concat with a single input renders silence, so one part is mapped directly.)
    graph = (filters[0].replace("[s0]", "[out]") if len(segments) == 1
             else ";".join(filters) + f";{parts}concat=n={len(segments)}:v=0:a=1[out]")
    # Muxed like YouTube's audio renditions: ~10 s fragments behind a sidx.
    # (global_sidx needs a seekable output, hence the file.)
    with tempfile.TemporaryDirectory() as directory:
        path = os.path.join(directory, "audio.m4a")
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", *inputs, "-filter_complex", graph, "-map", "[out]",
             "-c:a", "aac", "-b:a", "96k", "-frag_duration", "10000000",
             "-movflags", "+empty_moov+default_base_moof+global_sidx", path],
            check=True, capture_output=True)
        with open(path, "rb") as file:
            return file.read()


class RangeOrigin:
    """A stand-in origin serving one file, honouring Range like a CDN."""

    def __init__(self, body: bytes):
        self.body = body
        self.ranges = []

    async def __call__(self, client, url, headers=None, max_redirects=0):
        match = re.fullmatch(r"bytes=(\d+)-(\d+)", (headers or {}).get("Range", ""))
        assert match, "every request for the stream must be ranged"
        start, end = int(match[1]), min(int(match[2]), len(self.body) - 1)
        self.ranges.append((start, end))
        return FakeResponse(206, self.body[start:end + 1],
                            {"content-range": f"bytes {start}-{end}/{len(self.body)}"}), None


class FakeResponse:
    def __init__(self, status: int, body: bytes, headers: dict):
        self.status_code, self._body, self.headers = status, body, headers

    async def aiter_raw(self):
        for offset in range(0, len(self._body), 65536):
            yield self._body[offset:offset + 65536]

    async def aclose(self):
        pass


def test_the_summary_is_read_and_silence_has_no_level():
    log = "[Parsed_ebur128_0] Summary:\n\n  Integrated loudness:\n    I:         -23.4 LUFS\n    Threshold: -33.4 LUFS\n"
    assert program_loudness.parse_integrated_loudness(log) == -23.4
    silent = log.replace("-23.4 LUFS\n    Threshold", "-70.0 LUFS\n    Threshold")
    assert program_loudness.parse_integrated_loudness(silent) is None
    assert program_loudness.parse_integrated_loudness("no summary") is None


def test_only_a_finished_programme_with_its_own_audio_is_measured():
    video = {"audio_options": [{"audio_url": "https://a/first"}, {"audio_url": "https://a/second"}],
             "audio_url": "https://a/other"}
    assert program_loudness.audio_url_of(video) == "https://a/first"
    assert program_loudness.audio_url_of({"audio_url": "https://a/only"}) == "https://a/only"
    assert program_loudness.audio_url_of({**video, "is_live": True}) is None
    assert program_loudness.audio_url_of({"stream_url": "https://a/muxed.m3u8"}) is None


async def test_the_whole_stream_is_measured_not_just_its_opening(monkeypatch):
    """A quiet opening and a loud body: the number is the body's, near enough.

    A leveller that has only heard the opening would boost; the programme
    is mostly loud, so the right correction is a cut.
    """
    body = fragmented_audio([(20, -30), (100, -6)])
    origin = RangeOrigin(body)
    monkeypatch.setattr(program_loudness, "open_upstream_stream", origin)
    monkeypatch.setattr(program_loudness, "LOUDNESS_FETCH_CHUNK_BYTES", 200_000)

    lufs = await program_loudness.measure(object(), AUDIO_URL, None)

    monkeypatch.setattr(program_loudness, "open_upstream_stream", RangeOrigin(fragmented_audio([(20, -30)])))
    opening = await program_loudness.measure(object(), AUDIO_URL, None)
    monkeypatch.setattr(program_loudness, "open_upstream_stream", RangeOrigin(fragmented_audio([(100, -6)])))
    loud_part = await program_loudness.measure(object(), AUDIO_URL, None)

    assert lufs is not None and opening is not None and loud_part is not None
    assert abs(lufs - loud_part) < 1.5, (lufs, loud_part)
    assert lufs - opening > 20, "the measurement only heard the opening"
    assert origin.ranges[-1][1] == len(body) - 1, "the stream was not read to its end"
    assert len(origin.ranges) > 1, "the stream was not read in chunks"
    covered = sum(end - start + 1 for start, end in origin.ranges)
    assert covered == len(body)


async def test_a_stream_is_measured_once_however_many_ask(monkeypatch):
    calls = []

    async def measure(client, url, owner):
        calls.append(url)
        await asyncio.sleep(0.05)
        return -14.0

    monkeypatch.setattr(program_loudness, "measure", measure)
    video = {"audio_url": AUDIO_URL}
    results = await asyncio.gather(*(program_loudness.integrated_loudness(object(), video) for _ in range(5)))
    assert results == [-14.0] * 5
    # A re-resolve signs the URL differently; the stream is the same bytes.
    resigned = {"audio_url": AUDIO_URL + "&expire=2&sig=x"}
    assert await program_loudness.integrated_loudness(object(), resigned) == -14.0
    assert len(calls) == 1


async def test_an_unreachable_or_refused_origin_is_no_measurement_not_an_error(monkeypatch):
    from services.upstream import UnsafeUpstreamError

    async def refused(*args, **kwargs):
        raise UnsafeUpstreamError("Could not resolve host")

    monkeypatch.setattr(program_loudness, "open_upstream_stream", refused)
    assert await program_loudness.integrated_loudness(object(), {"audio_url": AUDIO_URL}) is None


async def test_a_failure_is_not_remembered(monkeypatch):
    outcomes = [program_loudness.LoudnessUnavailable("403"), -20.0]

    async def measure(client, url, owner):
        outcome = outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    monkeypatch.setattr(program_loudness, "measure", measure)
    video = {"audio_url": AUDIO_URL}
    assert await program_loudness.integrated_loudness(object(), video) is None
    assert await program_loudness.integrated_loudness(object(), video) == -20.0


def test_the_endpoint_answers_for_a_resolved_video(monkeypatch):
    video = {"original_url": "https://youtu.be/loud", "audio_url": AUDIO_URL}

    async def cached(url):
        return video if url == video["original_url"] else None

    async def measure(client, url, owner):
        return -12.5

    monkeypatch.setattr(main_module, "get_cached_format", cached)
    monkeypatch.setattr(program_loudness, "measure", measure)
    with TestClient(main_module.app) as client:
        known = client.get("/api/loudness", params={"url": "https://youtu.be/loud", "user": "a@example.com"})
        unknown = client.get("/api/loudness", params={"url": "https://youtu.be/never", "user": "a@example.com"})
    assert known.status_code == 200 and known.json() == {"integrated_lufs": -12.5, "pending": False}
    assert unknown.json() == {"integrated_lufs": None, "pending": False}


def test_a_long_measurement_answers_pending_and_finishes_for_the_next_request(monkeypatch):
    """nginx gives /api requests 20 s; a long video's measurement can take longer."""
    video = {"original_url": "https://youtu.be/long", "audio_url": AUDIO_URL}
    release = []

    async def cached(url):
        return video

    async def measure(client, url, owner):
        while not release:
            await asyncio.sleep(0.01)
        return -16.0

    monkeypatch.setattr(main_module, "get_cached_format", cached)
    monkeypatch.setattr(main_module, "LOUDNESS_RESPONSE_WAIT_SECONDS", 0.1)
    monkeypatch.setattr(program_loudness, "measure", measure)
    params = {"url": "https://youtu.be/long", "user": "a@example.com"}
    with TestClient(main_module.app) as client:
        assert client.get("/api/loudness", params=params).json() == {"integrated_lufs": None, "pending": True}
        release.append(True)
        assert client.get("/api/loudness", params=params).json() == {"integrated_lufs": -16.0, "pending": False}
