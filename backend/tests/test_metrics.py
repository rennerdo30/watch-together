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

import pathlib
BACKEND_MAIN = pathlib.Path(__file__).resolve().parent.parent / "main.py"


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


class TestAbortClassification:
    """A cancellation after full delivery is not an abort.

    Streamed responses have their generator cancelled when the client closes
    the connection, which happens routinely once the last byte is delivered.
    Counting those as aborts filled the log with warnings and buried the
    errors worth reading.
    """

    async def test_full_delivery_then_cancel_is_not_a_failure(self, metrics):
        await metrics.record(
            host="cdn.example.com", status=206, outcome=OUTCOME_OK,
            upstream_ms=10.0, transfer_ms=20.0,
            bytes_sent=1000, expected_bytes=1000,
        )
        snapshot = await metrics.snapshot()
        assert snapshot["totals"].get("failures", 0) == 0

    async def test_short_delivery_is_still_reported(self, metrics):
        from services.metrics import OUTCOME_CLIENT_ABORTED

        await metrics.record(
            host="cdn.example.com", status=206, outcome=OUTCOME_CLIENT_ABORTED,
            upstream_ms=10.0, transfer_ms=20.0,
            bytes_sent=400, expected_bytes=1000,
        )
        snapshot = await metrics.snapshot()
        assert snapshot["totals"]["failures"] == 1
        assert snapshot["recent_failures"][0]["bytes_sent"] == 400

    def test_source_only_aborts_on_short_bodies(self):
        """Guard the condition itself: it is easy to drop in a refactor."""
        source = (BACKEND_MAIN).read_text()
        assert source.count("if not expected_bytes or total < expected_bytes:") == 2


class TestDiskCacheServesSegmentsWithoutRefetching:
    """Every MSE request is a ranged one, and ranged requests used to skip
    the persistent cache entirely.

    The disk cache was keyed on a 10MB position bucket, so it could never
    describe an exact range and was bypassed for anything with a Range
    header — which is all adaptive playback. Each re-watch, each backwards
    seek and each additional viewer in the room paid a full trip to the CDN
    again. These tests pin the replacement: an exact-range key whose hit is
    byte-identical to the miss, states its own Content-Range and Content-
    Length, and does not touch the origin.
    """

    PAYLOAD = bytes(range(256)) * 8

    @pytest.fixture
    def counting_origin(self):
        """A range-capable origin that counts the requests it receives."""
        import threading
        from http.server import BaseHTTPRequestHandler, HTTPServer

        payload = self.PAYLOAD
        hits = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                hits.append(self.headers.get("Range") or "full")
                rng = self.headers.get("Range")
                if rng and rng.startswith("bytes="):
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
        yield f"http://127.0.0.1:{server.server_port}/segment.mp4", hits
        server.shutdown()
        server.server_close()

    @pytest.fixture(autouse=True)
    def allow_local_origin(self, monkeypatch, counting_origin):
        import services.upstream as upstream
        from urllib.parse import urlparse

        url, _ = counting_origin
        real = upstream._is_public_ip
        monkeypatch.setattr(upstream, "_is_public_ip",
                            lambda ip: ip == "127.0.0.1" or real(ip))
        monkeypatch.setattr(upstream, "UPSTREAM_ALLOWED_PORTS",
                            upstream.UPSTREAM_ALLOWED_PORTS + (urlparse(url).port,))

    @pytest.fixture
    def cookie_owners(self, counting_origin):
        """Give two viewers their own cookies for the test origin."""
        import time as _time
        from urllib.parse import urlparse
        from core.security import get_user_cookie_path
        from services.user_cookies import clear_cache

        url, _ = counting_origin
        host = urlparse(url).hostname
        written = []
        expiry = int(_time.time()) + 3600
        for email, value in (("alice@example.com", "alice"), ("bob@example.com", "bob")):
            path = get_user_cookie_path(email)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as handle:
                handle.write("# Netscape HTTP Cookie File\n")
                handle.write("\t".join([
                    host, "FALSE", "/", "FALSE", str(expiry), "SID", value,
                ]) + "\n")
            written.append(path)
        clear_cache()
        yield
        for path in written:
            if os.path.exists(path):
                os.remove(path)
        clear_cache()

    async def _drop_memory_cache(self):
        """Force the next read to come off disk rather than out of memory."""
        from services.cache import memory_cache
        await memory_cache.clear()

    async def test_ranged_request_is_written_to_disk(self, client, counting_origin):
        url, hits = counting_origin
        from services.cache import get_segment_disk_key

        client.get("/api/proxy", params={"url": url, "user": "disk@example.com"},
                   headers={"Range": "bytes=0-99"})

        # No cookies were sent, so the entry is shared rather than
        # per-identity — see the isolation test below for the other case.
        _, path = get_segment_disk_key(url, 0, 99)
        assert os.path.exists(path), "a ranged segment was not persisted"
        assert os.path.exists(path + ".meta")

    async def test_disk_hit_is_byte_identical_and_skips_the_origin(
            self, client, counting_origin):
        url, hits = counting_origin
        params = {"url": url, "user": "disk@example.com"}

        first = client.get("/api/proxy", params=params, headers={"Range": "bytes=0-99"})
        assert len(hits) == 1

        await self._drop_memory_cache()

        second = client.get("/api/proxy", params=params, headers={"Range": "bytes=0-99"})

        assert second.status_code == first.status_code == 206
        assert second.content == first.content == self.PAYLOAD[:100]
        assert second.headers["content-range"] == first.headers["content-range"]
        assert second.headers["content-length"] == str(len(self.PAYLOAD[:100]))
        assert len(hits) == 1, f"the origin was asked again: {hits}"

    async def test_a_different_range_is_not_answered_from_disk(
            self, client, counting_origin):
        url, hits = counting_origin
        params = {"url": url, "user": "disk@example.com"}

        client.get("/api/proxy", params=params, headers={"Range": "bytes=0-199"})
        await self._drop_memory_cache()
        narrow = client.get("/api/proxy", params=params, headers={"Range": "bytes=0-9"})

        assert narrow.content == self.PAYLOAD[:10]
        assert narrow.headers["content-range"] == f"bytes 0-9/{len(self.PAYLOAD)}"
        assert len(hits) == 2, "a cached wider range must not answer a narrower request"

    async def test_one_viewers_cached_segment_is_not_reused_for_another(
            self, client, counting_origin, cookie_owners):
        """A body fetched with one viewer's cookies is theirs alone.

        Anonymous fetches are shared on purpose; a fetch carrying cookies
        is not, or the cache hands one account's authenticated content to
        another.
        """
        url, hits = counting_origin

        client.get("/api/proxy", params={"url": url, "user": "alice@example.com"},
                   headers={"Range": "bytes=0-99"})
        await self._drop_memory_cache()
        client.get("/api/proxy", params={"url": url, "user": "bob@example.com"},
                   headers={"Range": "bytes=0-99"})

        assert len(hits) == 2


