"""
Warming what the room is about to need.

Both of a room's jumps are known before they happen — a SponsorBlock skip is
scheduled, and the next queue entry is coming as the current video runs out —
and both used to land in an empty buffer on bytes nobody had fetched. These
tests pin the three parts that make warming them possible and correct: the
subsegment table that turns a playback position into a byte offset, the
prediction of which queue entry plays next, and the two moments that trigger
a warm.
"""
import logging
import os
import struct
import sys
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DEVELOPMENT_MODE", "true")

from connection_manager import ConnectionManager
from core.config import PREWARM_NEXT_VIDEO_SECONDS
from services import manifest as manifest_service
from services import prewarm
from services import stream_expiry
from services import stream_owner
from services.mp4_index import Mp4Index, parse_index, parse_segment_table

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


def fixture_bytes(name: str) -> bytes:
    with open(os.path.join(FIXTURES, name), "rb") as handle:
        return handle.read()


class TestSegmentTable:
    """Where each subsegment starts, read from the index the probe already has."""

    def test_a_real_rendition_maps_seconds_to_byte_offsets(self):
        data = fixture_bytes("video.mp4")
        index = parse_index(data)
        table = parse_segment_table(data, index)

        # The fixture is three two-second subsegments.
        assert len(table.offsets) == 3
        assert table.starts == (0.0, 2.0, 4.0)
        assert table.duration == pytest.approx(6.0)

        # The first begins where the index box ends, and each following one
        # exactly a subsegment later — offsets inside the file, in order.
        assert table.offsets[0] == index.index_end + 1
        assert list(table.offsets) == sorted(table.offsets)
        assert table.offsets[-1] < len(data)

        # A position maps to the subsegment serving it, not the nearest one.
        assert table.offset_at(0) == table.offsets[0]
        assert table.offset_at(1.999) == table.offsets[0]
        assert table.offset_at(2.0) == table.offsets[1]
        assert table.offset_at(5.9) == table.offsets[2]

    def test_audio_and_video_are_indexed_apart(self):
        """Their subsegments differ in size and length; sharing one table
        would warm the wrong offsets for one of them."""
        tables = {}
        for name in ("video.mp4", "audio.mp4"):
            data = fixture_bytes(name)
            tables[name] = parse_segment_table(data, parse_index(data))
        assert tables["video.mp4"].offsets != tables["audio.mp4"].offsets

    def test_a_position_outside_the_video_has_no_subsegment(self):
        data = fixture_bytes("video.mp4")
        table = parse_segment_table(data, parse_index(data))
        assert table.offset_at(-1) is None
        assert table.offset_at(table.duration) is None
        assert table.offset_at(9999) is None

    def test_a_truncated_or_absent_index_is_not_guessed_at(self):
        """Half a table would warm plausible-looking wrong offsets."""
        data = fixture_bytes("video.mp4")
        index = parse_index(data)
        assert parse_segment_table(data[:index.index_start + 12], index) is None
        assert parse_segment_table(b"", index) is None

    def test_a_declared_count_the_box_cannot_hold_is_refused(self):
        data = bytearray(fixture_bytes("video.mp4"))
        index = parse_index(bytes(data))
        # reference_count follows the header, reference_ID, timescale, the
        # presentation time and the first offset — the last two being 32-bit
        # in a version 0 box and 64-bit above it — and two reserved bytes.
        version = data[index.index_start + 8]
        times = 8 if version == 0 else 16
        count_at = index.index_start + 12 + 4 + 4 + times + 2
        struct.pack_into(">H", data, count_at, 4096)
        assert parse_segment_table(bytes(data), index) is None

    def test_both_index_versions_are_read(self):
        """The fixtures are version 1; a version 0 box must read the same."""
        data = fixture_bytes("video.mp4")
        index = parse_index(data)
        assert data[index.index_start + 8] == 1
        table = parse_segment_table(data, index)

        # The same index, rewritten with 32-bit time fields.
        start, end = index.index_start, index.index_end + 1
        head = data[start:start + 12]
        (reference_id, timescale) = struct.unpack_from(">II", data, start + 12)
        (earliest, first_offset) = struct.unpack_from(">QQ", data, start + 20)
        entries = data[start + 38:end]
        body = (struct.pack(">II", reference_id, timescale)
                + struct.pack(">II", earliest, first_offset)
                + data[start + 36:start + 38] + entries)
        rewritten = bytearray(data[:start])
        rewritten += struct.pack(">I", len(body) + 12) + b"sidx" + b"\x00\x00\x00\x00" + body
        rewritten += data[end:]
        shifted = Mp4Index(index.init_start, index.init_end, start, start + 11 + len(body))

        from_v0 = parse_segment_table(bytes(rewritten), shifted)
        assert from_v0.starts == table.starts
        assert from_v0.duration == table.duration


