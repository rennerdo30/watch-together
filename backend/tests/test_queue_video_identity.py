"""A YouTube video's URL aliases must occupy one queue entry."""

import asyncio
import threading

import pytest
from fastapi.testclient import TestClient

from connection_manager import ConnectionManager


VIDEO_ID = "dQw4w9WgXcQ"
OTHER_ID = "9bZkp7q19f0"
WATCH = f"https://www.youtube.com/watch?v={VIDEO_ID}&list=PL123"
SHORT = f"https://youtu.be/{VIDEO_ID}?t=42"
SHORTS = f"https://www.youtube.com/shorts/{VIDEO_ID}"
OTHER = f"https://youtu.be/{OTHER_ID}"


@pytest.fixture
def room():
    manager = ConnectionManager()
    manager.room_states["r"] = {
        "video_data": None, "is_playing": False, "timestamp": 0, "members": [],
        "queue": [], "roles": {}, "playing_index": -1, "permanent": False, "name": "",
    }
    return manager


async def test_queue_alias_moves_one_resolved_entry_to_tail_and_keeps_progress(room):
    first = {"original_url": WATCH, "title": "First", "pinned": True, "progress": 42.0}
    unrelated = {"original_url": OTHER, "title": "Other"}
    room.room_states["r"]["queue"] = [first, unrelated]
    room.room_states["r"]["video_data"] = first
    room.room_states["r"]["playing_index"] = 0
    room.room_states["r"]["timestamp"] = 42.0

    queue, pending = await room.queue_url("r", SHORT, "bob@example.com")

    assert pending is None
    assert queue == [unrelated, first]
    assert first["original_url"] == WATCH
    assert first["added_by"] == "bob@example.com"
    assert first["pinned"] is True and first["progress"] == 42.0
    assert room.room_states["r"]["playing_index"] == 1


async def test_play_now_alias_reuses_queued_entry_without_inheriting_pending(room):
    room.room_states["r"]["queue"] = [
        {"original_url": OTHER, "title": "Other"},
        {"original_url": WATCH, "title": WATCH, "pending": True,
         "pinned": True, "progress": 24.0, "added_by": "alice@example.com"},
    ]
    resolved = {"original_url": SHORTS, "title": "Resolved", "duration": 120}

    playing, queue, index = await room.prepend_to_queue("r", resolved)

    assert index == 0 and len(queue) == 2
    assert queue[0] is playing and queue[1]["original_url"] == OTHER
    assert playing["original_url"] == SHORTS
    assert playing["pinned"] is True and playing["progress"] == 24.0
    assert "pending" not in playing
    assert room.room_states["r"]["timestamp"] == 24.0


async def test_non_youtube_signed_urls_remain_distinct(room):
    first = "https://cdn.example.test/video.mp4?token=one"
    second = "https://cdn.example.test/video.mp4?token=two"
    await room.queue_url("r", first, "alice@example.com")
    queue, pending = await room.queue_url("r", second, "bob@example.com")
    assert pending is queue[1]
    assert [item["original_url"] for item in queue] == [first, second]


async def test_corrupt_alias_duplicates_collapse_around_current_entry(room):
    stale = {"original_url": WATCH, "title": "Stale", "progress": 37.0}
    playing = {"original_url": SHORT, "title": "Playing", "pinned": True}
    room.room_states["r"].update({
        "queue": [stale, playing, {"original_url": OTHER, "title": "Other"}],
        "video_data": playing, "playing_index": 1, "timestamp": 37.0,
    })

    queue, pending = await room.queue_url("r", SHORTS, "bob@example.com")

    assert pending is None and len(queue) == 2
    assert queue[-1] is playing
    assert playing["pinned"] is True and playing["progress"] == 37.0
    assert room.room_states["r"]["playing_index"] == 1


def _drain(ws, wanted, limit=20):
    for _ in range(limit):
        message = ws.receive_json()
        if message.get("type") == wanted:
            return message.get("payload", {})
    raise AssertionError(f"no {wanted!r} within {limit} messages")


def test_pending_alias_reuses_one_placeholder_and_one_extraction(monkeypatch):
    import main

    started = threading.Event()
    release = threading.Event()
    calls = []

    async def resolve(url, user_agent=None, **kwargs):
        calls.append(url)
        started.set()
        await asyncio.to_thread(release.wait, 5)
        return {"original_url": url, "title": "Resolved", "duration": 120,
                "stream_url": "https://cdn.example.test/video.mp4"}

    monkeypatch.setattr(main, "resolve_url", resolve)
    monkeypatch.setattr(main, "_prepare_queued_video", lambda *args: asyncio.sleep(0))
    try:
        with TestClient(main.app) as client:
            with client.websocket_connect("/ws/identity-alias?user=alice@example.com") as ws:
                _drain(ws, "sync")
                ws.send_json({"type": "queue_add", "payload": {"url": WATCH}})
                assert _drain(ws, "queue_update")["queue"][0]["pending"] is True
                assert started.wait(2)

                ws.send_json({"type": "queue_add", "payload": {"url": SHORT}})
                pending = _drain(ws, "queue_update")["queue"]
                assert len(pending) == 1 and pending[0]["original_url"] == WATCH
                assert pending[0]["pending"] is True

                release.set()
                resolved = _drain(ws, "queue_update")["queue"]
                assert len(resolved) == 1 and resolved[0]["title"] == "Resolved"
                assert "pending" not in resolved[0]
                assert calls == [WATCH]
    finally:
        release.set()