class TestCacheSurvivesUrlRotation:
    """Signed CDN URLs rotate; the bytes behind them do not.

    Every resolve returns fresh `expire`/`sig`/`ei` parameters and often a
    different edge host for the same rendition. Keyed on the raw URL, the
    whole cache was orphaned each time a room refreshed its stream URLs —
    which is every few minutes — so a re-watch or a second viewer never got
    a hit however long entries were kept. Both tiers now key on the
    rendition's stable identity: itag + clen + lmt + mime.
    """

    RENDITION = ("?expire=111&ei=X&ip=1.2.3.4&sig=AAA"
                 "&itag=137&clen=999&lmt=555&mime=video%2Fmp4")
    ROTATED = ("?expire=999&ei=Y&ip=5.6.7.8&sig=BBB"
               "&itag=137&clen=999&lmt=555&mime=video%2Fmp4")

    def url(self, host: str, query: str) -> str:
        return f"https://{host}/videoplayback{query}"

    def test_memory_key_ignores_the_signing_parameters(self):
        from services.cache import get_segment_cache_key

        original = get_segment_cache_key(
            self.url("rr3---sn-abc.googlevideo.com", self.RENDITION), 0, 99)
        rotated = get_segment_cache_key(
            self.url("rr9---sn-zzz.googlevideo.com", self.ROTATED), 0, 99)
        assert original == rotated

    def test_disk_key_ignores_the_signing_parameters(self):
        from services.cache import get_segment_disk_key

        original, _ = get_segment_disk_key(
            self.url("rr3---sn-abc.googlevideo.com", self.RENDITION), 0, 99)
        rotated, _ = get_segment_disk_key(
            self.url("rr9---sn-zzz.googlevideo.com", self.ROTATED), 0, 99)
        assert original == rotated

    def test_a_different_rendition_still_gets_its_own_entry(self):
        """Sharing a key across renditions is the failure this must not cause."""
        from services.cache import get_segment_cache_key

        video = get_segment_cache_key(
            self.url("cdn", self.RENDITION), 0, 99)
        audio = get_segment_cache_key(
            self.url("cdn", "?itag=140&clen=86240992&lmt=777&mime=audio%2Fmp4"), 0, 99)
        other_quality = get_segment_cache_key(
            self.url("cdn", self.RENDITION.replace("itag=137", "itag=136")
                     .replace("clen=999", "clen=555")), 0, 99)
        assert len({video, audio, other_quality}) == 3

    def test_the_range_still_separates_entries(self):
        from services.cache import get_segment_disk_key

        url = self.url("cdn", self.RENDITION)
        narrow, _ = get_segment_disk_key(url, 0, 9)
        wide, _ = get_segment_disk_key(url, 0, 999)
        assert narrow != wide

    def test_a_url_without_identity_params_keys_on_itself(self):
        """A non-YouTube source has nothing stable to key on."""
        from services.cache import stream_identity

        plain = "https://cdn.example.com/media/video.mp4"
        assert stream_identity(plain) == plain


