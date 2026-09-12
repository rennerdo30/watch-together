"""
SponsorBlock: segment lookup, room-wide skip scheduling, and the admin setting.

The API is never reached: an httpx MockTransport stands in for it, which
also lets the hash-prefix request be asserted byte for byte.
"""
import asyncio
import hashlib
import json
import time

import httpx
import pytest

from services.sponsorblock import (
    SEGMENTS_KEY,
    SEGMENTS_VIDEO_KEY,
    SETTINGS_KEY,
    Segment,
    SponsorBlockClient,
    SponsorBlockError,
    SponsorSkipper,
    next_skip,
    normalize_settings,
    parse_segments,
    select_segments,
    youtube_video_id,
)
from core.config import (
    SPONSORBLOCK_CATEGORIES,
    SPONSORBLOCK_DEFAULT_CATEGORIES,
    SPONSORBLOCK_MIN_SEGMENT_SECONDS,
)

VIDEO_ID = "dQw4w9WgXcQ"
WATCH_URL = f"https://www.youtube.com/watch?v={VIDEO_ID}"


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("url", [
    WATCH_URL,
    f"https://youtube.com/watch?v={VIDEO_ID}&list=PL123&index=2",
    f"https://m.youtube.com/watch?feature=share&v={VIDEO_ID}",
    f"https://music.youtube.com/watch?v={VIDEO_ID}",
    f"https://youtu.be/{VIDEO_ID}",
    f"https://youtu.be/{VIDEO_ID}?t=42",
    f"https://www.youtube.com/shorts/{VIDEO_ID}",
    f"https://www.youtube.com/embed/{VIDEO_ID}?autoplay=1",
    f"https://www.youtube-nocookie.com/embed/{VIDEO_ID}",
    f"https://www.youtube.com/live/{VIDEO_ID}",
    f"  {WATCH_URL}  ",
])
def test_youtube_video_id_is_found_in_every_url_shape(url):
    assert youtube_video_id(url) == VIDEO_ID


@pytest.mark.parametrize("url", [
    None, "", "not a url", "https://www.twitch.tv/somestreamer",
    "https://vimeo.com/123456", "https://www.youtube.com/",
    "https://www.youtube.com/watch", "https://www.youtube.com/watch?v=tooshort",
    "https://www.youtube.com/watch?v=waytoolongforanid", "https://youtu.be/",
    "https://evil.example/watch?v=" + VIDEO_ID,
    "https://notyoutube.com/watch?v=" + VIDEO_ID,
])
def test_youtube_video_id_rejects_everything_else(url):
    assert youtube_video_id(url) is None


def test_settings_default_to_skipping_promotion():
    assert normalize_settings(None) == {
        "enabled": True, "categories": list(SPONSORBLOCK_DEFAULT_CATEGORIES)}


def test_settings_are_normalised_not_trusted():
    applied = normalize_settings({
        "enabled": 0,
        "categories": ["outro", "sponsor", "bogus", 42, "sponsor"],
    })
    assert applied == {"enabled": False, "categories": ["sponsor", "outro"]}
    assert normalize_settings({"categories": "sponsor"})["categories"] == list(SPONSORBLOCK_DEFAULT_CATEGORIES)
    assert normalize_settings({"enabled": True, "categories": []}) == {"enabled": True, "categories": []}
    assert normalize_settings("garbage") == normalize_settings(None)


def _api_entry(video_id, *segments):
    return {"videoID": video_id, "segments": [
        {"segment": [s, e], "category": c, "actionType": a, "UUID": f"u{i}",
         "videoDuration": 600, "locked": 0, "votes": 3, "description": ""}
        for i, (s, e, c, a) in enumerate(segments)
    ]}


def test_parse_segments_keeps_only_skippable_segments_of_this_video():
    body = [
        _api_entry("otherVideo1", (1, 10, "sponsor", "skip")),
        _api_entry(VIDEO_ID,
                   (30.5, 60, "sponsor", "skip"),
                   (5, 8, "intro", "skip"),
                   (100, 120, "sponsor", "mute"),        # not a skip
                   (200, 201, "poi_highlight", "poi"),   # not a skip
                   (300, 300.4, "filler", "skip"),       # shorter than the minimum
                   (400, 410, "made_up", "skip"),        # unknown category
                   (500, "x", "sponsor", "skip")),       # malformed bounds
    ]
    segments = parse_segments(body, VIDEO_ID)
    assert [(s.start, s.end, s.category) for s in segments] == [
        (5.0, 8.0, "intro"), (30.5, 60.0, "sponsor")]
    assert parse_segments({"not": "a list"}, VIDEO_ID) == []
    assert parse_segments([], VIDEO_ID) == []
    assert SPONSORBLOCK_MIN_SEGMENT_SECONDS > 0.4