class TestWhichVideoIsNext:
    """The entry prepared has to be the entry that then plays."""

    @staticmethod
    def _manager(queue, playing_index):
        manager = ConnectionManager()
        manager.room_states["room"] = {
            "queue": queue, "playing_index": playing_index, "video_data": queue[playing_index] if queue else None,
        }
        return manager

    @staticmethod
    def _entry(name, **extra):
        return {"original_url": f"https://youtu.be/{name}", "title": name, **extra}

    async def _advance(self, manager):
        """What `next_video` actually chooses, for comparison."""
        chosen, _queue, _index, _advanced = await manager.next_video("room")
        return chosen

    async def test_the_prediction_matches_what_the_advance_does(self):
        cases = [
            ([self._entry("a"), self._entry("b"), self._entry("c")], 0),
            ([self._entry("a"), self._entry("b"), self._entry("c")], 1),
            # The last entry: the queue starts over from the front.
            ([self._entry("a"), self._entry("b")], 1),
            # A pinned entry stays, so the room moves past it instead.
            ([self._entry("a", pinned=True), self._entry("b")], 0),
            # Pinned and last: nothing follows it.
            ([self._entry("a"), self._entry("b", pinned=True)], 1),
            # One entry, unpinned: nothing is left after it.
            ([self._entry("a")], 0),
        ]
        for queue, playing_index in cases:
            predicted = self._manager([dict(e) for e in queue], playing_index).peek_next_video("room")
            advanced = await self._advance(self._manager([dict(e) for e in queue], playing_index))
            predicted_url = predicted and predicted["original_url"]
            advanced_url = advanced and advanced["original_url"]
            assert predicted_url == advanced_url, f"queue={[e['title'] for e in queue]} at {playing_index}"

    def test_an_empty_or_unknown_room_predicts_nothing(self):
        assert ConnectionManager().peek_next_video("nobody") is None
        assert self._manager([], -1).peek_next_video("room") is None

    def test_predicting_changes_nothing(self):
        manager = self._manager([self._entry("a"), self._entry("b")], 0)
        before = [dict(entry) for entry in manager.room_states["room"]["queue"]]
        manager.peek_next_video("room")
        assert manager.room_states["room"]["queue"] == before
        assert manager.room_states["room"]["playing_index"] == 0


class TestWarmingAPosition:
    """The bytes serving a position, fetched before anyone asks for them."""

    @pytest.fixture(autouse=True)
    def clean(self):
        manifest_service.clear_index_cache()
        yield
        manifest_service.clear_index_cache()

    @pytest.fixture
    def probed_stream(self, monkeypatch):
        """A stream whose subsegment table is known, as after a manifest build."""
        url = "https://rr1.googlevideo.com/videoplayback?itag=137&clen=41541&lmt=1&mime=video%2Fmp4"
        data = fixture_bytes("video.mp4")
        table = parse_segment_table(data, parse_index(data))
        from services.cache import stream_identity
        monkeypatch.setitem(manifest_service._segment_tables, stream_identity(url), table)
        return url, table

    async def test_the_range_warmed_is_the_one_serving_that_second(
            self, probed_stream, monkeypatch):
        url, table = probed_stream
        warmed = []

        async def record(client, target, start, end, is_audio=False, identity=None):
            warmed.append((target, start, end, is_audio, identity))

        monkeypatch.setattr(prewarm, "prefetch_bytes", record)
        prewarm.warm_position(object(), {"video_url": url}, 4.5, identity="owner@example.com")
        await prewarm.drain()

        assert len(warmed) == 1
        target, start, end, _is_audio, identity = warmed[0]
        assert target == url
        assert start == table.offset_at(4.5) == table.offsets[2]
        assert end > start
        assert identity == "owner@example.com"

    async def test_a_stream_nobody_has_probed_is_not_guessed_at(self, monkeypatch):
        """Estimating from the average bitrate downloads the wrong megabytes."""
        warmed = []
        monkeypatch.setattr(prewarm, "prefetch_bytes",
                            lambda *args, **kwargs: warmed.append(args))
        prewarm.warm_position(object(), {"video_url": "https://cdn.test/never-probed.mp4"}, 30)
        await prewarm.drain()
        assert warmed == []

    async def test_both_streams_of_the_video_are_warmed(self, probed_stream, monkeypatch):
        url, _table = probed_stream
        audio_url = url.replace("itag=137", "itag=140")
        data = fixture_bytes("audio.mp4")
        from services.cache import stream_identity
        monkeypatch.setitem(manifest_service._segment_tables, stream_identity(audio_url),
                            parse_segment_table(data, parse_index(data)))

        warmed = []

        async def record(client, target, start, end, is_audio=False, identity=None):
            warmed.append((target, is_audio, end - start + 1))

        monkeypatch.setattr(prewarm, "prefetch_bytes", record)
        prewarm.warm_position(object(), {"video_url": url, "audio_url": audio_url}, 2.5)
        await prewarm.drain()

        assert [entry[0] for entry in warmed] == [url, audio_url]
        video_span, audio_span = warmed[0][2], warmed[1][2]
        # Audio is warmed too, and more cheaply: its subsegments are smaller.
        assert warmed[1][1] is True
        assert audio_span < video_span

    async def test_speculation_is_bounded_and_deduplicated(self, probed_stream, monkeypatch):
        url, _table = probed_stream
        started = []

        async def slow(client, target, start, end, is_audio=False, identity=None):
            started.append(target)

        monkeypatch.setattr(prewarm, "prefetch_bytes", slow)
        for _ in range(3):
            prewarm.warm_position(object(), {"video_url": url}, 4.5)
        assert len(prewarm.in_flight()) == 1
        await prewarm.drain()
        assert started == [url]