class TestCacheBudgetDoesNotSilentlyDisableCaching:
    """Reaching the budget stops all caching until the janitor runs.

    That is the intended backstop, but the budget was 200 MB — smaller
    than a single viewing session — so caching switched itself off partway
    through and every later segment went to the CDN. Measured in
    production: 3392 transfers, 194 cache hits.

    And the budget is consulted on *every* proxied request, which meant
    stat-ing every file in the cache directory thousands of times a
    session.
    """

    def test_budget_is_large_enough_for_a_session(self):
        from core.config import MAX_CACHE_SIZE_BYTES

        one_gigabyte = 1024 ** 3
        assert MAX_CACHE_SIZE_BYTES >= one_gigabyte, (
            "a budget below a gigabyte is reached mid-session, after which "
            "nothing is cached at all"
        )

    def test_budget_is_configurable_per_host(self):
        """Hosts differ; the ceiling must not need a code change."""
        import importlib
        import os

        import core.config as config

        os.environ["MAX_CACHE_SIZE_GB"] = "7"
        try:
            reloaded = importlib.reload(config)
            assert reloaded.MAX_CACHE_SIZE_BYTES == 7 * 1024 ** 3
        finally:
            del os.environ["MAX_CACHE_SIZE_GB"]
            importlib.reload(config)

    def test_size_is_not_re_measured_on_every_call(self, tmp_path, monkeypatch):
        import services.cache as cache_module

        monkeypatch.setattr(cache_module, "CACHE_DIR", str(tmp_path))
        (tmp_path / "seg_abc_0-99").write_bytes(b"x" * 100)
        monkeypatch.setattr(cache_module, "_cache_size_measurement", (0, 0.0))

        scans = []
        real_measure = cache_module.measure_cache_size

        def counted():
            scans.append(1)
            return real_measure()

        monkeypatch.setattr(cache_module, "measure_cache_size", counted)

        first = cache_module.get_current_cache_size()
        for _ in range(20):
            cache_module.get_current_cache_size()

        assert first == 100
        assert len(scans) == 1, f"the cache directory was scanned {len(scans)} times"

    def test_a_forced_measurement_always_scans(self, tmp_path, monkeypatch):
        import services.cache as cache_module

        monkeypatch.setattr(cache_module, "CACHE_DIR", str(tmp_path))
        monkeypatch.setattr(cache_module, "_cache_size_measurement", (0, 0.0))

        (tmp_path / "seg_abc_0-99").write_bytes(b"x" * 100)
        assert cache_module.get_current_cache_size(0) == 100
        (tmp_path / "seg_def_0-99").write_bytes(b"y" * 50)
        assert cache_module.get_current_cache_size(0) == 150

    def test_metadata_and_partial_files_do_not_count(self, tmp_path, monkeypatch):
        import services.cache as cache_module

        monkeypatch.setattr(cache_module, "CACHE_DIR", str(tmp_path))
        (tmp_path / "seg_abc_0-99").write_bytes(b"x" * 100)
        (tmp_path / "seg_abc_0-99.meta").write_text('{"size": 100}')
        (tmp_path / "seg_abc_0-99.123.tmp").write_bytes(b"z" * 999)

        assert cache_module.measure_cache_size() == 100


