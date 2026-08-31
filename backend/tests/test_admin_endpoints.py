"""
Admin panel API tests.

Access control first — the panel is disabled by default and refuses
everyone who is not explicitly listed — then the substance: the overview
reports live rooms, the cache inspection covers every tier, and the
destructive maintenance actions actually clear what they claim to.
"""
import asyncio
import os
import time

import pytest
from fastapi.testclient import TestClient

from main import app
from core import config

ADMIN = "boss@example.com"
NON_ADMIN = "viewer@example.com"


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def admin_configured(monkeypatch):
    monkeypatch.setattr(config, "ADMIN_EMAILS", frozenset({ADMIN}))


class TestAdminAccessControl:
    def test_anonymous_requests_are_refused(self, client, admin_configured):
        assert client.get("/api/admin/overview").status_code == 401

    def test_non_admins_are_refused_everywhere(self, client, admin_configured):
        paths = [
            ("GET", "/api/admin/overview"),
            ("GET", "/api/admin/cache"),
            ("DELETE", "/api/admin/cache/segments"),
            ("DELETE", "/api/admin/cache/formats"),
            ("DELETE", "/api/admin/cache/memory"),
            ("DELETE", "/api/admin/rooms/some-room"),
        ]
        for method, path in paths:
            response = client.request(method, f"{path}?user={NON_ADMIN}")
            assert response.status_code == 403, f"{method} {path} let a non-admin in"

    def test_an_empty_admin_list_disables_the_panel(self, client, monkeypatch):
        """The safe default: nobody is an admin until a deployment says so."""
        monkeypatch.setattr(config, "ADMIN_EMAILS", frozenset())
        response = client.get(f"/api/admin/overview?user={ADMIN}")
        assert response.status_code == 403

    def test_admin_matching_is_case_insensitive(self, client, admin_configured):
        response = client.get("/api/admin/overview?user=Boss@Example.com")
        assert response.status_code == 200


class TestAdminOverview:
    def test_overview_reports_rooms_and_members(self, client, admin_configured):
        with client.websocket_connect(f"/ws/admin-seen?user={NON_ADMIN}") as ws:
            ws.receive_json()  # sync snapshot
            data = client.get(f"/api/admin/overview?user={ADMIN}").json()

        assert data["requested_by"] == ADMIN
        assert data["uptime_seconds"] >= 0
        room = next(r for r in data["rooms"] if r["id"] == "admin-seen")
        assert room["active_users"] == 1
        assert NON_ADMIN in room["members"]
        assert data["totals"]["viewers"] >= 1


class TestAdminCacheInspection:
    def test_every_cache_tier_is_reported(self, client, admin_configured, isolated_data_dir):
        from services.database import cache_format
        import services.cache as cache_module

        url = "https://example.com/watch?v=admin-inspect"
        asyncio.run(cache_format(url, {
            "is_live": True,
            "title": "Inspected Stream",
            "stream_type": "hls",
            "stream_url": "https://cdn.example/live.m3u8",
        }))
        segment_path = os.path.join(cache_module.CACHE_DIR, "adminseg_0")
        with open(segment_path, "wb") as f:
            f.write(b"x" * 1024)

        data = client.get(f"/api/admin/cache?user={ADMIN}").json()

        segments = data["segments"]
        assert segments["entries_total"] >= 1
        assert segments["budget_bytes"] > 0
        assert any(e["name"] == "adminseg_0" for e in segments["entries"])

        memory = data["memory"]
        for key in ("items", "size_mb", "max_mb", "hit_rate_percent"):
            assert key in memory

        entry = next(f for f in data["formats"] if f["original_url"] == url)
        assert entry["is_live"] is True
        assert entry["title"] == "Inspected Stream"
        assert entry["age_seconds"] is not None
        assert entry["expires_in_seconds"] is not None

        assert "by_outcome" in data["proxy"]

        os.remove(segment_path)


class TestAdminMaintenance:
    def test_clearing_the_format_cache_actually_clears_it(
        self, client, admin_configured, isolated_data_dir,
    ):
        from services.database import cache_format, get_cached_format

        url = "https://example.com/watch?v=admin-clear-me"
        asyncio.run(cache_format(url, {"stream_url": "https://cdn.example/v.mp4"}))

        response = client.delete(f"/api/admin/cache/formats?user={ADMIN}")
        assert response.status_code == 200
        assert response.json()["removed"] >= 1
        assert asyncio.run(get_cached_format(url)) is None

    def test_clearing_the_segment_cache_removes_the_files(
        self, client, admin_configured, isolated_data_dir,
    ):
        import services.cache as cache_module

        path = os.path.join(cache_module.CACHE_DIR, "adminseg_clear")
        with open(path, "wb") as f:
            f.write(b"y" * 2048)

        response = client.delete(f"/api/admin/cache/segments?user={ADMIN}")
        assert response.status_code == 200
        assert response.json()["removed"] >= 1
        assert not os.path.exists(path)

    def test_clearing_the_memory_cache(self, client, admin_configured):
        from services.cache import memory_cache

        asyncio.run(memory_cache.put("admin-mem-key", b"z" * 512, "video/mp4"))
        response = client.delete(f"/api/admin/cache/memory?user={ADMIN}")
        assert response.status_code == 200
        assert memory_cache.get_stats()["items"] == 0

    def test_closing_a_room_removes_it(self, client, admin_configured):
        room_id = "admin-close-me"
        with client.websocket_connect(f"/ws/{room_id}?user={NON_ADMIN}") as ws:
            ws.receive_json()  # sync snapshot
        # The member left; the room state lingers for reconnects — until an
        # admin closes it for good.
        response = client.delete(f"/api/admin/rooms/{room_id}?user={ADMIN}")
        assert response.status_code == 200
        assert response.json() == {"closed": room_id}

        listing = client.get("/api/rooms").json()
        assert all(r["id"] != room_id for r in listing)

        # Closing it again reports that there is nothing to close.
        assert client.delete(f"/api/admin/rooms/{room_id}?user={ADMIN}").status_code == 404

    def test_members_are_told_before_the_room_closes(self, client, admin_configured):
        """Silently closing the socket resurrects the room.

        A client that only sees its socket die treats it as a network
        drop and reconnects three seconds later — recreating the room the
        admin just closed. The close must therefore be announced in-band
        before the sockets go away.
        """
        from starlette.websockets import WebSocketDisconnect

        room_id = "admin-close-live"
        with client.websocket_connect(f"/ws/{room_id}?user={NON_ADMIN}") as ws:
            ws.receive_json()  # sync snapshot

            response = client.delete(f"/api/admin/rooms/{room_id}?user={ADMIN}")
            assert response.status_code == 200

            for _ in range(10):
                try:
                    message = ws.receive_json()
                except WebSocketDisconnect:
                    raise AssertionError(
                        "the socket closed without a room_closed notice — the "
                        "client cannot tell an admin close from a network drop"
                    )
                if message.get("type") == "room_closed":
                    break
            else:
                raise AssertionError("no room_closed notice arrived")

        listing = client.get("/api/rooms").json()
        assert all(r["id"] != room_id for r in listing)