class TestTheSkipWarmsItsDestination:
    """A scheduled skip is the one jump that can be prepared for."""

    @staticmethod
    def _armed_room(sleep=None):
        """A room playing towards a sponsor segment 100 seconds away."""
        from services.sponsorblock import SponsorSkipper, SEGMENTS_KEY, SEGMENTS_VIDEO_KEY
        from tests.test_sponsorblock import FakeClock, FakeManager, _playing_state

        clock = FakeClock()
        state = _playing_state(clock)
        state[SEGMENTS_KEY] = [{"start": 100.0, "end": 130.0, "category": "sponsor", "uuid": "u"}]
        state[SEGMENTS_VIDEO_KEY] = state["video_data"]["original_url"]
        manager = FakeManager(state, clock)
        skipper = SponsorSkipper(manager, object(), now=clock.now,
                                 sleep=sleep(clock, state) if sleep else clock.sleep)
        return skipper, manager, state, clock

    async def test_the_destination_is_warmed_before_the_room_jumps(self):
        skipper, manager, state, clock = self._armed_room()
        warmed = []
        skipper.prewarm = lambda video, seconds: warmed.append((video, seconds))

        skipper.rearm("room")
        await skipper.wait_idle()

        # Warmed once, at the far side of the segment, before the seek.
        assert [seconds for _video, seconds in warmed] == [130.0]
        assert warmed[0][0] is state["video_data"]
        seeks = [m["payload"]["timestamp"] for m in manager.broadcasts if m["type"] == "seek"]
        assert seeks == [130.0]
        # The wait was split so the warm has time to finish before the jump.
        assert clock.slept[0] < 100.0
        assert sum(clock.slept) == pytest.approx(100.0)

    async def test_a_room_that_moved_on_is_not_warmed(self):
        """Paused, seeked away, or given another video during the wait: the
        skip that was scheduled no longer describes the room, and fetching
        its destination would spend bandwidth on a jump that never comes."""
        def pause_after_first_sleep(clock, state):
            async def sleep(seconds):
                await clock.sleep(seconds)
                state["is_playing"] = False
            return sleep

        skipper, manager, _state, _clock = self._armed_room(pause_after_first_sleep)
        warmed = []
        skipper.prewarm = lambda video, seconds: warmed.append(seconds)

        skipper.rearm("room")
        await skipper.wait_idle()

        assert warmed == []
        assert not [m for m in manager.broadcasts if m["type"] == "seek"]

    async def test_a_failing_warm_never_costs_the_room_its_skip(self):
        skipper, manager, _state, _clock = self._armed_room()

        def explode(video, seconds):
            raise RuntimeError("the cache is on fire")

        skipper.prewarm = explode
        skipper.rearm("room")
        await skipper.wait_idle()

        seeks = [m["payload"]["timestamp"] for m in manager.broadcasts if m["type"] == "seek"]
        assert seeks == [130.0]