class TestStaleCacheEntriesAreRemoved:
    """What the janitor must clear, and what it must never half-clear.

    A body and its `.meta` sidecar are one entry: the read path needs both,
    so expiring or evicting one half leaves something that can never be
    served but still counts against the budget. Partial downloads left by a
    crash are dead weight for the same reason.
    """

    @pytest.fixture
    def cache_dir(self, tmp_path, monkeypatch):
        import services.cache as cache_module

        monkeypatch.setattr(cache_module, "CACHE_DIR", str(tmp_path))
        monkeypatch.setattr(cache_module, "_cache_size_measurement", (0, 0.0))
        return tmp_path

    def write_entry(self, cache_dir, name, size=100, age_seconds=0, with_meta=True):
        import os
        import time as _time

        body = cache_dir / name
        body.write_bytes(b"x" * size)
        if with_meta:
            (cache_dir / f"{name}.meta").write_text('{"size": %d}' % size)
        if age_seconds:
            when = _time.time() - age_seconds
            os.utime(body, (when, when))
            if with_meta:
                os.utime(cache_dir / f"{name}.meta", (when, when))
        return body

    async def test_expired_entries_and_their_metadata_go_together(
            self, cache_dir, monkeypatch):
        import services.cache as cache_module
        from core.config import CACHE_TTL_SECONDS

        monkeypatch.setattr(cache_module, "is_content_active", lambda h: False)
        fresh = self.write_entry(cache_dir, "seg_aaa_0-99", age_seconds=0)
        stale = self.write_entry(cache_dir, "seg_bbb_0-99",
                                 age_seconds=CACHE_TTL_SECONDS + 60)

        await self.run_one_pass(monkeypatch, cache_module)

        assert fresh.exists()
        assert (cache_dir / "seg_aaa_0-99.meta").exists()
        assert not stale.exists()
        assert not (cache_dir / "seg_bbb_0-99.meta").exists(), (
            "metadata outlived its body, leaving an unusable entry")

    async def test_orphaned_metadata_is_removed(self, cache_dir, monkeypatch):
        import services.cache as cache_module

        monkeypatch.setattr(cache_module, "is_content_active", lambda h: False)
        (cache_dir / "seg_ccc_0-99.meta").write_text('{"size": 100}')

        await self.run_one_pass(monkeypatch, cache_module)

        assert not (cache_dir / "seg_ccc_0-99.meta").exists()

    async def test_body_without_metadata_is_removed(self, cache_dir, monkeypatch):
        """It cannot state its own range, so it can never answer a request."""
        import services.cache as cache_module

        monkeypatch.setattr(cache_module, "is_content_active", lambda h: False)
        body = self.write_entry(cache_dir, "seg_ddd_0-99", with_meta=False)

        await self.run_one_pass(monkeypatch, cache_module)

        assert not body.exists()

    async def test_abandoned_partial_downloads_are_removed(
            self, cache_dir, monkeypatch):
        import os
        import time as _time
        import services.cache as cache_module
        from core.config import STALE_TEMP_FILE_SECONDS

        monkeypatch.setattr(cache_module, "is_content_active", lambda h: False)
        recent = cache_dir / "seg_eee_0-99.1.tmp"
        recent.write_bytes(b"z" * 10)
        old = cache_dir / "seg_fff_0-99.2.tmp"
        old.write_bytes(b"z" * 10)
        when = _time.time() - (STALE_TEMP_FILE_SECONDS + 60)
        os.utime(old, (when, when))

        await self.run_one_pass(monkeypatch, cache_module)

        assert recent.exists(), "a download still in progress must not be deleted"
        assert not old.exists()

    async def test_oversized_cache_is_evicted_oldest_first(
            self, cache_dir, monkeypatch):
        import services.cache as cache_module

        monkeypatch.setattr(cache_module, "is_content_active", lambda h: False)
        monkeypatch.setattr(cache_module, "MAX_CACHE_SIZE_BYTES", 250)
        oldest = self.write_entry(cache_dir, "seg_111_0-99", size=100, age_seconds=300)
        middle = self.write_entry(cache_dir, "seg_222_0-99", size=100, age_seconds=200)
        newest = self.write_entry(cache_dir, "seg_333_0-99", size=100, age_seconds=100)

        await self.run_one_pass(monkeypatch, cache_module)

        assert not oldest.exists()
        assert not (cache_dir / "seg_111_0-99.meta").exists()
        assert middle.exists()
        assert newest.exists()

    async def test_the_published_size_matches_a_fresh_measurement(
            self, cache_dir, monkeypatch):
        """The proxy reads the published figure; a wrong one stops caching."""
        import services.cache as cache_module

        monkeypatch.setattr(cache_module, "is_content_active", lambda h: False)
        self.write_entry(cache_dir, "seg_444_0-99", size=100)
        self.write_entry(cache_dir, "seg_555_0-99", size=50)

        await self.run_one_pass(monkeypatch, cache_module)

        assert cache_module.get_current_cache_size() == \
            cache_module.measure_cache_size()

    async def run_one_pass(self, monkeypatch, cache_module):
        """Run the janitor's body once, without waiting out its interval."""
        import asyncio

        calls = {"n": 0}
        real_sleep = asyncio.sleep

        async def sleep_once(_seconds):
            calls["n"] += 1
            if calls["n"] > 1:
                raise asyncio.CancelledError
            await real_sleep(0)

        monkeypatch.setattr(cache_module.asyncio, "sleep", sleep_once)
        try:
            await cache_module.cache_cleanup_task()
        except asyncio.CancelledError:
            pass
