"""
Tests for safe upstream fetching: host validation, IP pinning, and
per-hop redirect validation.

The redirect tests run against a real local HTTP server so the whole
path is exercised — including the case that matters most, a public URL
redirecting to a private address.
"""
import socket
import threading
import pytest
import sys
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import httpx

from services.upstream import (
    UnsafeUpstreamError, PinnedUpstream,
    validate_url, pin_url, request_kwargs, open_upstream_stream, resolve_upstream,
    _is_public_ip,
)


class TestAddressClassification:
    @pytest.mark.parametrize("ip", [
        "10.0.0.1", "172.16.5.4", "192.168.1.1", "127.0.0.1", "169.254.169.254",
        "0.0.0.0", "::1", "fe80::1", "224.0.0.1",
    ])
    def test_internal_addresses_rejected(self, ip):
        assert not _is_public_ip(ip)

    @pytest.mark.parametrize("ip", [
        pytest.param("100.64.0.1", id="cgnat-shared-space"),
        pytest.param("192.88.99.1", id="deprecated-6to4-relay"),
        pytest.param("fec0::1", id="deprecated-ipv6-site-local"),
        pytest.param("2001:db8::1", id="documentation-range"),
    ])
    def test_special_use_ranges_rejected(self, ip):
        """Ranges Python's own flags leave unmarked must still be blocked."""
        assert not _is_public_ip(ip)

    @pytest.mark.parametrize("ip", [
        pytest.param("::ffff:127.0.0.1", id="mapped-loopback"),
        pytest.param("::ffff:10.0.0.1", id="mapped-rfc1918"),
        pytest.param("::ffff:169.254.169.254", id="mapped-metadata"),
    ])
    def test_ipv4_tunnelled_in_ipv6_is_judged_on_the_inner_address(self, ip):
        assert not _is_public_ip(ip)

    @pytest.mark.parametrize("ip", ["93.184.216.34", "1.1.1.1", "2606:4700::1111"])
    def test_public_addresses_accepted(self, ip):
        assert _is_public_ip(ip)

    def test_garbage_is_not_public(self):
        assert not _is_public_ip("not-an-ip")


class TestUrlValidation:
    @pytest.mark.parametrize("url", [
        "file:///etc/passwd", "ftp://example.com/x", "gopher://example.com/x",
    ])
    def test_non_http_schemes_rejected(self, url):
        with pytest.raises(UnsafeUpstreamError):
            validate_url(url)

    def test_missing_hostname_rejected(self):
        with pytest.raises(UnsafeUpstreamError):
            validate_url("http://")

    def test_unusual_port_rejected(self):
        """Ports outside the media set are refused, closing port scanning."""
        with pytest.raises(UnsafeUpstreamError):
            validate_url("http://example.com:22/x")

    def test_default_ports_inferred(self):
        assert validate_url("https://example.com/x")[1] == 443
        assert validate_url("http://example.com/x")[1] == 80


class TestPinning:
    def test_private_literal_rejected(self):
        with pytest.raises(UnsafeUpstreamError):
            pin_url("http://127.0.0.1/x")

    def test_public_literal_pinned_without_dns(self):
        pinned = pin_url("https://93.184.216.34/video.mp4")
        assert pinned.ip == "93.184.216.34"
        assert pinned.hostname == "93.184.216.34"

    def test_hostname_resolving_private_rejected(self, monkeypatch):
        monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.1.2.3", 443)),
        ])
        with pytest.raises(UnsafeUpstreamError):
            pin_url("https://sneaky.example.com/x")

    def test_cdn_hostname_is_not_exempt(self, monkeypatch):
        """A subdomain of an allowlisted CDN gets no special treatment."""
        monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443)),
        ])
        with pytest.raises(UnsafeUpstreamError):
            pin_url("https://attacker.fastly.net/x")

    def test_mixed_answers_rejected(self, monkeypatch):
        """One private answer poisons the whole name (round-robin rebinding)."""
        monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("192.168.0.5", 443)),
        ])
        with pytest.raises(UnsafeUpstreamError):
            pin_url("https://mixed.example.com/x")

    def test_unresolvable_rejected(self, monkeypatch):
        def boom(*a, **k):
            raise socket.gaierror("nope")
        monkeypatch.setattr(socket, "getaddrinfo", boom)
        with pytest.raises(UnsafeUpstreamError):
            pin_url("https://nowhere.invalid/x")