class TestTheNextVideoIsPreparedAsTheCurrentOneEnds:
    @pytest.fixture
    def room(self, monkeypatch):
        import main

        prepared = []
        monkeypatch.setattr(main, "_proxy_client", object())
        monkeypatch.setattr(main.prewarm, "warm_video",
                            lambda client, video, prepare=None, room_id="": prepared.append(
                                (video, room_id)))
        main.manager.room_states["prewarm-room"] = {
            "queue": [{"original_url": "https://youtu.be/now"},
                      {"original_url": "https://youtu.be/next"}],
            "playing_index": 0,
            "video_data": {"original_url": "https://youtu.be/now", "duration": 600},
        }
        yield main, prepared
        main.manager.room_states.pop("prewarm-room", None)

    def test_nothing_happens_early_in_a_video(self, room):
        main, prepared = room
        state = main.manager.room_states["prewarm-room"]
        main._warm_next_video_if_close("prewarm-room", state, 600 - PREWARM_NEXT_VIDEO_SECONDS - 1)
        assert prepared == []

    def test_the_next_entry_is_prepared_near_the_end(self, room):
        main, prepared = room
        state = main.manager.room_states["prewarm-room"]
        main._warm_next_video_if_close("prewarm-room", state, 600 - PREWARM_NEXT_VIDEO_SECONDS + 1)
        assert [(entry["original_url"], room) for entry, room in prepared] == [
            ("https://youtu.be/next", "prewarm-room")]

    def test_a_live_stream_has_no_next_video_to_prepare(self, room):
        main, prepared = room
        state = main.manager.room_states["prewarm-room"]
        state["video_data"] = {"original_url": "https://twitch.tv/x", "is_live": True, "duration": 600}
        main._warm_next_video_if_close("prewarm-room", state, 599)
        assert prepared == []

    def test_an_empty_queue_prepares_nothing(self, room):
        main, prepared = room
        state = main.manager.room_states["prewarm-room"]
        state["queue"] = [{"original_url": "https://youtu.be/now"}]
        main._warm_next_video_if_close("prewarm-room", state, 599)
        assert prepared == []


class TestWhenASignedUrlDies:
    """A CDN URL states its own deadline, so it can be read before fetching."""

    def test_the_expiry_is_read_from_the_query(self):
        deadline = time.time() + 3600
        url = f"https://rr1.googlevideo.com/videoplayback?expire={int(deadline)}&itag=137"
        assert stream_expiry.expires_at(url) == pytest.approx(int(deadline))

    def test_the_expiry_is_read_from_the_path_form_too(self):
        deadline = int(time.time()) + 3600
        url = f"https://rr1.googlevideo.com/videoplayback/expire/{deadline}/itag/137/file.mp4"
        assert stream_expiry.expires_at(url) == deadline

    def test_a_url_that_states_no_deadline_has_none(self):
        assert stream_expiry.expires_at("https://cdn.test/best.mp4") is None
        assert stream_expiry.expires_at("") is None

    def test_a_lifetime_is_not_mistaken_for_a_timestamp(self):
        """`expires=3600` is seconds of life, not 1970. Reading it as an
        absolute time would declare every such URL dead and re-resolve
        everything on every heartbeat."""
        assert stream_expiry.expires_at("https://cdn.test/a.mp4?expires=3600") is None

    def test_a_resolve_is_as_fresh_as_its_shortest_lived_rendition(self):
        now = time.time()
        video = {
            "video_url": _signed(now + 7200, "137"),
            "available_qualities": [{"video_url": _signed(now + 7200, "137")},
                                    {"video_url": _signed(now + 30, "136")}],
            "audio_options": [{"audio_url": _signed(now + 7200, "140")}],
        }
        assert stream_expiry.seconds_remaining(video) == pytest.approx(30, abs=5)
        assert not stream_expiry.is_fresh(video, 600)
        assert stream_expiry.is_fresh(video, 10)

    def test_a_resolve_that_signs_nothing_is_never_stale(self):
        video = {"video_url": "https://cdn.test/best.mp4"}
        assert stream_expiry.seconds_remaining(video) is None
        assert stream_expiry.is_fresh(video, 600)


def _signed(deadline: float, itag: str) -> str:
    """A googlevideo URL that stops being served at `deadline`."""
    return (f"https://rr1.googlevideo.com/videoplayback?expire={int(deadline)}"
            f"&itag={itag}&clen=41541&lmt=1&mime=video%2Fmp4")


