"""
Watch progress: where the room stopped on a video, shown on its queue entry
and used to resume it the next time it plays.

The position belongs to the server: it is the room's own timeline, not a
number a client sends. It is snapshotted whenever the room leaves a video
(play now, play from queue, auto-advance) and on every save, so a replay can
pick up where the room stopped instead of starting over.
"""
import pytest

from connection_manager import ConnectionManager


def _video(n, **extra):
    return {"original_url": f"https://youtu.be/video{n}", "title": f"Video {n}", **extra}


@pytest.fixture
async def room():
    manager = ConnectionManager()
    manager.room_states["r"] = {
        "video_data": None, "is_playing": False, "timestamp": 0, "members": [],
        "queue": [], "roles": {}, "playing_index": -1, "permanent": False, "name": "",
    }
    return manager


def _stopped_at(room, seconds, room_id="r"):
    """Place the room mid-video with playback paused, as a pause would."""
    state = room.room_states[room_id]
    state["timestamp"] = seconds
    state["is_playing"] = False


async def test_playing_a_new_video_records_where_the_old_one_stopped(room):
    await room.add_to_queue("r", _video(1, duration=600))
    await room.play_from_queue("r", 0)
    _stopped_at(room, 120)

    await room.prepend_to_queue("r", _video(2, duration=600))

    queue = room.room_states["r"]["queue"]
    assert queue[1]["progress"] == 120.0


async def test_replaying_a_queue_entry_resumes_where_it_stopped(room):
    await room.add_to_queue("r", _video(1, duration=600))
    await room.add_to_queue("r", _video(2, duration=600))
    await room.play_from_queue("r", 0)
    _stopped_at(room, 200)
    await room.prepend_to_queue("r", _video(3, duration=600))
    _stopped_at(room, 30)

    video, _queue, _index = await room.play_from_queue("r", 1)

    assert video["progress"] == 200.0
    assert room.room_states["r"]["timestamp"] == 200.0


async def test_auto_advance_resumes_the_next_entry(room):
    await room.add_to_queue("r", _video(1, duration=600))
    await room.add_to_queue("r", _video(2, duration=600))
    room.room_states["r"]["queue"][1]["progress"] = 250.0
    await room.play_from_queue("r", 0)
    _stopped_at(room, 600)

    next_v, _queue, _index, advanced = await room.next_video("r", _video(1)["original_url"])

    assert advanced and next_v["title"] == "Video 2"
    assert room.room_states["r"]["timestamp"] == 250.0


async def test_a_finished_pinned_video_starts_over_if_replayed(room):
    await room.add_to_queue("r", _video(1, duration=600, pinned=True))
    await room.play_from_queue("r", 0)
    _stopped_at(room, 600)

    await room.next_video("r", _video(1)["original_url"])
    assert room.room_states["r"]["queue"][0]["progress"] == 0

    await room.play_from_queue("r", 0)
    assert room.room_states["r"]["timestamp"] == 0.0


async def test_a_skipped_video_keeps_its_position(room):
    await room.add_to_queue("r", _video(1, duration=600, pinned=True))
    await room.add_to_queue("r", _video(2, duration=600))
    await room.play_from_queue("r", 0)
    _stopped_at(room, 300)

    await room.next_video("r", None)  # the "Play next" button skips

    assert room.room_states["r"]["queue"][0]["progress"] == 300.0


async def test_a_video_watched_into_the_credits_starts_over(room):
    await room.add_to_queue("r", _video(1, duration=600))
    await room.add_to_queue("r", _video(2, duration=600))
    await room.play_from_queue("r", 0)
    _stopped_at(room, 590)  # inside the end guard, nothing left to resume
    await room.prepend_to_queue("r", _video(3, duration=600))
    _stopped_at(room, 10)

    await room.play_from_queue("r", 1)

    assert room.room_states["r"]["timestamp"] == 0.0


async def test_a_barely_started_video_starts_over(room):
    await room.add_to_queue("r", _video(1, duration=600))
    await room.add_to_queue("r", _video(2, duration=600))
    await room.play_from_queue("r", 0)
    _stopped_at(room, 3)  # less than the minimum worth resuming
    await room.prepend_to_queue("r", _video(3, duration=600))
    _stopped_at(room, 1)

    await room.play_from_queue("r", 1)

    assert room.room_states["r"]["timestamp"] == 0.0


async def test_a_livestream_never_resumes(room):
    item = _video(1, is_live=True)
    await room.add_to_queue("r", item)
    item["progress"] = 500.0

    await room.play_from_queue("r", 0)

    assert room.room_states["r"]["timestamp"] == 0.0


async def test_progress_survives_persistence(room):
    import services.database as database

    room_id = "watch-progress-persist"
    room.room_states[room_id] = {
        "video_data": None, "is_playing": False, "timestamp": 0, "members": [],
        "queue": [], "roles": {}, "playing_index": -1, "permanent": False, "name": "",
    }
    await room.add_to_queue(room_id, _video(1, duration=600))
    await room.play_from_queue(room_id, 0)
    _stopped_at(room, 240, room_id)

    await room._save_room_state(room_id)

    saved = await database.get_room(room_id)
    assert saved["queue"][0]["progress"] == 240.0


def test_the_client_cannot_assert_watch_progress():
    from services.stream_owner import sanitize_client_video

    video = {"original_url": "https://youtu.be/x", "progress": 999.0}
    sanitize_client_video(video, None)

    assert "progress" not in video


async def test_re_resolving_keeps_the_watch_progress(monkeypatch):
    import services.resolver as resolver

    async def cached(_url):
        return {
            "original_url": "https://youtu.be/video1", "title": "Video 1",
            "stream_url": "https://cdn.test/v.mp4", "stream_type": "default",
            "duration": 600,
        }

    monkeypatch.setattr(resolver, "get_cached_format", cached)
    video = {
        "original_url": "https://youtu.be/video1", "title": "Video 1",
        "progress": 123.0, "added_by": "a@example.com", "pinned": True,
    }

    refreshed = await resolver.refresh_video_url(video)

    assert refreshed["progress"] == 123.0
    assert refreshed["added_by"] == "a@example.com"
    assert refreshed["pinned"] is True
