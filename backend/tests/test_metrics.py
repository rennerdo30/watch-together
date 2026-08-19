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