def _resolve(deadline: float, title: str = "next") -> dict:
    """A resolved video whose renditions die at `deadline`."""
    return {
        "original_url": NEXT_URL,
        "title": title,
        "duration": 300,
        "stream_type": "dash",
        "video_url": _signed(deadline, "137"),
        "audio_url": _signed(deadline, "140"),
        "available_qualities": [{"video_url": _signed(deadline, "137"), "format_id": "137"},
                                {"video_url": _signed(deadline, "136"), "format_id": "136"}],
        "audio_options": [{"audio_url": _signed(deadline, "140"), "format_id": "140"}],
    }


NEXT_URL = "https://youtu.be/next"
CURRENT_URL = "https://youtu.be/now"


class TestAQueuedVideoIsNotWarmedAgainstDeadUrls:
    """Production: every probe of the next entry refused, nine times over.

    A queue entry keeps the resolve it was added with, and a room can sit on
    it for hours. Past the `expire` in those URLs the CDN answers 403 to
    everything — which is what `Prepared 0/14 representations` and 126
    `Probe of ... returned 403` were: fourteen renditions, refused on each
    of the nine heartbeats in the last 45 seconds of the video before it.
    """

    @pytest.fixture
    def prepared(self, monkeypatch):
        """The prepare path with the network and yt-dlp replaced.

        Records what was probed and every re-resolve asked for.
        """
        import main

        probed: list = []
        resolves: list = []
        fresh = _resolve(time.time() + 21600, "re-resolved")

        async def fake_probe(client, formats, headers=None):
            probed.extend(fmt["url"] for fmt in formats)
            return len(formats)

        async def fake_resolve(url, user_agent=None, *, refresh=False,
                               room_id="", user_email=None):
            resolves.append((url, refresh, room_id))
            return fresh

        async def fake_client():
            return object()

        monkeypatch.setattr(main, "probe_formats", fake_probe)
        monkeypatch.setattr(main, "get_proxy_client", fake_client)
        # raising=False so this suite also runs against the code that had no
        # re-resolve at all, and fails on the behaviour rather than the name.
        monkeypatch.setattr(main, "resolve_url", fake_resolve, raising=False)
        return main, probed, resolves, fresh

    async def test_expired_urls_are_re_resolved_instead_of_probed(
            self, prepared, monkeypatch):
        """The whole path a heartbeat takes, from the room to the probes."""
        main, probed, resolves, fresh = prepared
        stale = _resolve(time.time() - 3600)
        monkeypatch.setattr(main, "_proxy_client", object())
        monkeypatch.setattr(prewarm, "start_initial_prefetch",
                            lambda video, audio, client: None)
        main.manager.room_states["prewarm-room"] = {
            "queue": [{"original_url": CURRENT_URL}, stale],
            "playing_index": 0,
            "video_data": {"original_url": CURRENT_URL, "duration": 600},
        }
        try:
            main._warm_next_video_if_close("prewarm-room", main.manager.room_states["prewarm-room"], 580)
            await prewarm.drain()
        finally:
            main.manager.room_states.pop("prewarm-room", None)

        # Not one request went to a URL the CDN stopped serving an hour ago.
        assert probed, "the freshly resolved renditions are what gets probed"
        assert set(probed) <= set(stream_owner.stream_urls(fresh))
        assert not set(probed) & set(stream_owner.stream_urls(stale))
        assert [(url, refresh) for url, refresh, _room in resolves] == [(NEXT_URL, True)]
        assert resolves[0][2] == "prewarm-room", "the room's members lend the cookies"

    async def test_urls_about_to_expire_are_refreshed_before_they_die(self, prepared):
        """A URL with a minute left survives the probe and dies during
        playback, which is the same 403 a few minutes later."""
        main, _probed, resolves, _fresh = prepared
        await main._prepare_queued_video(_resolve(time.time() + 60), room_id="room")
        assert len(resolves) == 1

    async def test_a_resolve_that_is_still_signed_is_probed_as_it_is(self, prepared):
        main, probed, resolves, _fresh = prepared
        good = _resolve(time.time() + 21600)

        source = await main._prepare_queued_video(good, room_id="room")

        assert resolves == [], "re-resolving a working video costs a yt-dlp run for nothing"
        assert set(probed) == ({quality["video_url"] for quality in good["available_qualities"]}
                               | {option["audio_url"] for option in good["audio_options"]})
        assert source is good

    async def test_a_site_that_does_not_sign_its_urls_is_probed(self, prepared):
        """Only a stated deadline may trigger a re-resolve; a direct file has
        none and must still be prepared."""
        main, probed, resolves, _fresh = prepared
        plain = {
            "original_url": NEXT_URL, "duration": 300,
            "available_qualities": [{"video_url": "https://cdn.test/best.mp4"}],
            "audio_options": [{"audio_url": "https://cdn.test/audio.m4a"}],
        }
        await main._prepare_queued_video(plain, room_id="room")
        assert resolves == []
        assert probed == ["https://cdn.test/best.mp4", "https://cdn.test/audio.m4a"]

    async def test_the_cached_resolve_still_wins_over_the_queue_entry(self, prepared):
        main, probed, resolves, _fresh = prepared
        from services.database import cache_format

        cached = _resolve(time.time() + 21600, "cached")
        await cache_format(NEXT_URL, cached)
        try:
            source = await main._prepare_queued_video(_resolve(time.time() - 3600),
                                                      room_id="room")
            assert source["title"] == "cached"
            assert resolves == []
            assert set(probed) <= set(stream_owner.stream_urls(cached))
        finally:
            from services.database import clear_format_cache
            await clear_format_cache()


