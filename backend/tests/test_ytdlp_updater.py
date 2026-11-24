"""
Regression tests for the periodic yt-dlp update checker.

yt-dlp previously only updated on container boot, so a long-running container
stayed stuck on a broken version even hours after a hotfix shipped on PyPI.
These tests pin version comparison, ETag caching, error resilience, idle-safe
restart deferral, and the admin status report.
"""
import asyncio

import httpx
import pytest
from fastapi.testclient import TestClient

import main
from core import config
from services.ytdlp_updater import YtdlpUpdater, is_newer, parse_version


class TestVersionComparison:
    def test_parses_calendar_and_patch_versions(self):
        assert parse_version("2026.10.26") == (2026, 10, 26)
        assert parse_version("2026.03.05") == (2026, 3, 5)
        assert parse_version("2026.11.23.1") == (2026, 11, 23, 1)

    @pytest.mark.parametrize("raw", [None, "", "   ", "2026.11.24.dev0", "2026.11.24a1", "unknown"])
    def test_ignores_prereleases_and_malformed_versions(self, raw):
        assert parse_version(raw) is None
        assert is_newer(raw, "2026.10.26") is False

    def test_newer_comparison(self):
        assert is_newer("2026.11.23", "2026.10.26") is True
        assert is_newer("2026.11.23.1", "2026.11.23") is True
        assert is_newer("2026.11.23", "2026.11.23") is False
        assert is_newer("2026.10.26", "2026.11.23") is False


class TestUpdateChecks:
    def test_detects_newer_release_and_sends_etag_on_next_check(self):
        seen_headers = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen_headers.append(dict(request.headers))
            if request.headers.get("if-none-match") == '"v1"':
                return httpx.Response(304)
            return httpx.Response(
                200,
                headers={"ETag": '"v1"'},
                json={"info": {"version": "2026.11.23"}},
            )

        updater = YtdlpUpdater(
            pypi_url="http://pypi.test/yt-dlp/json",
            current_version=lambda: "2026.10.26",
            request_restart=lambda: None,
            transport=httpx.MockTransport(handler),
        )

        async def scenario():
            try:
                assert await updater.check_once() == "2026.11.23"
                assert updater.latest_version == "2026.11.23"
                assert updater.last_error is None
                # Second check reuses the ETag and preserves pending_version on 304.
                assert await updater.check_once() == "2026.11.23"
            finally:
                await updater.aclose()

        asyncio.run(scenario())
        assert "if-none-match" not in seen_headers[0]
        assert seen_headers[1]["if-none-match"] == '"v1"'

    def test_current_release_leaves_no_pending_update(self):
        updater = YtdlpUpdater(
            pypi_url="http://pypi.test/yt-dlp/json",
            current_version=lambda: "2026.11.23",
            request_restart=lambda: None,
            transport=httpx.MockTransport(
                lambda request: httpx.Response(200, json={"info": {"version": "2026.11.23"}})
            ),
        )

        async def scenario():
            try:
                assert await updater.check_once() is None
                assert updater.latest_version == "2026.11.23"
                assert updater.pending_version is None
            finally:
                await updater.aclose()

        asyncio.run(scenario())

    def test_network_and_http_errors_are_non_fatal(self):
        def failing_handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("pypi unreachable")

        updater = YtdlpUpdater(
            pypi_url="http://pypi.test/yt-dlp/json",
            current_version=lambda: "2026.10.26",
            request_restart=lambda: None,
            transport=httpx.MockTransport(failing_handler),
        )

        async def scenario():
            try:
                assert await updater.check_once() is None
                assert updater.last_error is not None
                assert "pypi unreachable" in updater.last_error
            finally:
                await updater.aclose()

        asyncio.run(scenario())


