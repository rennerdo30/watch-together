"""
Tests for proxy metrics collection and the diagnostic endpoint.
"""
import pytest
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DEVELOPMENT_MODE", "true")

from fastapi.testclient import TestClient

from services.metrics import (
    ProxyMetrics, proxy_metrics,
    OUTCOME_OK, OUTCOME_TRUNCATED, OUTCOME_UPSTREAM_ERROR,
)
from core.config import METRICS_SLOW_UPSTREAM_MS


@pytest.fixture
def metrics():
    return ProxyMetrics(capacity=5)


@pytest.fixture
def client():
    from main import app
    return TestClient(app)


async def _record(metrics, **overrides):
    payload = {
        "host": "rr1.googlevideo.com",
        "status": 206,
        "outcome": OUTCOME_OK,
        "upstream_ms": 120.0,
        "transfer_ms": 400.0,
        "bytes_sent": 1024,
    }
    payload.update(overrides)
    await metrics.record(**payload)


class TestProxyMetrics:
    async def test_records_totals_and_hosts(self, metrics):
        await _record(metrics)
        await _record(metrics, host="other.cdn.net", bytes_sent=2048)

        snapshot = await metrics.snapshot()
        assert snapshot["totals"]["requests"] == 2
        assert snapshot["totals"]["bytes_sent"] == 3072
        assert snapshot["by_host"]["other.cdn.net"]["bytes_sent"] == 2048

    async def test_counts_failures_separately(self, metrics):
        await _record(metrics)
        await _record(metrics, outcome=OUTCOME_TRUNCATED, error="sent 10 of 99 bytes")

        snapshot = await metrics.snapshot()
        assert snapshot["totals"]["failures"] == 1
        assert snapshot["by_outcome"][OUTCOME_TRUNCATED] == 1
        assert snapshot["by_host"]["rr1.googlevideo.com"]["failures"] == 1

    async def test_failures_are_surfaced_with_offsets(self, metrics):
        await _record(
            metrics,
            outcome=OUTCOME_TRUNCATED,
            range_start=10_485_760,
            expected_bytes=3_000_000,
            bytes_sent=1_500_000,
            error="sent 1500000 of 3000000 bytes",
        )

        failure = (await metrics.snapshot())["recent_failures"][0]
        assert failure["range_start"] == 10_485_760
        assert failure["expected_bytes"] == 3_000_000
        assert failure["bytes_sent"] == 1_500_000

    async def test_slow_upstream_is_counted(self, metrics):
        await _record(metrics, upstream_ms=METRICS_SLOW_UPSTREAM_MS + 1)
        await _record(metrics, upstream_ms=10.0)

        assert (await metrics.snapshot())["totals"]["slow_upstream"] == 1

    async def test_ring_buffer_is_bounded(self, metrics):
        for i in range(20):
            await _record(metrics, bytes_sent=i)

        snapshot = await metrics.snapshot()
        assert len(snapshot["recent_samples"]) == 5  # capacity
        assert snapshot["totals"]["requests"] == 20  # totals keep counting

    async def test_reset_clears_everything(self, metrics):
        await _record(metrics)
        await metrics.reset()

        snapshot = await metrics.snapshot()
        assert snapshot["totals"] == {}
        assert snapshot["recent_samples"] == []

    async def test_upstream_error_recorded_without_status(self, metrics):
        await _record(metrics, status=None, outcome=OUTCOME_UPSTREAM_ERROR,
                      bytes_sent=0, error="ConnectTimeout: timed out")

        failure = (await metrics.snapshot())["recent_failures"][0]
        assert failure["status"] is None
        assert failure["outcome"] == OUTCOME_UPSTREAM_ERROR


class TestMetricsEndpoint:
    def test_requires_identity(self, client):
        assert client.get("/api/metrics/proxy").status_code == 401

    def test_returns_snapshot(self, client):
        response = client.get("/api/metrics/proxy?user=ops@example.com")
        assert response.status_code == 200
        body = response.json()
        assert "totals" in body
        assert "by_outcome" in body
        assert "recent_failures" in body

    def test_sample_limit_is_bounded(self, client):
        assert client.get(
            "/api/metrics/proxy?user=ops@example.com&samples=99999"
        ).status_code == 422

    async def test_endpoint_reflects_recorded_transfers(self, client):
        await proxy_metrics.reset()
        await _record(proxy_metrics, outcome=OUTCOME_TRUNCATED, error="boom")

        body = client.get("/api/metrics/proxy?user=ops@example.com").json()
        assert body["totals"]["failures"] == 1
        await proxy_metrics.reset()