class TestRequestKwargs:
    def test_connects_to_ip_but_keeps_hostname(self):
        pinned = PinnedUpstream(
            url="https://cdn.example.com/seg.ts", hostname="cdn.example.com",
            ip="93.184.216.34", port=443, scheme="https",
        )
        kwargs = request_kwargs(pinned, {"Range": "bytes=0-99"})

        assert kwargs["url"] == "https://93.184.216.34:443/seg.ts"
        assert kwargs["headers"]["Host"] == "cdn.example.com"
        assert kwargs["headers"]["Range"] == "bytes=0-99"
        assert kwargs["extensions"]["sni_hostname"] == "cdn.example.com"

    def test_ipv6_literal_is_bracketed(self):
        pinned = PinnedUpstream(
            url="https://cdn.example.com/x", hostname="cdn.example.com",
            ip="2606:4700::1111", port=443, scheme="https",
        )
        assert "[2606:4700::1111]:443" in request_kwargs(pinned, {})["url"]


# ---------------------------------------------------------------------------
# Redirect handling against a real server
# ---------------------------------------------------------------------------

class _RedirectHandler(BaseHTTPRequestHandler):
    """Serves the redirect chains the tests need."""

    routes = {}

    def do_GET(self):
        target = self.routes.get(self.path)
        if target is None:
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"final destination")
            return
        self.send_response(302)
        self.send_header("Location", target)
        self.end_headers()

    def log_message(self, *args):
        pass  # Keep test output clean


@pytest.fixture
def redirect_server():
    server = HTTPServer(("127.0.0.1", 0), _RedirectHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server
    server.shutdown()
    server.server_close()


@pytest.fixture
def allow_loopback(monkeypatch, redirect_server):
    """Make the local test server reachable.

    Loopback and the server's ephemeral port are allowed so the redirect
    logic can be exercised; every other private address stays blocked,
    which is what the redirect-to-private test relies on.
    """
    import services.upstream as upstream

    real = upstream._is_public_ip

    def permissive(ip):
        return ip == "127.0.0.1" or real(ip)

    monkeypatch.setattr(upstream, "_is_public_ip", permissive)
    monkeypatch.setattr(
        upstream, "UPSTREAM_ALLOWED_PORTS",
        upstream.UPSTREAM_ALLOWED_PORTS + (redirect_server.server_port,),
    )


@pytest.fixture
async def client():
    async with httpx.AsyncClient(timeout=5.0) as c:
        yield c


class TestRedirectValidation:
    async def test_redirect_to_private_address_is_blocked(
        self, redirect_server, allow_loopback, client
    ):
        """The core case: a reachable URL bouncing to an internal address."""
        port = redirect_server.server_port
        _RedirectHandler.routes = {"/start": "http://192.168.13.37/secret"}

        with pytest.raises(UnsafeUpstreamError):
            await open_upstream_stream(client, f"http://127.0.0.1:{port}/start")

    async def test_redirect_chain_within_limit_succeeds(
        self, redirect_server, allow_loopback, client
    ):
        port = redirect_server.server_port
        base = f"http://127.0.0.1:{port}"
        _RedirectHandler.routes = {"/a": f"{base}/b", "/b": f"{base}/c"}

        response, pinned = await open_upstream_stream(client, f"{base}/a")
        assert response.status_code == 200
        assert pinned.url.endswith("/c")
        await response.aclose()

    async def test_too_many_redirects_rejected(
        self, redirect_server, allow_loopback, client
    ):
        port = redirect_server.server_port
        base = f"http://127.0.0.1:{port}"
        _RedirectHandler.routes = {
            "/1": f"{base}/2", "/2": f"{base}/3",
            "/3": f"{base}/4", "/4": f"{base}/5", "/5": f"{base}/6",
        }

        with pytest.raises(UnsafeUpstreamError):
            await open_upstream_stream(client, f"{base}/1", max_redirects=2)

    async def test_resolve_upstream_returns_final_hop(
        self, redirect_server, allow_loopback, client
    ):
        port = redirect_server.server_port
        base = f"http://127.0.0.1:{port}"
        _RedirectHandler.routes = {"/one": f"{base}/two"}

        pinned = await resolve_upstream(client, f"{base}/one")
        assert pinned.url == f"{base}/two"

    async def test_non_redirect_returns_immediately(
        self, redirect_server, allow_loopback, client
    ):
        port = redirect_server.server_port
        _RedirectHandler.routes = {}

        response, pinned = await open_upstream_stream(client, f"http://127.0.0.1:{port}/direct")
        assert response.status_code == 200
        await response.aclose()
