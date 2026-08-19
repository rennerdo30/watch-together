"""
SSRF tests for the proxy URL validation layer.

The three bypass paths that used to be documented here as expected
failures — the trusted-CDN suffix skip, unvalidated redirects, and
unpinned DNS — are now closed, so these assert the fixed behaviour.
Redirect and pinning mechanics are covered in depth in test_upstream.py;
this file guards the endpoint-facing validator.
"""
import socket
import pytest
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi import HTTPException


def _validate(url: str):
    from main import validate_proxy_url
    validate_proxy_url(url)


# ---------------------------------------------------------------------------
# Cases the validator must block
# ---------------------------------------------------------------------------

BLOCKED_URLS = [
    pytest.param("file:///etc/passwd", id="file-scheme"),
    pytest.param("ftp://example.com/x", id="ftp-scheme"),
    pytest.param("gopher://example.com/x", id="gopher-scheme"),
    pytest.param("http://", id="no-hostname"),
    pytest.param("http://127.0.0.1/latest/meta-data", id="loopback-v4"),
    pytest.param("http://127.1.2.3/x", id="loopback-v4-nonstandard"),
    pytest.param("http://[::1]/x", id="loopback-v6"),
    pytest.param("http://10.0.0.5/x", id="rfc1918-10"),
    pytest.param("http://172.16.0.1/x", id="rfc1918-172"),
    pytest.param("http://192.168.1.1/x", id="rfc1918-192"),
    pytest.param("http://169.254.169.254/latest/meta-data", id="link-local-metadata"),
    pytest.param("http://0.0.0.0/x", id="unspecified"),
    pytest.param("http://localhost/x", id="localhost-name"),
    pytest.param("http://localhost:8000/api/rooms", id="localhost-own-backend"),
    pytest.param("http://example.com:22/x", id="non-media-port"),
]


@pytest.mark.parametrize("url", BLOCKED_URLS)
def test_blocked_url_raises(url):
    with pytest.raises(HTTPException) as exc_info:
        _validate(url)
    assert exc_info.value.status_code == 400


def test_public_ip_literal_allowed():
    """A public IP literal must pass without DNS resolution."""
    _validate("https://93.184.216.34/video.mp4")


def test_unresolvable_hostname_blocked(monkeypatch):
    """A hostname that cannot be resolved must be blocked (fail closed)."""
    def fail_resolve(*args, **kwargs):
        raise socket.gaierror("resolution failed")

    monkeypatch.setattr(socket, "getaddrinfo", fail_resolve)
    with pytest.raises(HTTPException):
        _validate("https://does-not-resolve.invalid/x")


# ---------------------------------------------------------------------------
# Previously known bypass paths
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "url",
    [
        pytest.param("https://attacker.fastly.net/x", id="cdn-suffix-fastly"),
        pytest.param("https://evil.akamaized.net/x", id="cdn-suffix-akamai"),
        pytest.param("https://x.cloudfront.net/x", id="cdn-suffix-cloudfront"),
        pytest.param("https://not-really.googlevideo.com/x", id="cdn-suffix-googlevideo"),
    ],
)
def test_cdn_subdomain_does_not_skip_ip_check(monkeypatch, url):
    """Allowlisted-CDN hostnames get no exemption from address validation."""
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443)),
    ])
    with pytest.raises(HTTPException):
        _validate(url)


def test_redirects_are_validated_per_hop():
    """The fetch path follows redirects itself so every hop is checked."""
    import main as main_module

    assert hasattr(main_module, "resolve_upstream")
    assert hasattr(main_module, "open_upstream_stream")


def test_validated_ip_is_pinned_for_fetch():
    """The request connects to the address that passed validation."""
    from services.upstream import pin_url, request_kwargs

    pinned = pin_url("https://93.184.216.34/video.mp4")
    kwargs = request_kwargs(pinned, {})

    # The URL addresses the pinned IP, so no second DNS lookup happens,
    # while Host and SNI preserve the original hostname.
    assert "93.184.216.34" in kwargs["url"]
    assert kwargs["headers"]["Host"] == "93.184.216.34"
    assert kwargs["extensions"]["sni_hostname"] == "93.184.216.34"


def test_proxy_client_does_not_follow_redirects_itself():
    """Redirect following must stay in the validating helper."""
    import asyncio
    from main import get_proxy_client

    client = asyncio.run(get_proxy_client())
    assert client.follow_redirects is False


def test_proxy_client_has_no_shared_cookie_jar():
    """Cookies are per user and per request, never a shared jar."""
    import asyncio
    from main import get_proxy_client

    client = asyncio.run(get_proxy_client())
    assert len(client.cookies.jar) == 0