def test_select_segments_filters_by_category_and_merges_neighbours():
    known = [
        Segment(10, 20, "sponsor", "a"),
        Segment(20.3, 25, "selfpromo", "b"),   # touches the sponsor: one jump
        Segment(24, 30, "interaction", "c"),   # overlaps: still one jump
        Segment(40, 50, "intro", "d"),         # not selected
        Segment(60, 70, "sponsor", "e"),
    ]
    merged = select_segments(known, ["sponsor", "selfpromo", "interaction"])
    assert [(s.start, s.end) for s in merged] == [(10, 30), (60, 70)]
    assert merged[0].category == "sponsor"
    assert select_segments(known, []) == []
    assert [(s.start, s.end) for s in select_segments(known, ["intro"])] == [(40, 50)]


def test_next_skip_finds_the_segment_ahead_or_around_the_position():
    segments = [Segment(10, 20, "sponsor", "a"), Segment(60, 70, "sponsor", "b")]
    assert next_skip(segments, 0).start == 10
    assert next_skip(segments, 15).start == 10        # inside: skip now
    assert next_skip(segments, 19.7).start == 60      # within tolerance of the end: passed
    assert next_skip(segments, 20).start == 60
    assert next_skip(segments, 70) is None
    assert next_skip([], 0) is None


# ---------------------------------------------------------------------------
# API client
# ---------------------------------------------------------------------------

def _client_with(handler):
    return SponsorBlockClient(api_url="https://sb.test", transport=httpx.MockTransport(handler))


async def test_client_asks_by_hash_prefix_for_every_category():
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json=[
            _api_entry("collision01", (0, 5, "sponsor", "skip")),
            _api_entry(VIDEO_ID, (12, 34, "sponsor", "skip"), (50, 55, "outro", "skip")),
        ])

    client = _client_with(handler)
    segments = await client.segments_for(VIDEO_ID)
    assert [(s.start, s.end, s.category) for s in segments] == [(12, 34, "sponsor"), (50, 55, "outro")]

    request = seen[0]
    expected_prefix = hashlib.sha256(VIDEO_ID.encode()).hexdigest()[:4]
    assert request.url.path == f"/api/skipSegments/{expected_prefix}"
    assert VIDEO_ID not in str(request.url)  # privacy: the id itself never leaves
    assert json.loads(request.url.params["categories"]) == list(SPONSORBLOCK_CATEGORIES)
    assert json.loads(request.url.params["actionTypes"]) == ["skip"]
    assert "watch-together" in request.headers["user-agent"]

    # Second lookup is served from the cache.
    await client.segments_for(VIDEO_ID)
    assert len(seen) == 1
    await client.aclose()


async def test_client_treats_404_as_no_segments_and_errors_as_failures():
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        return httpx.Response(404, json={"error": "Not found"})

    client = _client_with(handler)
    assert await client.segments_for(VIDEO_ID) == []
    assert await client.segments_for(VIDEO_ID) == []
    assert calls["n"] == 1  # a miss is cached too

    failing = _client_with(lambda request: httpx.Response(503))
    with pytest.raises(SponsorBlockError):
        await failing.segments_for(VIDEO_ID)

    def unreachable(request):
        raise httpx.ConnectError("boom", request=request)

    with pytest.raises(SponsorBlockError):
        await _client_with(unreachable).segments_for(VIDEO_ID)

    with pytest.raises(SponsorBlockError):
        await _client_with(lambda r: httpx.Response(200, content=b"<html>")).segments_for(VIDEO_ID)


# ---------------------------------------------------------------------------
# Skip scheduling
# ---------------------------------------------------------------------------

class FakeManager:
    """Just enough of ConnectionManager for the scheduler."""

    def __init__(self, state, clock):
        self.room_states = {"room": state}
        self.updates = []
        self.broadcasts = []
        self._clock = clock

    async def update_state(self, room_id, updates):
        state = self.room_states[room_id]
        state.update(updates)
        if "is_playing" in updates or "timestamp" in updates:
            state["last_sync_time"] = self._clock.now()

    async def broadcast(self, message, room_id, exclude=None):
        self.broadcasts.append(message)


class FakeClock:
    def __init__(self):
        self.t = 1000.0
        self.slept = []

    def now(self):
        return self.t

    async def sleep(self, seconds):
        self.slept.append(round(seconds, 3))
        self.t += seconds
        await asyncio.sleep(0)


