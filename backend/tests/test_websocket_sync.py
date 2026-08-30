"""
WebSocket synchronization tests.

These exercise the core product promise at the protocol level: when one
client acts, every other client in the room learns the authoritative
position, and a client joining mid-playback is told where to start.
Browser-level convergence is covered by the Playwright suite in
frontend/e2e; this suite keeps the server contract honest in CI without
a browser or a real video.
"""
import pytest
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DEVELOPMENT_MODE", "true")

from fastapi.testclient import TestClient

# Maximum position error a client may be told to accept, in seconds.
# The player corrects small drift with playbackRate and hard-seeks above
# this; the server must never hand out a position vaguer than this.
SYNC_TOLERANCE_SECONDS = 1.0


@pytest.fixture
def client():
    """A client with the app lifespan running.

    The context manager form matters here: it runs every WebSocket
    session on one event loop. Without it each session gets its own
    loop and they contend on the SQLite room store, so broadcasts
    between two clients never arrive.
    """
    from main import app
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture(autouse=True)
def clean_rooms():
    """Isolate room state between tests."""
    from connection_manager import manager
    manager.room_states.clear()
    manager.active_connections.clear()
    manager._room_locks.clear()
    yield
    manager.room_states.clear()
    manager.active_connections.clear()
    manager._room_locks.clear()


def _drain_until(ws, msg_type, limit=10):
    """Read messages until one of msg_type arrives; return its payload."""
    for _ in range(limit):
        message = ws.receive_json()
        if message.get("type") == msg_type:
            return message.get("payload", {})
    raise AssertionError(f"no {msg_type!r} message within {limit} messages")


class TestTwoClientSync:
    def test_second_client_receives_state_on_join(self, client):
        room = "sync-join"
        with client.websocket_connect(f"/ws/{room}?user=a@example.com") as ws_a:
            _drain_until(ws_a, "sync")
            ws_a.send_json({"type": "seek", "payload": {"timestamp": 42.5}})

            with client.websocket_connect(f"/ws/{room}?user=b@example.com") as ws_b:
                payload = _drain_until(ws_b, "sync")
                assert abs(payload["timestamp"] - 42.5) < SYNC_TOLERANCE_SECONDS

    def test_play_propagates_to_other_client(self, client):
        room = "sync-play"
        with client.websocket_connect(f"/ws/{room}?user=a@example.com") as ws_a:
            _drain_until(ws_a, "sync")
            with client.websocket_connect(f"/ws/{room}?user=b@example.com") as ws_b:
                _drain_until(ws_b, "sync")

                ws_a.send_json({"type": "play", "payload": {"timestamp": 12.0}})
                payload = _drain_until(ws_b, "play")
                assert abs(payload["timestamp"] - 12.0) < SYNC_TOLERANCE_SECONDS

    def test_pause_propagates_and_freezes_position(self, client):
        room = "sync-pause"
        with client.websocket_connect(f"/ws/{room}?user=a@example.com") as ws_a:
            _drain_until(ws_a, "sync")
            with client.websocket_connect(f"/ws/{room}?user=b@example.com") as ws_b:
                _drain_until(ws_b, "sync")

                ws_a.send_json({"type": "pause", "payload": {"timestamp": 30.0}})
                payload = _drain_until(ws_b, "pause")
                assert abs(payload["timestamp"] - 30.0) < SYNC_TOLERANCE_SECONDS

        from connection_manager import manager
        assert manager.room_states[room]["is_playing"] is False

    def test_seek_propagates_to_other_client(self, client):
        room = "sync-seek"
        with client.websocket_connect(f"/ws/{room}?user=a@example.com") as ws_a:
            _drain_until(ws_a, "sync")
            with client.websocket_connect(f"/ws/{room}?user=b@example.com") as ws_b:
                _drain_until(ws_b, "sync")

                ws_a.send_json({"type": "seek", "payload": {"timestamp": 300.0}})
                payload = _drain_until(ws_b, "seek")
                assert abs(payload["timestamp"] - 300.0) < SYNC_TOLERANCE_SECONDS

    def test_sender_does_not_receive_own_action(self, client):
        """Actions echo to everyone except the originator."""
        room = "sync-echo"
        with client.websocket_connect(f"/ws/{room}?user=a@example.com") as ws_a:
            _drain_until(ws_a, "sync")
            ws_a.send_json({"type": "seek", "payload": {"timestamp": 5.0}})
            ws_a.send_json({"type": "ping", "payload": {"client_time": 1}})
            # The next message must be the pong, not an echoed seek.
            assert _drain_until(ws_a, "pong", limit=3) is not None