class TestIdleDeferredRestart:
    def test_defers_while_busy_then_restarts_once_when_idle(self):
        restarts = []
        idle = False

        updater = YtdlpUpdater(
            pypi_url="http://pypi.test/yt-dlp/json",
            current_version=lambda: "2026.10.26",
            request_restart=lambda: restarts.append("sigterm"),
            transport=httpx.MockTransport(
                lambda request: httpx.Response(200, json={"info": {"version": "2026.11.23"}})
            ),
        )

        async def scenario():
            nonlocal idle
            try:
                await updater.check_once()
                assert updater.maybe_apply_pending(lambda: idle) is False
                assert restarts == []

                idle = True
                assert updater.maybe_apply_pending(lambda: idle) is True
                assert restarts == ["sigterm"]

                # Never sends a second restart signal once already triggered.
                assert updater.maybe_apply_pending(lambda: idle) is False
                assert restarts == ["sigterm"]
            finally:
                await updater.aclose()

        asyncio.run(scenario())

    def test_run_loop_polls_until_idle_then_restarts(self):
        restarts = []
        poll_count = 0

        def is_idle() -> bool:
            nonlocal poll_count
            poll_count += 1
            return poll_count >= 2

        updater = YtdlpUpdater(
            pypi_url="http://pypi.test/yt-dlp/json",
            current_version=lambda: "2026.10.26",
            request_restart=lambda: restarts.append("sigterm"),
            transport=httpx.MockTransport(
                lambda request: httpx.Response(200, json={"info": {"version": "2026.11.23"}})
            ),
        )

        async def scenario():
            try:
                await asyncio.wait_for(
                    updater.run(is_idle, check_interval=0.01, idle_poll=0.01),
                    timeout=2.0,
                )
            finally:
                await updater.aclose()

        asyncio.run(scenario())
        assert restarts == ["sigterm"]
        assert poll_count == 2

    def test_is_enabled_requires_auto_update_and_managed_container(self, monkeypatch):
        monkeypatch.setattr(config, "YTDLP_AUTO_UPDATE", True)
        monkeypatch.delenv("YTDLP_UPDATE_MANAGED", raising=False)
        assert YtdlpUpdater.is_enabled() is False

        monkeypatch.setenv("YTDLP_UPDATE_MANAGED", "1")
        assert YtdlpUpdater.is_enabled() is True

        monkeypatch.setattr(config, "YTDLP_AUTO_UPDATE", False)
        assert YtdlpUpdater.is_enabled() is False


class TestBackendIdleDetection:
    def test_idle_when_empty_or_only_paused_viewers(self):
        assert main._is_backend_idle() is True

        main.manager.room_states["r1"] = {"is_playing": False}
        main.manager.active_connections["r1"] = [object()]
        assert main._is_backend_idle() is True

        # Playing room with nobody connected does not block restart.
        main.manager.room_states["r2"] = {"is_playing": True}
        assert main._is_backend_idle() is True

    def test_busy_when_room_is_playing_with_viewers(self):
        main.manager.room_states["r1"] = {"is_playing": True}
        main.manager.active_connections["r1"] = [object()]
        assert main._is_backend_idle() is False

    def test_busy_during_live_share_browser_or_queued_resolve(self):
        try:
            main.manager.live_shares["r1"] = {"sharer": "a@example.com"}
            assert main._is_backend_idle() is False
            main.manager.live_shares.clear()

            main.manager.browser_sessions["r1"] = {"controller": "a@example.com"}
            assert main._is_backend_idle() is False
            main.manager.browser_sessions.clear()

            main._queued_resolves.add(("r1", "https://example.com/v"))
            assert main._is_backend_idle() is False
        finally:
            main.manager.live_shares.clear()
            main.manager.browser_sessions.clear()
            main._queued_resolves.clear()


class TestAdminOverviewReportsYtdlp:
    def test_overview_includes_ytdlp_update_status(self, monkeypatch):
        monkeypatch.setattr(config, "ADMIN_EMAILS", frozenset({"boss@example.com"}))
        with TestClient(main.app) as client:
            resp = client.get("/api/admin/overview?user=boss@example.com")
        assert resp.status_code == 200
        yt_dlp_info = resp.json()["yt_dlp"]
        assert yt_dlp_info["version"]
        assert yt_dlp_info["check_interval_seconds"] == config.YTDLP_UPDATE_CHECK_INTERVAL_SECONDS
        assert "auto_update" in yt_dlp_info
        assert "update_pending" in yt_dlp_info
