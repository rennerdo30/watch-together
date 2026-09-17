"""
One member's screen on the room's player.

A share is the first thing a room watches that this server does not fetch:
the media travels browser to browser and only the handshake passes through
here. That makes three things worth pinning — that the room's one player
has one source, that a handshake reaches exactly the browser it was
addressed to and nothing else, and that a share disappears with the person
sharing it rather than leaving everyone watching a frame that will never
change.
"""
import asyncio
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DEVELOPMENT_MODE", "true")

from connection_manager import ConnectionManager
from tests.test_connection_manager import FakeWebSocket


@pytest.fixture
def manager():
    return ConnectionManager()


async def join(manager, room_id: str, email: str) -> FakeWebSocket:
    socket = FakeWebSocket()
    assert await manager.connect(socket, room_id, email)
    return socket


class TestEveryBrowserIsAddressable:
    async def test_the_same_member_in_two_tabs_is_two_peers(self, manager):
        """A share has to reach each browser; one id per person would send
        one of the two tabs someone else's answer."""
        first = await join(manager, "room", "same@example.com")
        second = await join(manager, "room", "same@example.com")

        assert first.connection_id != second.connection_id
        peers = manager.peers("room")
        assert [peer["email"] for peer in peers] == ["same@example.com"] * 2
        assert len({peer["connection_id"] for peer in peers}) == 2

    async def test_a_browser_is_told_its_own_id(self, manager):
        socket = await join(manager, "room", "who@example.com")
        sync = [m for m in socket.sent if m["type"] == "sync"][0]["payload"]
        assert sync["your_connection_id"] == socket.connection_id
        assert sync["your_email"] == "who@example.com"


class TestOneSharerAtATime:
    async def test_the_second_sharer_is_refused(self, manager):
        first = await join(manager, "room", "first@example.com")
        second = await join(manager, "room", "second@example.com")

        assert manager.start_share("room", first, "Gameplay", "smooth")
        assert manager.start_share("room", second, "Mine instead", "smooth") is None
        assert manager.share_of("room")["email"] == "first@example.com"

    async def test_the_sharer_may_restate_their_own_share(self, manager):
        socket = await join(manager, "room", "first@example.com")
        manager.start_share("room", socket, "Gameplay", "smooth")
        assert manager.start_share("room", socket, "Gameplay", "light")
        assert manager.share_of("room")["quality"] == "light"

    async def test_a_slot_held_by_a_vanished_browser_is_free(self, manager):
        """Belt and braces: the holder is normally cleared on disconnect."""
        ghost = await join(manager, "room", "ghost@example.com")
        manager.start_share("room", ghost, "Gone", "smooth")
        manager.active_connections["room"].remove(ghost)

        newcomer = await join(manager, "room", "new@example.com")
        assert manager.start_share("room", newcomer, "Mine", "smooth")
        assert manager.share_of("room")["email"] == "new@example.com"

    async def test_the_owner_and_the_admin_may_stop_it_and_nobody_else(self, manager):
        admin = await join(manager, "room", "admin@example.com")   # first in is admin
        sharer = await join(manager, "room", "sharer@example.com")
        bystander = await join(manager, "room", "nosy@example.com")

        manager.start_share("room", sharer, "Gameplay", "smooth")
        assert manager.stop_share("room", bystander) is None
        assert manager.share_of("room") is not None
        assert manager.stop_share("room", sharer)
        assert manager.share_of("room") is None

        manager.start_share("room", sharer, "Again", "smooth")
        assert manager.stop_share("room", admin)
        assert manager.share_of("room") is None


class TestTheHandshakeGoesWhereItWasSent:
    async def test_a_signal_reaches_one_browser_and_no_other(self, manager):
        sharer = await join(manager, "room", "sharer@example.com")
        viewer = await join(manager, "room", "viewer@example.com")
        other = await join(manager, "room", "other@example.com")
        for socket in (sharer, viewer, other):
            socket.sent.clear()

        delivered = await manager.send_to_connection("room", viewer.connection_id, {
            "type": "share_signal", "payload": {"kind": "offer", "data": "v=0"},
        })

        assert delivered is True
        assert [m["payload"]["kind"] for m in viewer.sent] == ["offer"]
        assert other.sent == [] and sharer.sent == []

    async def test_a_connection_id_from_another_room_is_not_reachable(self, manager):
        """The room is part of the address: a signal must not be a way to
        reach a browser that is not in the conversation."""
        here = await join(manager, "room", "here@example.com")
        elsewhere = await join(manager, "other-room", "elsewhere@example.com")
        elsewhere.sent.clear()

        delivered = await manager.send_to_connection(
            "room", elsewhere.connection_id, {"type": "share_signal", "payload": {}})

        assert delivered is False
        assert elsewhere.sent == []
        assert here.sent[-1]["type"] != "share_signal"

    async def test_an_unknown_target_is_simply_not_delivered(self, manager):
        await join(manager, "room", "here@example.com")
        assert await manager.send_to_connection("room", "nope", {"type": "x"}) is False