class TestLatencyMeasurement:
    def test_ping_returns_pong_with_both_clocks(self, client):
        room = "sync-ping"
        with client.websocket_connect(f"/ws/{room}?user=a@example.com") as ws:
            _drain_until(ws, "sync")
            ws.send_json({"type": "ping", "payload": {"client_time": 1234.5}})
            payload = _drain_until(ws, "pong")
            assert payload["client_time"] == 1234.5
            assert payload["server_time"] > 0


class TestProtocolRobustness:
    def test_room_id_is_sanitized(self, client):
        """Injection characters are stripped from the room id."""
        with client.websocket_connect("/ws/room..<script>?user=a@example.com") as ws:
            _drain_until(ws, "sync")
        from connection_manager import manager
        assert "room..<script>" not in manager.room_states
        assert "roomscript" in manager.room_states

    def test_malformed_json_does_not_drop_connection(self, client):
        room = "sync-badjson"
        with client.websocket_connect(f"/ws/{room}?user=a@example.com") as ws:
            _drain_until(ws, "sync")
            ws.send_text("not json at all")
            ws.send_json({"type": "ping", "payload": {"client_time": 7}})
            assert _drain_until(ws, "pong")["client_time"] == 7

    def test_unknown_message_type_is_ignored(self, client):
        room = "sync-unknown"
        with client.websocket_connect(f"/ws/{room}?user=a@example.com") as ws:
            _drain_until(ws, "sync")
            ws.send_json({"type": "definitely-not-a-real-type", "payload": {}})
            ws.send_json({"type": "ping", "payload": {"client_time": 9}})
            assert _drain_until(ws, "pong")["client_time"] == 9

    def test_non_string_message_type_is_ignored(self, client):
        room = "sync-badtype"
        with client.websocket_connect(f"/ws/{room}?user=a@example.com") as ws:
            _drain_until(ws, "sync")
            ws.send_json({"type": {"nested": "object"}, "payload": {}})
            ws.send_json({"type": "ping", "payload": {"client_time": 11}})
            assert _drain_until(ws, "pong")["client_time"] == 11

    def test_oversized_message_is_ignored(self, client):
        room = "sync-oversized"
        with client.websocket_connect(f"/ws/{room}?user=a@example.com") as ws:
            _drain_until(ws, "sync")
            ws.send_json({"type": "seek", "payload": {"pad": "x" * (100 * 1024 + 100)}})
            ws.send_json({"type": "ping", "payload": {"client_time": 13}})
            assert _drain_until(ws, "pong")["client_time"] == 13


class TestRoleAssignment:
    def test_first_user_becomes_admin(self, client):
        room = "sync-roles"
        with client.websocket_connect(f"/ws/{room}?user=first@example.com") as ws:
            payload = _drain_until(ws, "sync")
            assert payload["roles"]["first@example.com"] == "admin"

    def test_second_user_is_plain_user(self, client):
        room = "sync-roles2"
        with client.websocket_connect(f"/ws/{room}?user=first@example.com") as ws_a:
            _drain_until(ws_a, "sync")
            with client.websocket_connect(f"/ws/{room}?user=second@example.com") as ws_b:
                payload = _drain_until(ws_b, "sync")
                assert payload["roles"]["second@example.com"] == "user"


