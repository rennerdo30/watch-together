"""
The queue after a video ends, and one entry per video.

Every member's player fires `ended` on its own, so the server hears about
one finished video once per member. It used to advance the queue on each
report: with three members, two more videos vanished, and a pinned video
at the tail wrapped the room back to the first entry. Playing a URL that
was already queued inserted a second copy, whose twin then stayed behind
after the video was watched.
"""
import pytest

from connection_manager import ConnectionManager
from fastapi.testclient import TestClient


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


async def test_only_the_first_end_report_advances(room):
    for n in (1, 2, 3):
        await room.add_to_queue("r", _video(n))
    await room.play_from_queue("r", 0)

    # Three members report the end of video 1. Only the first report counts.
    first = await room.next_video("r", _video(1)["original_url"])
    second = await room.next_video("r", _video(1)["original_url"])
    third = await room.next_video("r", _video(1)["original_url"])

    assert first[0]["title"] == "Video 2" and first[3] is True
    assert second[3] is False and third[3] is False
    assert second[0]["title"] == "Video 2"  # the stragglers see what is playing
    assert [v["title"] for v in room.room_states["r"]["queue"]] == ["Video 2", "Video 3"]
    assert room.room_states["r"]["playing_index"] == 0


async def test_finishing_the_last_video_starts_the_queue_from_the_front(room):
    for n in (1, 2, 3):
        await room.add_to_queue("r", _video(n))
    await room.play_from_queue("r", 0)
    # The playing video is re-queued, so it now sits last.
    await room.add_to_queue("r", _video(1))
    assert room.room_states["r"]["playing_index"] == 2
    next_v, queue, index, advanced = await room.next_video("r", _video(1)["original_url"])
    assert advanced and next_v["title"] == "Video 2" and index == 0
    assert [v["title"] for v in queue] == ["Video 2", "Video 3"]


async def test_play_next_button_always_advances(room):
    for n in (1, 2):
        await room.add_to_queue("r", _video(n))
    await room.play_from_queue("r", 0)
    next_v, queue, index, advanced = await room.next_video("r", None)
    assert advanced and next_v["title"] == "Video 2" and index == 0


async def test_a_pinned_video_stays_but_the_room_does_not_loop(room):
    await room.add_to_queue("r", _video(1, pinned=True))
    await room.play_from_queue("r", 0)
    next_v, queue, index, advanced = await room.next_video("r", _video(1)["original_url"])
    assert advanced and next_v is None and index == -1
    assert [v["title"] for v in queue] == ["Video 1"]
    assert room.room_states["r"]["is_playing"] is False


async def test_playing_a_queued_url_moves_it_rather_than_copying_it(room):
    for n in (1, 2, 3):
        await room.add_to_queue("r", _video(n))
    await room.toggle_pin("r", 2)
    # "Play now" on video 3, which is already queued (and pinned).
    v, queue, index = await room.prepend_to_queue("r", _video(3))
    assert [x["title"] for x in queue] == ["Video 3", "Video 1", "Video 2"]
    assert queue[0]["pinned"] is True and index == 0

    # Queueing an already-queued video moves it to the back, once.
    queue = await room.add_to_queue("r", _video(1))
    assert [x["title"] for x in queue] == ["Video 3", "Video 2", "Video 1"]
    assert room.room_states["r"]["playing_index"] == 0

    # Re-queueing the playing video keeps the playing index on it.
    queue = await room.add_to_queue("r", _video(3))
    assert [x["title"] for x in queue] == ["Video 2", "Video 1", "Video 3"]
    assert room.room_states["r"]["playing_index"] == 2

    # Watching it through leaves no copy behind (it stays only because it is pinned).
    _, queue, _, _ = await room.next_video("r", _video(3)["original_url"])
    assert [x["title"] for x in queue] == ["Video 2", "Video 1", "Video 3"]
    await room.toggle_pin("r", 2)
    await room.play_from_queue("r", 2)
    _, queue, _, _ = await room.next_video("r", _video(3)["original_url"])
    assert [x["title"] for x in queue] == ["Video 2", "Video 1"]


@pytest.fixture
def client():
    from main import app
    with TestClient(app) as test_client:
        yield test_client


def _drain_until(ws, msg_type, limit=12):
    for _ in range(limit):
        message = ws.receive_json()
        if message.get("type") == msg_type:
            return message.get("payload", {})
    raise AssertionError(f"no {msg_type!r} message within {limit} messages")


def test_every_member_reporting_the_end_advances_the_room_once(client):
    room = "queue-ends"
    with client.websocket_connect(f"/ws/{room}?user=a@example.com") as ws_a, \
            client.websocket_connect(f"/ws/{room}?user=b@example.com") as ws_b:
        _drain_until(ws_a, "sync")
        _drain_until(ws_b, "sync")
        for n in (1, 2, 3):
            ws_a.send_json({"type": "queue_add", "payload": {"video_data": _video(n, stream_url="https://cdn.test/v.mp4")}})
            _drain_until(ws_a, "queue_update")
            _drain_until(ws_b, "queue_update")
        ws_a.send_json({"type": "queue_play", "payload": {"index": 0}})
        _drain_until(ws_a, "queue_update")
        _drain_until(ws_b, "queue_update")

        # Both players end video 1.
        ws_a.send_json({"type": "video_ended", "payload": {"original_url": _video(1)["original_url"]}})
        ws_b.send_json({"type": "video_ended", "payload": {"original_url": _video(1)["original_url"]}})
        update = _drain_until(ws_b, "queue_update")
        assert [v["title"] for v in update["queue"]] == ["Video 2", "Video 3"]

        _drain_until(ws_b, "set_video")

        # Nothing else advanced: a ping answers before any further queue update.
        ws_b.send_json({"type": "ping", "payload": {"client_time": 1}})
        message = ws_b.receive_json()
        assert message["type"] == "pong", message

    from connection_manager import manager
    assert [v["title"] for v in manager.room_states[room]["queue"]] == ["Video 2", "Video 3"]
    assert manager.room_states[room]["video_data"]["title"] == "Video 2"