class TestOneDoomedAttemptIsEnough:
    """Speculation must either work or cost nothing — not repeat every beat."""

    @pytest.fixture
    def room(self, monkeypatch):
        import main

        attempts: list = []
        probed: list = []

        async def fake_probe(client, formats, headers=None):
            probed.append(len(formats))
            return 0  # Everything refused, as an expired signature is.

        async def unresolvable(url, user_agent=None, *, refresh=False,
                               room_id="", user_email=None):
            attempts.append(url)
            raise RuntimeError("yt-dlp: video unavailable")

        async def fake_client():
            return object()

        monkeypatch.setattr(main, "_proxy_client", object())
        monkeypatch.setattr(main, "probe_formats", fake_probe)
        monkeypatch.setattr(main, "get_proxy_client", fake_client)
        monkeypatch.setattr(main, "resolve_url", unresolvable, raising=False)
        main.manager.room_states["prewarm-room"] = {
            "queue": [{"original_url": CURRENT_URL}, _resolve(time.time() - 3600)],
            "playing_index": 0,
            "video_data": {"original_url": CURRENT_URL, "duration": 600},
        }
        yield main, attempts, probed
        main.manager.room_states.pop("prewarm-room", None)

    async def test_nine_heartbeats_cost_one_attempt(self, room):
        """The last PREWARM_NEXT_VIDEO_SECONDS of a video are nine beats. In
        production each of them re-probed the whole ladder: 9 x 14 = 126
        refusals, and with a re-resolve in the path it would be nine yt-dlp
        runs instead."""
        main, attempts, probed = room
        state = main.manager.room_states["prewarm-room"]

        for beat in range(9):
            main._warm_next_video_if_close("prewarm-room", state, 560 + beat * 5)
            await prewarm.drain()

        assert probed == [], "nothing is probed once the source is known to be dead"
        assert len(attempts) == 1, "one re-resolve per video, not one per heartbeat"

    async def test_the_opening_bytes_of_a_dead_video_are_not_fetched_either(
            self, monkeypatch):
        """Preparation failing means these URLs do not answer; asking for
        bytes from them repeats the same refusal one layer down."""
        fetched = []
        monkeypatch.setattr(prewarm, "start_initial_prefetch",
                            lambda video, audio, client: fetched.append(video))

        async def cannot_prepare(video_data):
            return None

        prewarm.warm_video(object(), _resolve(time.time() - 3600), cannot_prepare)
        await prewarm.drain()
        assert fetched == []

    async def test_a_warm_that_works_is_not_backed_off(self, monkeypatch):
        fetched = []
        monkeypatch.setattr(prewarm, "start_initial_prefetch",
                            lambda video, audio, client: fetched.append(video))
        good = _resolve(time.time() + 21600)

        async def prepare(video_data):
            return good

        for _ in range(2):
            prewarm.warm_video(object(), good, prepare)
            await prewarm.drain()
        assert len(fetched) == 2

    async def test_a_room_that_cannot_prepare_does_not_silence_the_others(
            self, monkeypatch):
        """Whether a video can be prepared is a fact about the room: the
        re-resolve borrows the cookies of a member connected *there*. A room
        with nobody signed in must not blacklist the video for every room."""
        fetched = []
        monkeypatch.setattr(prewarm, "start_initial_prefetch",
                            lambda video, audio, client: fetched.append(video))
        video = _resolve(time.time() + 21600)

        async def cannot_prepare(video_data):
            return None

        async def can_prepare(video_data):
            return video

        prewarm.warm_video(object(), video, cannot_prepare, room_id="no-cookies-here")
        await prewarm.drain()
        prewarm.warm_video(object(), video, can_prepare, room_id="a-member-is-signed-in")
        await prewarm.drain()

        assert fetched == [video["video_url"]]

    async def test_a_ladder_that_answers_nothing_backs_off_and_says_so(
            self, monkeypatch, caplog):
        """Fresh URLs and not one readable rendition is the other failure —
        a cookie or PO-token problem, not an expiry. Backing off is still
        right (the bytes come from the addresses that just refused every
        probe), but unlike the individual probes this must stay visible:
        it is the only line that reports warming broken for a live resolve.
        """
        import main

        async def nothing_readable(client, formats, headers=None):
            return 0

        async def fake_client():
            return object()

        monkeypatch.setattr(main, "probe_formats", nothing_readable)
        monkeypatch.setattr(main, "get_proxy_client", fake_client)
        fresh = _resolve(time.time() + 21600)

        with caplog.at_level(logging.DEBUG, logger="main"):
            prepared = await main._prepare_queued_video(fresh, "room")

        assert prepared is None, "bytes from URLs that answered no probe are not worth fetching"
        summary = [record for record in caplog.records
                   if "Prepared none of the" in record.getMessage()]
        assert summary and summary[0].levelno == logging.INFO


