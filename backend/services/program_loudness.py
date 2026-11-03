"""
Whole-video ("programme") loudness, measured once on the server.

A player that levels audio from what it has heard so far is guessing: it
starts every video at unity, climbs or falls as it listens, and has to guess
again whenever the picture jumps. A SponsorBlock skip landing in a loud
stretch of a video it had been turning down by 10 dB was loud for the two
seconds the guess took to catch up.

Here the video's default audio rendition is read once, start to end, in
ranged chunks through the same SSRF-safe path every other fetch uses, and
piped into ffmpeg's EBU R128 meter. The result, the integrated loudness of
the whole programme, is what a player needs to apply one fixed gain to
every second of it, whatever it has or has not played. Audio-only
renditions are small (about 1 MB a minute), so this is cheap next to the
video the room is already pulling.

Measurements are keyed on the stream's stable identity (itag + length +
transcode time for YouTube), so a re-resolve with fresh signatures reuses
the number, and concurrent requests for one stream share one measurement.
Only completed measurements are remembered: a refused or expired URL is
retried by the next request, not cached as "unmeasurable".
"""

import asyncio
import logging
import re
from collections import OrderedDict
from typing import Awaitable, Callable, Dict, Optional
from urllib.parse import urlparse

import httpx

from core.config import (
    DEFAULT_USER_AGENT,
    LOUDNESS_CONCURRENCY,
    LOUDNESS_FETCH_CHUNK_BYTES,
    LOUDNESS_FFMPEG_BINARY,
    LOUDNESS_MAX_BYTES,
    LOUDNESS_RESULT_CAPACITY,
    LOUDNESS_SILENT_LUFS,
    LOUDNESS_TIMEOUT_SECONDS,
)
from services import stream_owner
from services.cache import stream_identity
from services.gvs_range import rewrite_range
from services.upstream import UnsafeUpstreamError, open_upstream_stream

logger = logging.getLogger(__name__)

# ebur128's closing summary: "Integrated loudness:\n    I:   -23.1 LUFS".
_INTEGRATED = re.compile(r"Integrated loudness:\s*I:\s*(-?\d+(?:\.\d+)?)\s*LUFS")
_CONTENT_RANGE = re.compile(r"bytes (\d+)-(\d+)/(\d+|\*)")


class LoudnessUnavailable(Exception):
    """The stream could not be read or measured this time."""


_results: "OrderedDict[str, Optional[float]]" = OrderedDict()
_tasks: Dict[str, asyncio.Task] = {}
_slots = asyncio.Semaphore(LOUDNESS_CONCURRENCY)


def audio_url_of(video: Optional[dict]) -> Optional[str]:
    """The rendition a player starts on: the default audio-only track.

    None for anything there is no finished programme to measure: a live
    stream, an HLS source, or a muxed file (that would mean downloading the
    video to hear its audio).
    """
    if not isinstance(video, dict) or video.get("is_live"):
        return None
    options = video.get("audio_options") or []
    first = options[0] if options and isinstance(options[0], dict) else {}
    url = first.get("audio_url") or video.get("audio_url")
    return url if isinstance(url, str) and url else None


def parse_integrated_loudness(log: str) -> Optional[float]:
    """The integrated loudness from ffmpeg's ebur128 summary, if it has one.

    A programme with nothing above the absolute gate reports -70 LUFS: there
    is no level to correct towards, so that is None as well.
    """
    match = _INTEGRATED.search(log)
    if not match:
        return None
    value = float(match[1])
    return None if value <= LOUDNESS_SILENT_LUFS else value


def remembered(video: Optional[dict]) -> Optional[float]:
    """A finished measurement for this video's audio, without starting one."""
    url = audio_url_of(video)
    return _results.get(stream_identity(url)) if url else None


async def integrated_loudness(client: httpx.AsyncClient, video: Optional[dict]) -> Optional[float]:
    """The video's integrated loudness in LUFS, measuring it if nobody has.

    None when the video has nothing measurable or the measurement failed.
    Callers that stop waiting (asyncio.wait_for) do not cancel it: the
    measurement is shielded, and the next caller gets its result.
    """
    url = audio_url_of(video)
    if not url:
        return None
    key = stream_identity(url)
    if key in _results:
        _results.move_to_end(key)
        return _results[key]
    task = _tasks.get(key)
    if task is None:
        task = asyncio.create_task(_measure_and_remember(
            client, url, video.get(stream_owner.RESOLVED_BY_KEY), key))
        _tasks[key] = task
        task.add_done_callback(lambda _done: _tasks.pop(key, None))
    return await asyncio.shield(task)