class TestAShareEndsWithItsSharer:
    async def test_a_disconnecting_sharer_ends_the_share(self, manager):
        sharer = await join(manager, "room", "sharer@example.com")
        viewer = await join(manager, "room", "viewer@example.com")
        manager.start_share("room", sharer, "Gameplay", "smooth")
        viewer.sent.clear()

        await manager.disconnect(sharer, "room")

        assert manager.share_of("room") is None
        endings = [m for m in viewer.sent if m["type"] == "share_ended"]
        assert len(endings) == 1
        assert endings[0]["payload"]["reason"] == "disconnected"

    async def test_a_viewer_leaving_changes_nothing(self, manager):
        sharer = await join(manager, "room", "sharer@example.com")
        viewer = await join(manager, "room", "viewer@example.com")
        manager.start_share("room", sharer, "Gameplay", "smooth")

        await manager.disconnect(viewer, "room")

        assert manager.share_of("room") is not None

    async def test_closing_the_room_takes_the_share_with_it(self, manager):
        sharer = await join(manager, "room", "admin@example.com")
        manager.start_share("room", sharer, "Gameplay", "smooth")

        await manager.close_room("room")

        assert manager.share_of("room") is None
        assert manager.live_shares == {}


class TestAShareIsNotPartOfTheRoomsHistory:
    async def test_it_is_never_written_to_the_database(self, manager, monkeypatch):
        """A share cannot outlive the process carrying its signalling, so
        remembering one would only describe something that is gone."""
        saved = []
        import connection_manager as module
        monkeypatch.setattr(module, "save_room",
                            lambda room_id, state: saved.append(state) or asyncio.sleep(0))

        sharer = await join(manager, "room", "sharer@example.com")
        manager.start_share("room", sharer, "Gameplay", "smooth")
        await manager._save_room_state("room")

        assert saved, "the room state was not saved at all"
        assert all("live_share" not in state for state in saved)
        assert all("live_shares" not in state for state in saved)

    async def test_it_does_not_touch_the_queue_or_what_was_playing(self, manager):
        sharer = await join(manager, "room", "sharer@example.com")
        state = manager.room_states["room"]
        state["video_data"] = {"original_url": "https://youtu.be/x", "title": "A video"}
        state["queue"] = [state["video_data"]]
        state["playing_index"] = 0

        manager.start_share("room", sharer, "Gameplay", "smooth")

        assert state["video_data"]["original_url"] == "https://youtu.be/x"
        assert state["queue"] == [state["video_data"]]
        assert state["playing_index"] == 0

    async def test_someone_joining_mid_share_is_told_about_it(self, manager):
        sharer = await join(manager, "room", "sharer@example.com")
        manager.start_share("room", sharer, "Gameplay", "smooth")

        latecomer = await join(manager, "room", "late@example.com")

        sync = [m for m in latecomer.sent if m["type"] == "sync"][0]["payload"]
        assert sync["live_share"]["email"] == "sharer@example.com"
        assert sync["live_share"]["title"] == "Gameplay"
        assert any(peer["connection_id"] == sharer.connection_id for peer in sync["peers"])

    async def test_a_room_without_a_share_says_so(self, manager):
        socket = await join(manager, "room", "alone@example.com")
        sync = [m for m in socket.sent if m["type"] == "sync"][0]["payload"]
        assert sync["live_share"] is None


# --- the messages themselves, over a real socket ----------------------------

from fastapi.testclient import TestClient  # noqa: E402


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