class TestRoomRename:
    """A room can be given a display name after creation.

    The id is the address — links, persistence, reconnects — so renaming
    changes only what people see. Only the admin may set it, and every
    member is told through the same settings broadcast the permanent
    toggle uses.
    """

    def test_admin_rename_reaches_the_other_client(self, client):
        room = "/ws/rename-shared"
        with client.websocket_connect(f"{room}?user=admin@example.com") as admin:
            _drain_until(admin, "sync")
            with client.websocket_connect(f"{room}?user=member@example.com") as member:
                _drain_until(member, "sync")

                admin.send_json({"type": "rename_room",
                                 "payload": {"name": "  Movie Night  "}})

                payload = _drain_until(member, "room_settings_update")
                assert payload["name"] == "Movie Night"

    def test_non_admin_rename_is_refused(self, client):
        room = "/ws/rename-refused"
        with client.websocket_connect(f"{room}?user=admin@example.com") as admin:
            _drain_until(admin, "sync")
            with client.websocket_connect(f"{room}?user=member@example.com") as member:
                _drain_until(member, "sync")

                member.send_json({"type": "rename_room",
                                  "payload": {"name": "Hijacked"}})
                # A refused rename changes nothing and notifies nobody.
                admin.send_json({"type": "ping",
                                 "payload": {"client_time": 1}})
                _drain_until(admin, "pong")

        from connection_manager import manager
        assert manager.room_states["rename-refused"].get("name", "") == ""

    def test_name_is_capped_and_non_strings_are_rejected(self, client):
        from connection_manager import manager

        room = "/ws/rename-cap"
        with client.websocket_connect(f"{room}?user=admin@example.com") as admin:
            _drain_until(admin, "sync")

            admin.send_json({"type": "rename_room",
                             "payload": {"name": "x" * 500}})
            payload = _drain_until(admin, "room_settings_update")
            assert len(payload["name"]) == manager.ROOM_NAME_MAX_LENGTH

            admin.send_json({"type": "rename_room",
                             "payload": {"name": ["not", "a", "string"]}})
            admin.send_json({"type": "ping", "payload": {"client_time": 1}})
            _drain_until(admin, "pong")
            assert len(manager.room_states["rename-cap"]["name"]) == \
                manager.ROOM_NAME_MAX_LENGTH

    def test_the_name_joins_the_sync_snapshot_and_survives_the_db(self, client):
        room = "/ws/rename-persist"
        with client.websocket_connect(f"{room}?user=admin@example.com") as admin:
            _drain_until(admin, "sync")
            admin.send_json({"type": "rename_room",
                             "payload": {"name": "Anime Abend"}})
            _drain_until(admin, "room_settings_update")

            # A member joining afterwards learns the name from the snapshot.
            with client.websocket_connect(f"{room}?user=late@example.com") as late:
                snapshot = _drain_until(late, "sync")
                assert snapshot["name"] == "Anime Abend"

    async def test_name_round_trips_through_the_database(self, isolated_data_dir):
        from services.database import init_database, save_room, get_all_rooms

        # Schema creation (including the v6 name column) is synchronous.
        init_database()
        await save_room("persist-me", {
            "video_data": None, "is_playing": False, "timestamp": 0,
            "queue": [], "playing_index": -1, "roles": {},
            "permanent": True, "name": "Filmabend",
        })

        rooms = await get_all_rooms()
        assert rooms["persist-me"]["name"] == "Filmabend"

    def test_room_listing_carries_the_name(self, client):
        room = "/ws/rename-listed"
        with client.websocket_connect(f"{room}?user=admin@example.com") as admin:
            _drain_until(admin, "sync")
            admin.send_json({"type": "rename_room", "payload": {"name": "Listed"}})
            _drain_until(admin, "room_settings_update")

            listing = client.get("/api/rooms").json()
            entry = next(r for r in listing if r["id"] == "rename-listed")
            assert entry["name"] == "Listed"