def _playing_state(clock, timestamp=0.0, url=WATCH_URL, **extra):
    state = {
        "video_data": {"original_url": url, "is_live": False},
        "is_playing": True,
        "timestamp": timestamp,
        "last_sync_time": clock.now(),
        SETTINGS_KEY: normalize_settings(None),
    }
    state.update(extra)
    return state


def _skipper(manager, clock, handler):
    client = _client_with(handler)
    return SponsorSkipper(manager, client, now=clock.now, sleep=clock.sleep)


def _segments_handler(*segments):
    return lambda request: httpx.Response(200, json=[_api_entry(VIDEO_ID, *segments)])


async def test_skipper_moves_the_room_past_each_segment_in_turn():
    clock = FakeClock()
    manager = FakeManager(_playing_state(clock), clock)
    skipper = _skipper(manager, clock, _segments_handler(
        (10, 20, "sponsor", "skip"), (20.2, 25, "selfpromo", "skip"), (60, 70, "sponsor", "skip")))

    skipper.video_changed("room")
    await skipper.wait_idle()

    # Segments were announced to the room, then the scheduler slept until
    # the first one, skipped the merged pair, and went on to the last one.
    announced = [m for m in manager.broadcasts if m["type"] == "sponsorblock_segments"]
    assert len(announced) == 1
    assert announced[0]["payload"]["video_url"] == WATCH_URL
    assert [s["category"] for s in announced[0]["payload"]["segments"]] == ["sponsor", "selfpromo", "sponsor"]
    assert manager.room_states["room"][SEGMENTS_VIDEO_KEY] == WATCH_URL

    seeks = [m["payload"] for m in manager.broadcasts if m["type"] == "seek"]
    assert [s["timestamp"] for s in seeks] == [25.0, 70.0]
    assert seeks[0]["skipped"] == {"category": "sponsor", "start": 10.0, "end": 25.0}
    assert clock.slept == [10.0, 35.0]
    assert manager.room_states["room"]["timestamp"] == 70.0


async def test_a_skip_is_announced_to_whoever_tracks_position():
    clock = FakeClock()
    manager = FakeManager(_playing_state(clock), clock)
    skipper = _skipper(manager, clock, _segments_handler((10, 20, "sponsor", "skip")))
    heard = []
    skipper.on_skip = heard.append
    skipper.video_changed("room")
    await skipper.wait_idle()
    assert heard == ["room"]

    import main
    assert main.sponsor_skipper.on_skip == main.history_reporter.rearm


async def test_skipper_skips_immediately_when_the_room_is_inside_a_segment():
    clock = FakeClock()
    manager = FakeManager(_playing_state(clock, timestamp=15.0), clock)
    skipper = _skipper(manager, clock, _segments_handler((10, 20, "sponsor", "skip")))
    skipper.video_changed("room")
    await skipper.wait_idle()
    assert clock.slept == []
    assert [m["payload"]["timestamp"] for m in manager.broadcasts if m["type"] == "seek"] == [20.0]


async def test_skipper_respects_the_room_setting():
    clock = FakeClock()
    disabled = _playing_state(clock, **{SETTINGS_KEY: {"enabled": False, "categories": ["sponsor"]}})
    manager = FakeManager(disabled, clock)
    skipper = _skipper(manager, clock, _segments_handler((10, 20, "sponsor", "skip")))
    skipper.video_changed("room")
    await skipper.wait_idle()
    assert not [m for m in manager.broadcasts if m["type"] == "seek"]
    # Segments are still announced so the seek bar can show them.
    assert [m for m in manager.broadcasts if m["type"] == "sponsorblock_segments"]

    # Enabling the setting re-arms from the current position without refetching.
    manager.room_states["room"][SETTINGS_KEY] = {"enabled": True, "categories": ["intro"]}
    skipper.rearm("room")
    await skipper.wait_idle()
    assert not [m for m in manager.broadcasts if m["type"] == "seek"]  # sponsor is not selected

    manager.room_states["room"][SETTINGS_KEY] = {"enabled": True, "categories": ["sponsor"]}
    skipper.rearm("room")
    await skipper.wait_idle()
    assert [m["payload"]["timestamp"] for m in manager.broadcasts if m["type"] == "seek"] == [20.0]


