"""
SSRF tests for the proxy URL validation layer.

The xfail-marked tests document known bypass paths in the current
validator (trusted-CDN suffix skip, unvalidated redirects, DNS
rebinding). They are the acceptance tests for the data-plane rework:
once the proxy validates every host and pins resolved IPs, the xfail
markers must be removed and the tests must pass.
"""
import pytest
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi import HTTPException


def _validate(url: str):
    from main import validate_proxy_url
    validate_proxy_url(url)


# ---------------------------------------------------------------------------
# Cases the validator must block today
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
    import socket

    def fail_resolve(*args, **kwargs):
        raise socket.gaierror("resolution failed")

    monkeypatch.setattr(socket, "getaddrinfo", fail_resolve)
    with pytest.raises(HTTPException):
        _validate("https://does-not-resolve.invalid/x")


# ---------------------------------------------------------------------------
# Known bypass paths — expected to fail until the data-plane rework lands
# ---------------------------------------------------------------------------

@pytest.mark.xfail(
    reason="trusted-CDN suffix check returns before any IP validation; "
    "an attacker-controlled subdomain of an allowlisted CDN domain "
    "bypasses SSRF checks entirely",
    strict=False,
)
@pytest.mark.parametrize(
    "url",
    [
        pytest.param("https://attacker.fastly.net/x", id="cdn-suffix-fastly"),
        pytest.param("https://evil.akamaized.net/x", id="cdn-suffix-akamai"),
        pytest.param("https://x.cloudfront.net/x", id="cdn-suffix-cloudfront"),
    ],
)
def test_cdn_subdomain_must_not_skip_ip_check(monkeypatch, url):
    """Even allowlisted-CDN hostnames must be blocked when they resolve
    to a private address."""
    import main as main_module

    monkeypatch.setattr(main_module, "_is_private_ip", lambda hostname: True)
    with pytest.raises(HTTPException):
        _validate(url)


@pytest.mark.xfail(
    reason="the proxy client follows redirects without re-validating the "
    "target; a validated public URL can redirect to a private IP",
    strict=False,
)
def test_redirect_targets_are_revalidated():
    """The fetch layer must expose redirect re-validation. This asserts the
    contract of the reworked control plane: a function that resolves a URL
    by following redirects manually, validating every hop."""
    import main as main_module

    assert hasattr(main_module, "resolve_upstream"), (
        "expected a resolve_upstream() control-plane function that follows "
        "redirects with per-hop SSRF validation"
    )


@pytest.mark.xfail(
    reason="validation resolves DNS once and the HTTP client resolves again; "
    "nothing pins the validated IP for the actual request",
    strict=False,
)
def test_validated_ip_is_pinned_for_fetch():
    """The fetch layer must connect to the exact IP that passed validation."""
    import main as main_module

    assert hasattr(main_module, "resolve_upstream"), (
        "expected resolve_upstream() to return a pinned IP used for the "
        "upstream connection"
    )