class TestAVideoWithNoLadderIsStillWarmed:
    """A direct file has nothing to probe, which is not the same as nothing
    to warm: its opening bytes *are* the whole preparation. Treating "no
    adaptive ladder" as a failure lost the warm for every direct MP4 and
    HLS entry, and backed the video off for a quarter of an hour on top."""

    @pytest.fixture
    def room(self, monkeypatch):
        import main

        fetched: list = []
        monkeypatch.setattr(main, "_proxy_client", object())
        monkeypatch.setattr(prewarm, "start_initial_prefetch",
                            lambda video, audio, client: fetched.append((video, audio)))

        async def fake_client():
            return object()

        monkeypatch.setattr(main, "get_proxy_client", fake_client)
        direct = {
            "original_url": NEXT_URL, "title": "direct", "duration": 300,
            "stream_type": "direct",
            "stream_url": "https://cdn.test/best.mp4",
            "video_url": "https://cdn.test/best.mp4",
        }
        main.manager.room_states["prewarm-room"] = {
            "queue": [{"original_url": CURRENT_URL}, direct],
            "playing_index": 0,
            "video_data": {"original_url": CURRENT_URL, "duration": 600},
        }
        yield main, fetched
        main.manager.room_states.pop("prewarm-room", None)

    async def test_its_opening_bytes_are_fetched(self, room):
        main, fetched = room
        state = main.manager.room_states["prewarm-room"]

        main._warm_next_video_if_close("prewarm-room", state, 580)
        await prewarm.drain()

        assert fetched == [("https://cdn.test/best.mp4", None)]

    async def test_it_is_not_backed_off_as_a_failure(self, room):
        main, fetched = room
        state = main.manager.room_states["prewarm-room"]

        for beat in range(3):
            main._warm_next_video_if_close("prewarm-room", state, 580 + beat * 5)
            await prewarm.drain()

        assert prewarm._failed_videos == {}
        assert len(fetched) == 3, "a healthy video stays warmable on the next beat"


