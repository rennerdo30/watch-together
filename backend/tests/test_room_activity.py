"""Regression coverage for the shared, attributed room activity log."""

import pytest
from fastapi.testclient import TestClient

from connection_manager import ConnectionManager


def _video(number: int) -> dict:
    return {
        "original_url": f"https://example.test/video-{number}",
        "stream_url": f"https://cdn.example.test/video-{number}.mp4",
        "title": f"Video {number}",
    }


def _drain_until(ws, msg_type: str, limit: int = 20) -> dict:
    for _ in range(limit):
        message = ws.receive_json()
        if message.get("type") == msg_type:
            return message.get("payload", {})
    raise AssertionError(f"no {msg_type!r} message within {limit} messages")


@pytest.fixture
def client():
    from main import app

    with TestClient(app) as test_client:
        yield test_client


def test_queue_actions_are_attributed_and_reconnect_in_sync(client):
    room = "activity-queue"
    with client.websocket_connect(f"/ws/{room}?user=alex@example.com") as alex:
        _drain_until(alex, "sync")
        with client.websocket_connect(f"/ws/{room}?user=sam@example.com") as sam:
            _drain_until(sam, "sync")

            alex.send_json({"type": "queue_add", "payload": {"video_data": _video(1)}})
            added = _drain_until(sam, "activity")["activity"]
            assert added["action"] == "queue_added"
            assert added["actor"] == "alex@example.com"
            assert added["title"] == "Video 1"

            alex.send_json({"type": "queue_pin", "payload": {"index": 0}})
            pinned = _drain_until(sam, "activity")["activity"]
            assert pinned["action"] == "queue_pinned"

            alex.send_json({"type": "queue_remove", "payload": {"index": 0}})
            removed = _drain_until(sam, "activity")["activity"]
            assert removed["action"] == "queue_removed"
            assert removed["title"] == "Video 1"

    with client.websocket_connect(f"/ws/{room}?user=late@example.com") as late:
        snapshot = _drain_until(late, "sync")
        assert [entry["action"] for entry in snapshot["activity_log"]] == [
            "queue_added", "queue_pinned", "queue_removed"
        ]


def test_playback_actions_include_actor_and_system_transitions(client):
    room = "activity-playback"
    with client.websocket_connect(f"/ws/{room}?user=alex@example.com") as ws:
        _drain_until(ws, "sync")
        for number in (1, 2):
            ws.send_json({"type": "queue_add", "payload": {"video_data": _video(number)}})
            _drain_until(ws, "activity")

        ws.send_json({"type": "queue_play", "payload": {"index": 0}})
        started = _drain_until(ws, "activity")["activity"]
        assert started["action"] == "video_started"
        assert started["actor"] == "alex@example.com"

        ws.send_json({"type": "pause", "payload": {"timestamp": 12.5}})
        paused = _drain_until(ws, "activity")["activity"]
        assert paused["action"] == "playback_paused"
        assert paused["actor"] == "alex@example.com"

        ws.send_json({"type": "video_ended", "payload": {
            "original_url": _video(1)["original_url"],
        }})
        finished = _drain_until(ws, "activity")["activity"]
        automatically_started = _drain_until(ws, "activity")["activity"]
        assert finished["action"] == "video_finished"
        assert finished["actor"] is None
        assert automatically_started["action"] == "video_started"
        assert automatically_started["actor"] is None

        ws.send_json({"type": "video_ended", "payload": {
            "original_url": _video(2)["original_url"],
        }})
        final_finished = _drain_until(ws, "activity")["activity"]
        stopped = _drain_until(ws, "activity")["activity"]
        assert final_finished["action"] == "video_finished"
        assert stopped["action"] == "playback_stopped"
        assert stopped["actor"] is None


@pytest.mark.asyncio
async def test_activity_log_is_bounded_and_round_trips_through_database():
    from services.database import get_all_rooms

    room = ConnectionManager()
    room.room_states["bounded"] = {
        "video_data": None,
        "is_playing": False,
        "timestamp": 0,
        "queue": [],
        "playing_index": -1,
        "roles": {},
        "permanent": True,
        "name": "",
        "activity_log": [],
    }
    for position in range(room.ACTIVITY_LOG_LIMIT + 5):
        await room.record_activity(
            "bounded", "queue_reordered", "alex@example.com",
            _video(1), position=position + 1,
        )

    log = room.room_states["bounded"]["activity_log"]
    assert len(log) == room.ACTIVITY_LOG_LIMIT
    assert log[0]["position"] == 6
    assert log[-1]["position"] == room.ACTIVITY_LOG_LIMIT + 5

    restored = await get_all_rooms()
    assert restored["bounded"]["activity_log"] == log