async def test_skipper_does_nothing_for_paused_rooms_live_streams_and_other_sites():
    clock = FakeClock()
    paused = _playing_state(clock, is_playing=False)
    manager = FakeManager(paused, clock)
    skipper = _skipper(manager, clock, _segments_handler((0, 20, "sponsor", "skip")))
    skipper.video_changed("room")
    await skipper.wait_idle()
    assert not [m for m in manager.broadcasts if m["type"] == "seek"]

    calls = {"n": 0}

    def counting(request):
        calls["n"] += 1
        return httpx.Response(200, json=[_api_entry(VIDEO_ID, (0, 20, "sponsor", "skip"))])

    for state in (
        _playing_state(clock, url="https://www.twitch.tv/streamer"),
        {**_playing_state(clock), "video_data": {"original_url": WATCH_URL, "is_live": True}},
    ):
        manager = FakeManager(state, clock)
        skipper = _skipper(manager, clock, counting)
        skipper.video_changed("room")
        await skipper.wait_idle()
        assert manager.broadcasts == []
    assert calls["n"] == 0  # nothing to look up for a live stream or a non-YouTube page


async def test_skipper_forgets_a_pending_skip_when_the_room_seeks_away():
    clock = FakeClock()
    manager = FakeManager(_playing_state(clock), clock)

    started = asyncio.Event()
    release = asyncio.Event()

    async def blocking_sleep(seconds):
        clock.slept.append(seconds)
        started.set()
        await release.wait()

    client = _client_with(_segments_handler((10, 20, "sponsor", "skip")))
    skipper = SponsorSkipper(manager, client, now=clock.now, sleep=blocking_sleep)
    skipper.video_changed("room")
    await asyncio.wait_for(started.wait(), 2)

    # A member seeks past the segment: the old wait is cancelled and the
    # new position has nothing left to skip.
    await manager.update_state("room", {"timestamp": 50.0})
    skipper.rearm("room")
    release.set()
    await skipper.wait_idle()
    assert not [m for m in manager.broadcasts if m["type"] == "seek"]


async def test_skipper_does_not_overwrite_a_seek_that_landed_while_it_slept():
    clock = FakeClock()
    manager = FakeManager(_playing_state(clock), clock)

    async def sleep_during_which_a_member_seeks(seconds):
        clock.slept.append(seconds)
        clock.t += seconds
        # The seek reaches the state before the handler's re-arm cancels us.
        await manager.update_state("room", {"timestamp": 200.0})

    client = _client_with(_segments_handler((10, 20, "sponsor", "skip")))
    skipper = SponsorSkipper(manager, client, now=clock.now, sleep=sleep_during_which_a_member_seeks)
    skipper.video_changed("room")
    await skipper.wait_idle()
    assert not [m for m in manager.broadcasts if m["type"] == "seek"]
    assert manager.room_states["room"]["timestamp"] == 200.0


async def test_skipper_reports_a_crashed_lookup_and_keeps_no_dead_tasks(caplog):
    clock = FakeClock()
    manager = FakeManager(_playing_state(clock), clock)

    def exploding(request):
        raise RuntimeError("not an httpx error")

    skipper = _skipper(manager, clock, exploding)
    with caplog.at_level("ERROR"):
        skipper.video_changed("room")
        await skipper.wait_idle()
    assert "SponsorBlock lookup crashed" in caplog.text
    assert skipper._loads == {} and skipper._tasks == {}

    # A normal run leaves nothing behind either.
    healthy = _skipper(FakeManager(_playing_state(clock), clock), clock, _segments_handler((10, 20, "sponsor", "skip")))
    healthy.video_changed("room")
    await healthy.wait_idle()
    assert healthy._loads == {} and healthy._tasks == {}


async def test_skipper_ignores_a_lookup_that_finishes_after_the_video_changed():
    clock = FakeClock()
    manager = FakeManager(_playing_state(clock), clock)
    gate = asyncio.Event()

    async def slow_transport(request):
        await gate.wait()
        return httpx.Response(200, json=[_api_entry(VIDEO_ID, (0, 20, "sponsor", "skip"))])

    client = SponsorBlockClient(api_url="https://sb.test", transport=httpx.MockTransport(slow_transport))
    skipper = SponsorSkipper(manager, client, now=clock.now, sleep=clock.sleep)
    skipper.video_changed("room")
    await asyncio.sleep(0)
    manager.room_states["room"]["video_data"] = {"original_url": "https://www.twitch.tv/x", "is_live": False}
    skipper.video_changed("room")
    gate.set()
    await skipper.wait_idle()
    assert manager.room_states["room"][SEGMENTS_KEY] == []
    assert manager.broadcasts == []


# ---------------------------------------------------------------------------
# Through the WebSocket
# ---------------------------------------------------------------------------

@pytest.fixture
def client():
    from main import app
    from fastapi.testclient import TestClient
    with TestClient(app) as test_client:
        yield test_client


def _drain_until(ws, msg_type, limit=12):
    for _ in range(limit):
        message = ws.receive_json()
        if message.get("type") == msg_type:
            return message.get("payload", {})
    raise AssertionError(f"no {msg_type!r} message within {limit} messages")