class TestSpeculationIsQuiet:
    """A rendition nobody asked for, refused, is not a warning per rendition."""

    @pytest.fixture(autouse=True)
    def clean(self):
        manifest_service.clear_index_cache()
        yield
        manifest_service.clear_index_cache()

    async def test_a_refused_speculative_probe_is_logged_at_debug(
            self, monkeypatch, caplog):
        class Refused:
            status_code = 403

            async def aread(self):
                return b""

            async def aclose(self):
                return None

        async def refuse(client, url, headers=None, max_redirects=3):
            return Refused(), None

        monkeypatch.setattr(manifest_service, "open_upstream_stream", refuse)
        formats = [{"url": _signed(time.time() - 60, str(itag))}
                   for itag in range(137, 151)]

        with caplog.at_level(logging.DEBUG, logger="services.manifest"):
            probed = await manifest_service.probe_formats(None, formats)

        assert probed == 0
        warnings = [record for record in caplog.records
                    if record.levelno >= logging.WARNING]
        assert warnings == [], "14 warnings for a fetch nobody asked for buries real ones"
        assert any("403" in record.getMessage() for record in caplog.records)

    async def test_a_probe_someone_is_waiting_for_still_warns(
            self, monkeypatch, caplog):
        """The same refusal on the manifest a player asked for is the room's
        problem, and stays visible at warning level."""
        class Refused:
            status_code = 403

            async def aread(self):
                return b""

            async def aclose(self):
                return None

        async def refuse(client, url, headers=None, max_redirects=3):
            return Refused(), None

        monkeypatch.setattr(manifest_service, "open_upstream_stream", refuse)
        with caplog.at_level(logging.DEBUG, logger="services.manifest"):
            await manifest_service.probe_index(None, _signed(time.time() - 60, "137"))

        assert [record for record in caplog.records
                if record.levelno >= logging.WARNING]


class TestWhichRenditionIsWarmed:
    """A player picks its own rung and never says which; the proxy sees it."""

    VIDEO = {
        "video_url": "https://cdn.test/best.mp4",
        "available_qualities": [
            {"video_url": "https://cdn.test/best.mp4", "height": 2160},
            {"video_url": "https://cdn.test/mid.mp4", "height": 1080},
            {"video_url": "https://cdn.test/low.mp4", "height": 360},
        ],
        "audio_url": "https://cdn.test/audio-high.m4a",
        "audio_options": [
            {"audio_url": "https://cdn.test/audio-high.m4a"},
            {"audio_url": "https://cdn.test/audio-low.m4a"},
        ],
    }

    @pytest.fixture(autouse=True)
    def clean(self):
        prewarm.forget_active_streams()
        yield
        prewarm.forget_active_streams()

    def test_without_evidence_the_resolve_choice_is_warmed(self):
        assert prewarm.stream_urls(self.VIDEO) == [
            "https://cdn.test/best.mp4", "https://cdn.test/audio-high.m4a",
        ]

    def test_the_rendition_being_fetched_wins_over_the_resolve_choice(self):
        """Warming 2160p while the room watches 1080p warms nothing useful."""
        prewarm.note_active_stream("https://cdn.test/mid.mp4")
        prewarm.note_active_stream("https://cdn.test/audio-low.m4a")

        assert prewarm.stream_urls(self.VIDEO) == [
            "https://cdn.test/mid.mp4", "https://cdn.test/audio-low.m4a",
        ]

    def test_viewers_on_different_rungs_are_both_covered_but_bounded(self):
        from core.config import PREWARM_MAX_VIDEO_RENDITIONS

        for url in ("low", "mid", "best"):
            prewarm.note_active_stream(f"https://cdn.test/{url}.mp4")

        warmed = prewarm.stream_urls(self.VIDEO)
        video = [url for url in warmed if url.endswith(".mp4")]
        assert len(video) == PREWARM_MAX_VIDEO_RENDITIONS
        assert set(video) <= {"https://cdn.test/best.mp4", "https://cdn.test/mid.mp4",
                              "https://cdn.test/low.mp4"}

    def test_a_rendition_nobody_has_touched_in_ages_is_not_active(self, monkeypatch):
        from core.config import ACTIVE_STREAM_TTL_SECONDS

        prewarm.note_active_stream("https://cdn.test/mid.mp4")
        real_monotonic = prewarm.time.monotonic
        monkeypatch.setattr(prewarm.time, "monotonic",
                            lambda: real_monotonic() + ACTIVE_STREAM_TTL_SECONDS + 1)

        assert prewarm.stream_urls(self.VIDEO)[0] == "https://cdn.test/best.mp4"

    def test_what_is_remembered_is_bounded(self):
        from core.config import ACTIVE_STREAM_LIMIT

        for index in range(ACTIVE_STREAM_LIMIT + 20):
            prewarm.note_active_stream(f"https://cdn.test/{index}.mp4")
        assert len(prewarm._active_streams) == ACTIVE_STREAM_LIMIT
        # The oldest went first, the newest are still there.
        assert "https://cdn.test/0.mp4" not in prewarm._active_streams
        assert f"https://cdn.test/{ACTIVE_STREAM_LIMIT + 19}.mp4" in prewarm._active_streams