class TestMediaResponsesAreNotCacheable:
    """Proxied media must never be stored by an intermediary.

    Segments are fetched with the caller's own cookies, so a shared cache
    would serve one user's authenticated content to another. A cacheable
    response also invites Cloudflare to fetch a whole object from the origin
    to satisfy a small range request.
    """

    def test_proxy_marks_media_uncacheable(self, client, monkeypatch):
        import main as main_module

        # A tiny public object is enough: the assertion is about headers.
        response = client.get(
            "/api/proxy",
            params={"url": "https://www.youtube.com/robots.txt", "user": "cache@example.com"},
        )
        if response.status_code not in (200, 206):
            pytest.skip("upstream not reachable in this environment")

        cache_control = response.headers.get("cache-control", "")
        assert "no-store" in cache_control
        assert "private" in cache_control
        assert "no-transform" in cache_control


class TestRangedResponsesAreWellFormed:
    """A 206 must answer exactly the range that was asked for.

    The cache used to key on the range's start only and returned 206 with
    no Content-Range, so a body cached for one range answered a request for
    another. Players reject that ("payload length does not match range
    requested bytes") and Cloudflare turns it into a 416.

    Served from a local origin rather than a live one: the assertions are
    about exact byte counts, which a real CDN can change by compressing.
    """

    PAYLOAD = bytes(range(256)) * 8  # 2048 deterministic bytes

    @pytest.fixture
    def origin(self):
        """A minimal range-capable HTTP origin."""
        import threading
        from http.server import BaseHTTPRequestHandler, HTTPServer

        payload = self.PAYLOAD

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                rng = self.headers.get("Range")
                if rng and rng.startswith("bytes="):
                    spec = rng.split("=", 1)[1]
                    start_s, _, end_s = spec.partition("-")
                    start = int(start_s)
                    end = int(end_s) if end_s else len(payload) - 1
                    end = min(end, len(payload) - 1)
                    body = payload[start:end + 1]
                    self.send_response(206)
                    self.send_header("Content-Type", "video/mp4")
                    self.send_header("Content-Range", f"bytes {start}-{end}/{len(payload)}")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                self.send_response(200)
                self.send_header("Content-Type", "video/mp4")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        yield f"http://127.0.0.1:{server.server_port}/media.mp4"
        server.shutdown()
        server.server_close()

    @pytest.fixture(autouse=True)
    def allow_local_origin(self, monkeypatch, origin):
        """Let the proxy reach the test origin, which is otherwise private."""
        import services.upstream as upstream
        from urllib.parse import urlparse

        real = upstream._is_public_ip
        monkeypatch.setattr(upstream, "_is_public_ip",
                            lambda ip: ip == "127.0.0.1" or real(ip))
        port = urlparse(origin).port
        monkeypatch.setattr(upstream, "UPSTREAM_ALLOWED_PORTS",
                            upstream.UPSTREAM_ALLOWED_PORTS + (port,))

    def test_range_response_carries_content_range(self, client, origin):
        response = client.get(
            "/api/proxy",
            params={"url": origin, "user": "range@example.com"},
            headers={"Range": "bytes=0-99"},
        )
        assert response.status_code == 206
        assert response.headers["content-range"] == f"bytes 0-99/{len(self.PAYLOAD)}"
        assert response.content == self.PAYLOAD[:100]

    def test_cache_hit_is_identical_to_the_miss(self, client, origin):
        params = {"url": origin, "user": "range@example.com"}
        first = client.get("/api/proxy", params=params, headers={"Range": "bytes=0-49"})
        second = client.get("/api/proxy", params=params, headers={"Range": "bytes=0-49"})

        assert first.status_code == second.status_code == 206
        assert second.content == first.content == self.PAYLOAD[:50]
        assert second.headers["content-range"] == first.headers["content-range"]

    def test_a_wider_cached_range_does_not_answer_a_narrower_one(self, client, origin):
        """The exact defect: one range's body answering another's request."""
        params = {"url": origin, "user": "range@example.com"}
        wide = client.get("/api/proxy", params=params, headers={"Range": "bytes=0-199"})
        narrow = client.get("/api/proxy", params=params, headers={"Range": "bytes=0-9"})

        assert wide.content == self.PAYLOAD[:200]
        assert narrow.content == self.PAYLOAD[:10]
        assert narrow.headers["content-range"] == f"bytes 0-9/{len(self.PAYLOAD)}"

    def test_offset_range_is_served_from_the_right_offset(self, client, origin):
        response = client.get(
            "/api/proxy",
            params={"url": origin, "user": "range@example.com"},
            headers={"Range": "bytes=500-599"},
        )
        assert response.status_code == 206
        assert response.content == self.PAYLOAD[500:600]
        assert response.headers["content-range"] == f"bytes 500-599/{len(self.PAYLOAD)}"
