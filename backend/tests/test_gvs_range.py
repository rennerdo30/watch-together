"""
Tests for moving a byte range into googlevideo's `range` query parameter.

Measured on one 720p rendition, 1 MB at the same offset: 122 ms via the
`Range` header, 29 ms via the query parameter (8.6 vs 36.4 MB/s). The
header goes through googlevideo's throttled progressive path. The gap is
invisible while the buffer is ahead and decisive when it is empty and has
to be refilled before anything can play — which is a seek.

The response then arrives as a plain 200, so the proxy has to describe
the partial content itself. A 206 whose body and Content-Range disagree
is rejected by players and turned into a 416 by intermediaries, so these
tests pin that arithmetic as much as the rewrite.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DEVELOPMENT_MODE", "true")

from fastapi.testclient import TestClient

from core.config import GVS_MAX_RANGE_BYTES
from services.gvs_range import rewrite_range

# Larger than the open-ended cap, so capping is observable.
TOTAL = 40_000_000
GVS = ("https://rr3---sn-abc.googlevideo.com/videoplayback"
       "?expire=111&sig=AAA&itag=137&clen=%d&lmt=555&mime=video%%2Fmp4" % TOTAL)


class TestRewrite:
    def test_range_moves_into_the_query(self):
        rewritten = rewrite_range(GVS, 1000, 1999)
        assert rewritten is not None
        assert "range=1000-1999" in rewritten.url
        assert rewritten.start == 1000
        assert rewritten.end == 1999
        assert rewritten.total == TOTAL

    def test_the_rest_of_the_query_survives(self):
        """Dropping a signing parameter turns the URL into a 403."""
        rewritten = rewrite_range(GVS, 0, 99)
        for required in ("expire=111", "sig=AAA", "itag=137", "lmt=555"):
            assert required in rewritten.url

    def test_content_range_describes_what_was_asked_for(self):
        rewritten = rewrite_range(GVS, 2048, 4095)
        assert rewritten.content_range == f"bytes 2048-4095/{TOTAL}"
        assert rewritten.length == 2048

    def test_an_open_ended_range_is_capped(self):
        """Otherwise one request pulls the remainder of the file."""
        rewritten = rewrite_range(GVS, 0, None)
        assert rewritten.end == GVS_MAX_RANGE_BYTES - 1

    def test_an_open_ended_range_near_the_end_stops_at_the_end(self):
        rewritten = rewrite_range(GVS, TOTAL - 10, None)
        assert rewritten.end == TOTAL - 1
        assert rewritten.length == 10

    def test_a_range_past_the_end_is_clamped(self):
        rewritten = rewrite_range(GVS, 0, TOTAL + 1_000_000)
        assert rewritten.end == TOTAL - 1

    def test_a_start_past_the_end_is_declined(self):
        """The origin should answer an unsatisfiable range itself."""
        assert rewrite_range(GVS, TOTAL, TOTAL + 100) is None
        assert rewrite_range(GVS, TOTAL + 5, None) is None

    def test_a_negative_start_is_declined(self):
        assert rewrite_range(GVS, -1, 100) is None

    def test_other_hosts_are_left_alone(self):
        """Only googlevideo has this behaviour; nobody else understands it."""
        assert rewrite_range("https://cdn.example.com/v.mp4?clen=999", 0, 99) is None

    def test_a_lookalike_host_is_not_matched(self):
        assert rewrite_range(
            "https://googlevideo.com.evil.example/v?clen=999", 0, 99) is None

    def test_a_url_without_a_declared_length_is_declined(self):
        """Without `clen` there is no total to state in a Content-Range."""
        no_clen = GVS.replace("clen=%d" % TOTAL, "gir=yes")
        assert rewrite_range(no_clen, 0, 99) is None

    def test_a_nonsense_length_is_declined(self):
        for bad in ("clen=0", "clen=abc", "clen=-5"):
            assert rewrite_range(GVS.replace("clen=%d" % TOTAL, bad), 0, 99) is None


class TestProxyStillAnswersAWellFormed206:
    """The origin replies 200; the caller must still receive a valid 206.

    Served from a local origin: the assertions are about exact byte counts
    and headers, which a real CDN can change.
    """

    PAYLOAD = bytes(range(256)) * 16  # 4096 deterministic bytes

    @pytest.fixture
    def origin(self):
        """An origin that answers `range=` in the query, as googlevideo does."""
        import threading
        from http.server import BaseHTTPRequestHandler, HTTPServer
        from urllib.parse import urlparse, parse_qs

        payload = self.PAYLOAD
        seen = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                query = parse_qs(urlparse(self.path).query)
                seen.append({"range_param": (query.get("range") or [None])[0],
                             "range_header": self.headers.get("Range")})
                spec = (query.get("range") or [None])[0]
                if spec:
                    start_s, _, end_s = spec.partition("-")
                    start, end = int(start_s), int(end_s)
                    body = payload[start:end + 1]
                    # googlevideo answers the query form with a plain 200.
                    self.send_response(200)
                    self.send_header("Content-Type", "video/mp4")
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
        # A googlevideo hostname is required for the rewrite to apply, but
        # the request has to land on the local origin, so the host is
        # remapped below rather than resolved.
        yield server.server_port, seen
        server.shutdown()
        server.server_close()

    @pytest.fixture(autouse=True)
    async def empty_caches(self):
        """The caches are process-global; each test starts from a miss."""
        from services.cache import memory_cache
        await memory_cache.clear()
        yield
        await memory_cache.clear()

    @pytest.fixture
    def client(self, origin, monkeypatch):
        import services.upstream as upstream
        from main import app

        port, _ = origin

        # Send every validated request to the local origin while leaving the
        # URL's googlevideo hostname — which is what the rewrite keys on —
        # untouched.
        monkeypatch.setattr(upstream, "_is_public_ip", lambda ip: True)
        monkeypatch.setattr(upstream, "UPSTREAM_ALLOWED_PORTS",
                            upstream.UPSTREAM_ALLOWED_PORTS + (port,))
        monkeypatch.setattr(upstream, "_resolve_public_addresses",
                            lambda hostname, p: ["127.0.0.1"])
        return TestClient(app)

    def media_url(self, port):
        return (f"http://rr3---sn-test.googlevideo.com:{port}/videoplayback"
                f"?itag=137&clen={len(self.PAYLOAD)}&lmt=555&mime=video%2Fmp4")

    def test_the_range_travels_in_the_query_not_the_header(self, client, origin):
        port, seen = origin
        client.get("/api/proxy",
                   params={"url": self.media_url(port), "user": "seek@example.com"},
                   headers={"Range": "bytes=100-199"})

        assert seen, "the origin was never asked"
        assert seen[-1]["range_param"] == "100-199"
        assert seen[-1]["range_header"] is None, (
            "sending both leaves the throttled path in play")

    def test_a_200_from_the_origin_becomes_a_valid_206(self, client, origin):
        port, _ = origin
        response = client.get(
            "/api/proxy",
            params={"url": self.media_url(port), "user": "seek@example.com"},
            headers={"Range": "bytes=100-199"})

        assert response.status_code == 206
        assert response.content == self.PAYLOAD[100:200]
        assert response.headers["content-range"] == \
            f"bytes 100-199/{len(self.PAYLOAD)}"
        assert response.headers["content-length"] == "100"

    def test_a_deep_offset_is_served_from_the_right_place(self, client, origin):
        """The whole point: a seek asks for bytes far into the file."""
        port, _ = origin
        start = len(self.PAYLOAD) - 300
        response = client.get(
            "/api/proxy",
            params={"url": self.media_url(port), "user": "seek@example.com"},
            headers={"Range": f"bytes={start}-{start + 99}"})

        assert response.status_code == 206
        assert response.content == self.PAYLOAD[start:start + 100]
        assert response.headers["content-range"] == \
            f"bytes {start}-{start + 99}/{len(self.PAYLOAD)}"

    def test_a_request_with_no_range_is_untouched(self, client, origin):
        port, seen = origin
        response = client.get(
            "/api/proxy",
            params={"url": self.media_url(port), "user": "seek@example.com"})

        assert response.status_code == 200
        assert response.content == self.PAYLOAD
        assert seen[-1]["range_param"] is None
