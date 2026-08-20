"""
Regression tests for deployment-time faults.

These assert properties of the build and packaging that only failed once
the stack ran on a real host, and which no runtime test would notice.
"""
import json
import pathlib
import pytest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
BACKEND = REPO_ROOT / "backend"
EXTENSION = REPO_ROOT / "extension"


class TestBackendImage:
    def test_data_directory_exists_in_the_image(self):
        """A volume mounted on a path the image lacks is created root-owned.

        `data/` is in .dockerignore, so without an explicit mkdir the
        directory does not exist at build time and the non-root process
        cannot write to the mounted volume — it dies creating its cache
        and cookie directories.
        """
        dockerfile = (BACKEND / "Dockerfile").read_text()
        assert "mkdir -p /app/data" in dockerfile

        mkdir_at = dockerfile.index("mkdir -p /app/data")
        chown_at = dockerfile.index("chown -R appuser:appgroup")
        assert mkdir_at < chown_at, "the data directory must be created before ownership is set"

    def test_packages_live_somewhere_the_app_user_can_write(self):
        """yt-dlp is upgraded at boot by the non-root user."""
        dockerfile = (BACKEND / "Dockerfile").read_text()
        assert "VIRTUAL_ENV=/opt/venv" in dockerfile
        assert 'chown -R appuser:appgroup /app "$VIRTUAL_ENV"' in dockerfile

    def test_startup_refreshes_ytdlp_but_tolerates_failure(self):
        """An offline or rate-limited host must still start."""
        start = (BACKEND / "start.sh").read_text()
        assert "YTDLP_AUTO_UPDATE" in start
        assert "yt-dlp/archive/master.tar.gz" in start
        # A failed update is reported, not fatal.
        assert "starting with" in start
        assert start.rstrip().endswith("exec uvicorn main:app --host 0.0.0.0 --port 8000")


class TestExtensionManifest:
    """The extension could not detect a self-hosted instance at all."""

    @pytest.fixture
    def manifest(self):
        return json.loads((EXTENSION / "manifest.json").read_text())

    def test_instance_origins_can_be_requested(self, manifest):
        """A self-hosted instance has its own domain, unknown at packaging."""
        optional = manifest.get("optional_host_permissions", [])
        assert optional, "no optional host permissions, so no instance can be granted"
        assert any(p.startswith("https://") for p in optional)

    def test_no_content_script_is_registered(self, manifest):
        """The token comes from the API now, not from a page meta tag.

        The old content script only ran on the five video sites, never on a
        Watch Together instance, so detection could not happen at all.
        """
        assert "content_scripts" not in manifest
        assert not (EXTENSION / "content.js").exists()

    def test_cookie_and_storage_permissions_are_present(self, manifest):
        for permission in ("cookies", "storage", "alarms"):
            assert permission in manifest["permissions"]

    def test_background_completes_connection_without_the_popup(self):
        """Chrome destroys the popup when the permission prompt opens.

        The work after chrome.permissions.request() therefore has to live in
        the service worker, or the permission is granted and nothing else
        happens.
        """
        background = (EXTENSION / "background.js").read_text()
        assert "chrome.permissions.onAdded.addListener" in background
        assert "fetchInstanceToken" in background

    def test_token_is_fetched_from_the_api(self):
        background = (EXTENSION / "background.js").read_text()
        assert "/api/me" in background
        assert "/api/token" in background
        # The meta-tag handshake is gone.
        assert "wt-ext-token" not in background
        assert "TOKEN_DETECTED" not in background


class TestConnectionsAreReused:
    """Adaptive playback is thousands of small range requests.

    The proxy and nginx both used to force the connection closed after every
    response, as a workaround for HTTP/2 stream errors. Those errors came
    from partial responses sent without a Content-Range, which is fixed at
    the source, and closing per response costs a fresh connection setup for
    every segment — expensive on any link and punitive across continents.
    """

    def test_proxy_does_not_force_the_connection_closed(self):
        source = (BACKEND / "main.py").read_text()
        assert '"Connection": "close"' not in source

    def test_nginx_keeps_the_backend_connection_alive(self):
        conf = (REPO_ROOT / "nginx" / "nginx.conf").read_text()
        # The websocket locations legitimately set Upgrade; only the media
        # proxy must not force a close.
        proxy_block = conf.split("location /api/proxy")[1].split("location ")[0]
        assert 'Connection "close"' not in proxy_block
        assert 'proxy_set_header Connection ""' in proxy_block


class TestPlayerToleratesHighLatency:
    """The server and the viewer can be on opposite sides of the world."""

    PLAYER_CONSTANTS = REPO_ROOT / "frontend" / "lib" / "constants.ts"

    def test_startup_bandwidth_guess_is_conservative(self):
        """An optimistic guess opens on the top rendition and stalls."""
        text = self.PLAYER_CONSTANTS.read_text()
        assert "SHAKA_INITIAL_BANDWIDTH_ESTIMATE" in text

    def test_rebuffer_goal_leaves_a_real_cushion(self):
        """A small cushion is spent before the next segment lands."""
        import re

        text = self.PLAYER_CONSTANTS.read_text()
        match = re.search(r"SHAKA_REBUFFER_GOAL_SECONDS = (\d+)", text)
        assert match, "the rebuffering goal is no longer defined"
        assert int(match.group(1)) >= 8

    def test_segment_requests_are_retried(self):
        text = self.PLAYER_CONSTANTS.read_text()
        assert "SHAKA_SEGMENT_RETRIES" in text
        assert "SHAKA_REQUEST_TIMEOUT_MS" in text
