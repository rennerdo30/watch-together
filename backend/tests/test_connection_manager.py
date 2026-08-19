"""
Concurrency and lifecycle tests for the ConnectionManager: connection
limits under concurrent bursts, stale-room and lock cleanup, and the
sync payload contract that the heartbeat relies on.
"""
import asyncio
import time
import pytest
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from connection_manager import ConnectionManager


class FakeWebSocket:
    """Minimal stand-in for a Starlette WebSocket."""

    def __init__(self):
        self.accepted = False
        self.closed = False
        self.close_code = None
        self.sent = []

    async def accept(self):
        self.accepted = True

    async def close(self, code=1000, reason=""):
        self.closed = True
        self.close_code = code

    async def send_json(self, message):
        self.sent.append(message)


@pytest.fixture
def manager():
    return ConnectionManager()


class TestConnectionLimits:
    @pytest.mark.asyncio
    async def test_room_limit_holds_under_concurrent_burst(self, manager):
        """60 concurrent connects against a limit of 50 must yield exactly
        50 accepted connections — the TOCTOU regression test."""
        room_id = "burst-room"
        sockets = [FakeWebSocket() for _ in range(60)]

        results = await asyncio.gather(*[
            manager.connect(ws, room_id, f"user{i}@example.com",
                            max_per_room=50, max_per_user=10)
            for i, ws in enumerate(sockets)
        ])

        assert sum(1 for r in results if r) == 50
        assert len(manager.active_connections[room_id]) == 50
        rejected = [ws for ws, ok in zip(sockets, results) if not ok]
        assert all(ws.close_code == 4001 for ws in rejected)

    @pytest.mark.asyncio
    async def test_user_limit_holds_under_concurrent_burst(self, manager):
        """12 concurrent connects by one user against a limit of 10 must
        yield exactly 10 accepted connections."""
        room_id = "user-limit-room"
        sockets = [FakeWebSocket() for _ in range(12)]

        results = await asyncio.gather(*[
            manager.connect(ws, room_id, "same@example.com",
                            max_per_room=50, max_per_user=10)
            for ws in sockets
        ])

        assert sum(1 for r in results if r) == 10
        rejected = [ws for ws, ok in zip(sockets, results) if not ok]
        assert all(ws.close_code == 4002 for ws in rejected)

    @pytest.mark.asyncio
    async def test_user_limit_counts_across_rooms(self, manager):
        """The per-user limit applies across all rooms combined."""
        for i in range(3):
            ok = await manager.connect(FakeWebSocket(), f"room-{i}",
                                       "multi@example.com",
                                       max_per_room=50, max_per_user=3)
            assert ok
        ok = await manager.connect(FakeWebSocket(), "room-extra",
                                   "multi@example.com",
                                   max_per_room=50, max_per_user=3)
        assert not ok


class TestRoomLifecycle:
    @pytest.mark.asyncio
    async def test_stale_room_cleanup_removes_state_and_lock(self, manager):
        room_id = "ephemeral-room"
        ws = FakeWebSocket()
        assert await manager.connect(ws, room_id, "a@example.com")
        assert room_id in manager._room_locks

        await manager.disconnect(ws, room_id)
        assert manager.room_states[room_id].get("empty_since") is not None

        # Force immediate expiry
        manager.room_states[room_id]["empty_since"] = time.time() - 10
        await manager.cleanup_stale_rooms(ttl_seconds=1)

        assert room_id not in manager.room_states
        assert room_id not in manager._room_locks

    @pytest.mark.asyncio
    async def test_permanent_room_survives_cleanup(self, manager):
        room_id = "permanent-room"
        ws = FakeWebSocket()
        assert await manager.connect(ws, room_id, "a@example.com")
        manager.room_states[room_id]["permanent"] = True

        await manager.disconnect(ws, room_id)
        manager.room_states[room_id]["empty_since"] = time.time() - 10
        await manager.cleanup_stale_rooms(ttl_seconds=1)

        assert room_id in manager.room_states

    @pytest.mark.asyncio
    async def test_orphan_locks_are_swept(self, manager):
        manager._room_locks["ghost-room"] = asyncio.Lock()
        await manager.cleanup_stale_rooms(ttl_seconds=300)
        assert "ghost-room" not in manager._room_locks

    @pytest.mark.asyncio
    async def test_reconnect_clears_empty_since(self, manager):
        room_id = "rejoin-room"
        ws1 = FakeWebSocket()
        assert await manager.connect(ws1, room_id, "a@example.com")
        await manager.disconnect(ws1, room_id)
        assert "empty_since" in manager.room_states[room_id]

        ws2 = FakeWebSocket()
        assert await manager.connect(ws2, room_id, "a@example.com")
        assert "empty_since" not in manager.room_states[room_id]


class TestSyncPayload:
    @pytest.mark.asyncio
    async def test_playing_timestamp_advances_with_wall_clock(self, manager):
        room_id = "sync-room"
        assert await manager.connect(FakeWebSocket(), room_id, "a@example.com")
        manager.room_states[room_id].update({
            "video_data": {"title": "t", "is_live": False},
            "is_playing": True,
            "timestamp": 100.0,
            "last_sync_time": time.time() - 10.0,
        })

        payload = manager.get_sync_payload(room_id)
        assert 109.0 < payload["timestamp"] < 112.0

    @pytest.mark.asyncio
    async def test_paused_timestamp_does_not_advance(self, manager):
        room_id = "paused-room"
        assert await manager.connect(FakeWebSocket(), room_id, "a@example.com")
        manager.room_states[room_id].update({
            "video_data": {"title": "t", "is_live": False},
            "is_playing": False,
            "timestamp": 100.0,
            "last_sync_time": time.time() - 10.0,
        })

        payload = manager.get_sync_payload(room_id)
        assert payload["timestamp"] == 100.0

    @pytest.mark.asyncio
    async def test_live_stream_timestamp_not_adjusted(self, manager):
        room_id = "live-room"
        assert await manager.connect(FakeWebSocket(), room_id, "a@example.com")
        manager.room_states[room_id].update({
            "video_data": {"title": "t", "is_live": True},
            "is_playing": True,
            "timestamp": 100.0,
            "last_sync_time": time.time() - 10.0,
        })

        payload = manager.get_sync_payload(room_id)
        assert payload["timestamp"] == 100.0

    @pytest.mark.asyncio
    async def test_internal_fields_not_leaked(self, manager):
        room_id = "leak-room"
        assert await manager.connect(FakeWebSocket(), room_id, "a@example.com")
        payload = manager.get_sync_payload(room_id)
        assert "last_sync_time" not in payload

    def test_unknown_room_returns_empty(self, manager):
        assert manager.get_sync_payload("no-such-room") == {}