def test_admin_controls_the_setting_and_everyone_learns_of_it(client):
    room = "sb-settings"
    with client.websocket_connect(f"/ws/{room}?user=admin@example.com") as ws_admin:
        joined = _drain_until(ws_admin, "sync")
        assert joined[SETTINGS_KEY] == normalize_settings(None)

        with client.websocket_connect(f"/ws/{room}?user=viewer@example.com") as ws_viewer:
            _drain_until(ws_viewer, "sync")

            ws_admin.send_json({"type": "sponsorblock_settings",
                                "payload": {"enabled": True, "categories": ["sponsor", "intro", "nope"]}})
            for ws in (ws_admin, ws_viewer):
                payload = _drain_until(ws, "room_settings_update")
                assert payload[SETTINGS_KEY] == {"enabled": True, "categories": ["sponsor", "intro"]}

            # A viewer is refused, told so, and nothing is broadcast.
            ws_viewer.send_json({"type": "sponsorblock_settings", "payload": {"enabled": False}})
            error = _drain_until(ws_viewer, "error")
            assert "admin" in error["message"].lower()
            ws_admin.send_json({"type": "ping", "payload": {"client_time": 1}})
            assert _drain_until(ws_admin, "pong", limit=2) is not None

    from connection_manager import manager
    assert manager.room_states[room][SETTINGS_KEY] == {"enabled": True, "categories": ["sponsor", "intro"]}


async def test_setting_survives_a_round_trip_through_the_database():
    from services.database import save_room, get_room, get_all_rooms
    state = {
        "video_data": None, "is_playing": False, "timestamp": 0, "queue": [],
        "playing_index": -1, "roles": {"a@example.com": "admin"}, "permanent": True,
        "name": "Movie night", SETTINGS_KEY: {"enabled": False, "categories": ["outro"]},
    }
    await save_room("sb-persist", state)
    loaded = await get_room("sb-persist")
    assert loaded[SETTINGS_KEY] == {"enabled": False, "categories": ["outro"]}
    assert (await get_all_rooms())["sb-persist"][SETTINGS_KEY] == {"enabled": False, "categories": ["outro"]}

    # A room that never had the setting is normalised on load.
    await save_room("sb-legacy", {**state, SETTINGS_KEY: None})
    from connection_manager import ConnectionManager
    fresh = ConnectionManager()
    await fresh.initialize()
    assert fresh.room_states["sb-legacy"][SETTINGS_KEY] == normalize_settings(None)


def test_setting_a_video_announces_its_segments_and_skips_the_first_one(client):
    import main

    main.sponsor_skipper.client.configure(
        api_url="https://sb.test",
        transport=httpx.MockTransport(_segments_handler((0, 30, "sponsor", "skip"), (100, 110, "intro", "skip"))),
    )
    room = "sb-skip"
    with client.websocket_connect(f"/ws/{room}?user=admin@example.com") as ws_admin:
        _drain_until(ws_admin, "sync")
        with client.websocket_connect(f"/ws/{room}?user=viewer@example.com") as ws_viewer:
            _drain_until(ws_viewer, "sync")

            ws_admin.send_json({"type": "set_video", "payload": {"video_data": {
                "original_url": WATCH_URL, "title": "Test", "stream_url": "https://cdn.test/v.mp4",
                "is_live": False}}})

            announced = _drain_until(ws_viewer, "sponsorblock_segments")
            assert announced["video_url"] == WATCH_URL
            assert [(s["start"], s["end"], s["category"]) for s in announced["segments"]] == [
                (0.0, 30.0, "sponsor"), (100.0, 110.0, "intro")]

            ws_admin.send_json({"type": "playback_ready", "payload": {"original_url": WATCH_URL}})

            # The video starts inside a sponsor segment: the room is moved
            # past it at once, and the seek says why.
            seek = _drain_until(ws_viewer, "seek")
            assert seek["timestamp"] == 30.0
            assert seek["skipped"]["category"] == "sponsor"
            # The originator is moved too: this is the server's seek, not a member's.
            assert _drain_until(ws_admin, "seek")["timestamp"] == 30.0

            # A late joiner is told the position past the segment and the segments themselves.
            with client.websocket_connect(f"/ws/{room}?user=late@example.com") as ws_late:
                joined = _drain_until(ws_late, "sync")
                assert joined["timestamp"] >= 30.0
                assert [s["category"] for s in joined[SEGMENTS_KEY]] == ["sponsor", "intro"]
                assert "sponsor_video" not in joined