async def _measure_and_remember(client: httpx.AsyncClient, url: str,
                                owner: Optional[str], key: str) -> Optional[float]:
    async with _slots:
        try:
            lufs = await asyncio.wait_for(measure(client, url, owner), LOUDNESS_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            logger.warning("Loudness measurement of %s timed out after %ss", url[:80], LOUDNESS_TIMEOUT_SECONDS)
            return None
        except (LoudnessUnavailable, UnsafeUpstreamError, httpx.HTTPError, OSError) as error:
            logger.warning("Loudness measurement of %s failed: %s", url[:80], error)
            return None
    _results[key] = lufs
    _results.move_to_end(key)
    while len(_results) > LOUDNESS_RESULT_CAPACITY:
        _results.popitem(last=False)
    logger.info("Programme loudness of %s: %s LUFS", key[:80], lufs)
    return lufs


async def measure(client: httpx.AsyncClient, url: str, owner: Optional[str]) -> Optional[float]:
    """Read the whole stream through ffmpeg's EBU R128 meter."""
    process = await asyncio.create_subprocess_exec(
        LOUDNESS_FFMPEG_BINARY, "-hide_banner", "-nostats",
        "-i", "pipe:0", "-map", "0:a:0", "-af", "ebur128=framelog=quiet", "-f", "null", "-",
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
    log_task = asyncio.create_task(process.stderr.read())

    async def write(chunk: bytes) -> None:
        process.stdin.write(chunk)
        await process.stdin.drain()

    try:
        try:
            await read_stream(client, url, owner, write)
        except (BrokenPipeError, ConnectionResetError) as error:
            # ffmpeg gave up on the input; its log says why.
            raise LoudnessUnavailable(f"ffmpeg stopped reading: {error}") from error
        process.stdin.close()
        returncode = await process.wait()
    except BaseException:
        if process.returncode is None:
            process.kill()
            await process.wait()
        log_task.cancel()
        raise
    log = (await log_task).decode("utf-8", "replace")
    if returncode != 0:
        raise LoudnessUnavailable(f"ffmpeg exited with {returncode}: {log[-300:]}")
    return parse_integrated_loudness(log)


async def read_stream(client: httpx.AsyncClient, url: str, owner: Optional[str],
                      write: Callable[[bytes], Awaitable[None]]) -> int:
    """Hand every byte of `url` to `write`, in ranged chunks, as its owner.

    googlevideo gets the range in its query (the fast path the proxy uses);
    anything else gets a Range header. Returns the number of bytes read.
    """
    fetcher = stream_owner.fetcher_for(url, owner)
    parsed = urlparse(url)
    start, total = 0, None
    while total is None or start < total:
        end = start + LOUDNESS_FETCH_CHUNK_BYTES - 1
        fast = rewrite_range(url, start, end)
        headers = {"Accept-Encoding": "identity", "User-Agent": DEFAULT_USER_AGENT,
                   "Referer": "https://www.youtube.com/" if fast else f"{parsed.scheme}://{parsed.netloc}/"}
        if fetcher.cookie:
            headers["Cookie"] = fetcher.cookie
        if not fast:
            headers["Range"] = f"bytes={start}-{end}"
        response, _pinned = await open_upstream_stream(client, fast.url if fast else url, headers)
        try:
            if response.headers.get("content-encoding", "identity") != "identity":
                raise LoudnessUnavailable("upstream compressed the stream")
            if fast and response.status_code in (200, 206):
                total = fast.total
            elif response.status_code == 206:
                match = _CONTENT_RANGE.fullmatch(response.headers.get("content-range", ""))
                if not match or int(match[1]) != start:
                    raise LoudnessUnavailable("upstream answered a different range")
                if match[3] != "*":
                    total = int(match[3])
            elif response.status_code == 200 and start == 0:
                # The origin ignored the Range header and is sending it all.
                total = None
            else:
                raise LoudnessUnavailable(f"upstream answered {response.status_code}")
            received = 0
            async for chunk in response.aiter_raw():
                received += len(chunk)
                if start + received > LOUDNESS_MAX_BYTES:
                    raise LoudnessUnavailable(f"stream is longer than {LOUDNESS_MAX_BYTES} bytes")
                await write(chunk)
        finally:
            await response.aclose()
        start += received
        if response.status_code == 200 and not fast:
            return start  # The whole body arrived in one response.
        if received == 0:
            if total is not None and start < total:
                raise LoudnessUnavailable("upstream sent an empty range")
            return start
        if total is None and received < end - (start - received) + 1:
            return start  # A short range from an origin that states no length: the end.
    return start