class TestTheShareMessages:
    def test_a_share_is_announced_and_pauses_what_was_playing(self, client):
        room = "share-start"
        with client.websocket_connect(f"/ws/{room}?user=a@example.com") as sharer, \
                client.websocket_connect(f"/ws/{room}?user=b@example.com") as viewer:
            _drain_until(sharer, "sync")
            _drain_until(viewer, "sync")

            sharer.send_json({"type": "share_start",
                              "payload": {"title": "Gameplay", "quality": "smooth"}})

            announced = _drain_until(viewer, "share_started")
            assert announced["email"] == "a@example.com"
            assert announced["title"] == "Gameplay"
            # The room's own playback stops; the queue keeps its position,
            # so ending the share returns to where it was.
            from connection_manager import manager
            assert manager.room_states[room]["is_playing"] is False

    def test_a_second_sharer_is_told_someone_is_already_sharing(self, client):
        room = "share-busy"
        with client.websocket_connect(f"/ws/{room}?user=a@example.com") as first, \
                client.websocket_connect(f"/ws/{room}?user=b@example.com") as second:
            _drain_until(first, "sync")
            _drain_until(second, "sync")
            first.send_json({"type": "share_start", "payload": {"title": "Mine"}})
            _drain_until(second, "share_started")

            second.send_json({"type": "share_start", "payload": {"title": "No, mine"}})
            # A ping behind it, so a refusal that stops arriving fails this
            # test instead of hanging it: the pong is guaranteed to come.
            second.send_json({"type": "ping", "payload": {"client_time": 1}})

            refusals = []
            for _ in range(12):
                message = second.receive_json()
                if message["type"] == "error":
                    refusals.append(message["payload"]["message"])
                if message["type"] == "pong":
                    break
            assert refusals and "already sharing" in refusals[0]

    def test_the_handshake_reaches_the_other_browser_verbatim(self, client):
        room = "share-signal"
        with client.websocket_connect(f"/ws/{room}?user=a@example.com") as sharer, \
                client.websocket_connect(f"/ws/{room}?user=b@example.com") as viewer:
            sharer_id = _drain_until(sharer, "sync")["your_connection_id"]
            viewer_id = _drain_until(viewer, "sync")["your_connection_id"]

            sharer.send_json({"type": "share_signal", "payload": {
                "to": viewer_id, "kind": "offer", "data": {"sdp": "v=0", "type": "offer"}}})

            signal = _drain_until(viewer, "share_signal")
            assert signal["kind"] == "offer"
            assert signal["data"] == {"sdp": "v=0", "type": "offer"}
            # Stamped with who it came from, so the answer knows where to go.
            assert signal["from"] == sharer_id

    def test_a_viewer_announces_itself_to_the_sharer(self, client):
        room = "share-ready"
        with client.websocket_connect(f"/ws/{room}?user=a@example.com") as sharer, \
                client.websocket_connect(f"/ws/{room}?user=b@example.com") as viewer:
            _drain_until(sharer, "sync")
            viewer_id = _drain_until(viewer, "sync")["your_connection_id"]
            sharer.send_json({"type": "share_start", "payload": {"title": "Gameplay"}})
            _drain_until(sharer, "share_started")

            viewer.send_json({"type": "share_ready", "payload": {}})

            ready = _drain_until(sharer, "share_ready")
            assert ready["from"] == viewer_id
            assert ready["email"] == "b@example.com"

    def test_junk_and_oversized_payloads_are_refused(self, client):
        room = "share-junk"
        from core.config import SHARE_SIGNAL_MAX_BYTES

        with client.websocket_connect(f"/ws/{room}?user=a@example.com") as sender, \
                client.websocket_connect(f"/ws/{room}?user=b@example.com") as target:
            _drain_until(sender, "sync")
            target_id = _drain_until(target, "sync")["your_connection_id"]

            # A kind nobody handles, and an SDP far larger than any real one.
            sender.send_json({"type": "share_signal", "payload": {
                "to": target_id, "kind": "execute", "data": "rm -rf"}})
            sender.send_json({"type": "share_signal", "payload": {
                "to": target_id, "kind": "offer", "data": "x" * (SHARE_SIGNAL_MAX_BYTES + 1)}})
            # Something that is delivered, to prove the refusals were not
            # merely slower than the assertion.
            sender.send_json({"type": "share_signal", "payload": {
                "to": target_id, "kind": "ice", "data": {"candidate": "a"}}})

            signal = _drain_until(target, "share_signal")
            assert signal["kind"] == "ice"
            assert signal["data"] == {"candidate": "a"}

    def test_stopping_tells_the_room_and_leaves_the_queue_alone(self, client):
        room = "share-stop"
        with client.websocket_connect(f"/ws/{room}?user=a@example.com") as sharer, \
                client.websocket_connect(f"/ws/{room}?user=b@example.com") as viewer:
            _drain_until(sharer, "sync")
            _drain_until(viewer, "sync")
            sharer.send_json({"type": "share_start", "payload": {"title": "Gameplay"}})
            _drain_until(viewer, "share_started")

            sharer.send_json({"type": "share_stop", "payload": {}})

            ended = _drain_until(viewer, "share_ended")
            assert ended["reason"] == "stopped"
            from connection_manager import manager
            assert manager.share_of(room) is None
            assert manager.room_states[room]["queue"] == []
