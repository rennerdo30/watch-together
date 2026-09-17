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
import os
import struct
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DEVELOPMENT_MODE", "true")

from connection_manager import ConnectionManager
from core.config import PREWARM_NEXT_VIDEO_SECONDS
from services import manifest as manifest_service
from services import prewarm
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
                            lambda client, video, prepare=None: prepared.append(video))
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
        assert [entry["original_url"] for entry in prepared] == ["https://youtu.be/next"]

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
