"""
Per-viewer telemetry: who was served, by which tier, and what their player
made of it.

"One viewer is always on a low rendition, everyone else is fine" was not
answerable from anything this backend recorded. A proxy sample named no
identity, so it described the instance rather than anyone on it; cache hits
returned before recording anything at all, so a viewer served from cache
looked like a viewer who had stopped watching; and the inputs to the
decision — the size the video is drawn at, the pixel ratio, the measured
bandwidth, the frames the decoder dropped — exist only in the browser and
reached nobody.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DEVELOPMENT_MODE", "true")

from fastapi.testclient import TestClient

from connection_manager import ConnectionManager
from services.metrics import (
    ProxyMetrics, proxy_metrics, throughput_mbps,
    OUTCOME_OK, TIER_DISK, TIER_MEMORY, TIER_UPSTREAM,
)


@pytest.fixture
def client():
    from main import app
    return TestClient(app)


class TestThroughput:
    def test_a_streamed_transfer_reports_what_the_client_was_served_at(self):
        # 1 MB in one second is 8 Mbit/s.
        assert throughput_mbps(1_000_000, 1000.0, TIER_UPSTREAM) == 8.0
        assert throughput_mbps(1_000_000, 500.0, TIER_DISK) == 16.0

    def test_a_memory_hit_reports_nothing_rather_than_an_imaginary_link(self):
        """Its elapsed time measures a copy inside this process."""
        assert throughput_mbps(1_000_000, 0.4, TIER_MEMORY) is None

    def test_nothing_measurable_is_not_reported_as_zero(self):
        assert throughput_mbps(0, 100.0, TIER_UPSTREAM) is None
        assert throughput_mbps(1024, 0.0, TIER_UPSTREAM) is None


class TestSamplesCarryWhoAndWhere:
    async def test_the_tier_that_answered_is_counted(self):
        metrics = ProxyMetrics(capacity=10)
        await metrics.record(host="cdn", status=206, outcome=OUTCOME_OK,
                             upstream_ms=100.0, transfer_ms=200.0, bytes_sent=1000,
                             identity="a@example.com")
        await metrics.record(host="cdn", status=206, outcome=OUTCOME_OK,
                             upstream_ms=0.0, transfer_ms=5.0, bytes_sent=2000,
                             identity="a@example.com", cache_tier=TIER_MEMORY)

        snapshot = await metrics.snapshot(include_identity=True)
        assert snapshot["by_cache_tier"][TIER_UPSTREAM]["requests"] == 1
        assert snapshot["by_cache_tier"][TIER_MEMORY]["bytes_sent"] == 2000
        assert [s["identity"] for s in snapshot["recent_samples"]] == ["a@example.com"] * 2

    async def test_the_open_endpoint_never_says_who_fetched_what(self, client):
        """`/api/metrics/proxy` is open to every signed-in viewer."""
        await proxy_metrics.reset()
        await proxy_metrics.record(host="cdn", status=206, outcome=OUTCOME_OK,
                                   upstream_ms=1.0, transfer_ms=2.0, bytes_sent=10,
                                   identity="watched-something-private@example.com")

        body = client.get("/api/metrics/proxy",
                          params={"user": "someone-else@example.com"}).json()

        assert body["recent_samples"], "the sample should still be reported"
        for sample in body["recent_samples"]:
            assert "identity" not in sample
        assert "watched-something-private" not in str(body)

    async def test_the_admin_panel_does_say(self, client, monkeypatch):
        import core.config as config
        import api.routes.admin as admin
        monkeypatch.setattr(config, "ADMIN_EMAILS", {"admin@example.com"})
        monkeypatch.setattr(admin.config, "ADMIN_EMAILS", {"admin@example.com"})
        await proxy_metrics.reset()
        await proxy_metrics.record(host="cdn", status=206, outcome=OUTCOME_OK,
                                   upstream_ms=1.0, transfer_ms=2.0, bytes_sent=10,
                                   identity="slow-viewer@example.com")

        body = client.get("/api/admin/cache", params={"user": "admin@example.com"}).json()

        identities = [s.get("identity") for s in body["proxy"]["recent_samples"]]
        assert "slow-viewer@example.com" in identities


class TestCacheHitsAreRecorded:
    """A hit used to return before any sample was taken."""

    PAYLOAD = bytes(range(256)) * 8

    @pytest.fixture
    def origin(self):
        import threading
        from http.server import BaseHTTPRequestHandler, HTTPServer

        payload = self.PAYLOAD

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                rng = self.headers.get("Range")
                start_s, _, end_s = rng.split("=", 1)[1].partition("-")
                start = int(start_s)
                end = min(int(end_s) if end_s else len(payload) - 1, len(payload) - 1)
                body = payload[start:end + 1]
                self.send_response(206)
                self.send_header("Content-Type", "video/mp4")
                self.send_header("Content-Range", f"bytes {start}-{end}/{len(payload)}")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        yield f"http://127.0.0.1:{server.server_port}/segment.mp4"
        server.shutdown()
        server.server_close()

    @pytest.fixture(autouse=True)
    def allow_local_origin(self, monkeypatch, origin):
        import services.upstream as upstream
        from urllib.parse import urlparse

        real = upstream._is_public_ip
        monkeypatch.setattr(upstream, "_is_public_ip",
                            lambda ip: ip == "127.0.0.1" or real(ip))
        monkeypatch.setattr(upstream, "UPSTREAM_ALLOWED_PORTS",
                            upstream.UPSTREAM_ALLOWED_PORTS + (urlparse(origin).port,))

    async def test_every_tier_that_serves_a_viewer_leaves_a_sample(self, client, origin):
        from services.cache import memory_cache

        params = {"url": origin, "user": "tiers@example.com"}
        headers = {"Range": "bytes=0-99"}

        await proxy_metrics.reset()
        client.get("/api/proxy", params=params, headers=headers)
        client.get("/api/proxy", params=params, headers=headers)   # memory
        await memory_cache.clear()
        client.get("/api/proxy", params=params, headers=headers)   # disk

        snapshot = await proxy_metrics.snapshot(include_identity=True)
        tiers = [s["cache_tier"] for s in snapshot["recent_samples"]]
        assert tiers == [TIER_UPSTREAM, TIER_MEMORY, TIER_DISK]
        assert {s["identity"] for s in snapshot["recent_samples"]} == {"tiers@example.com"}
        assert all(s["bytes_sent"] == 100 for s in snapshot["recent_samples"])


class TestPlaybackQualityReport:
    """What the player says about its own picture, bounded on the way in."""

    class FakeSocket:
        pass

    def test_a_report_is_kept_on_the_connection(self):
        socket = self.FakeSocket()
        kept = ConnectionManager.record_playback_quality(socket, {
            "rung": 360, "cap": 720, "surface_px": 540, "pixel_ratio": 1.5,
            "estimate_bps": 2_500_000, "dropped_frames": 0.21, "ladder_rungs": 8,
            "mode": "balanced", "engine": "mse",
        })

        assert kept["rung"] == 360 and kept["cap"] == 720
        assert kept["dropped_frames"] == 0.21
        assert kept["mode"] == "balanced" and kept["engine"] == "mse"
        assert socket.playback_quality == kept
        assert kept["at"] > 0

    def test_a_browser_cannot_write_whatever_it_likes(self):
        socket = self.FakeSocket()
        kept = ConnectionManager.record_playback_quality(socket, {
            "rung": "<script>", "cap": 10 ** 9, "surface_px": -1,
            "pixel_ratio": float("inf"), "estimate_bps": True,
            "dropped_frames": 42, "ladder_rungs": 10_000,
            "mode": "'; DROP TABLE", "engine": "something",
            "extra": "not a field this understands",
        })

        assert set(kept) == {"rung", "cap", "surface_px", "pixel_ratio", "estimate_bps",
                             "dropped_frames", "ladder_rungs", "mode", "engine", "at"}
        assert all(kept[field] is None for field in
                   ("rung", "cap", "surface_px", "pixel_ratio", "estimate_bps",
                    "dropped_frames", "ladder_rungs", "mode", "engine"))

    def test_nonsense_is_refused_outright(self):
        assert ConnectionManager.record_playback_quality(self.FakeSocket(), "hello") is None
