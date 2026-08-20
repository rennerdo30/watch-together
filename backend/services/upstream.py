"""
Safe upstream fetching for the media proxy.

The proxy fetches arbitrary URLs on a caller's behalf, which is the
classic SSRF shape. Three properties are enforced here:

1. Every host is validated, including well-known CDNs. Suffix matching
   on a hostname proves nothing — an attacker can own a subdomain of an
   allowlisted CDN domain.
2. Redirects are followed manually and every hop is validated. Following
   redirects inside the HTTP client would let a validated public URL
   bounce to a private address.
3. The address that passed validation is the address that gets
   connected to. Resolving DNS during validation and letting the client
   resolve again leaves a rebinding window between the two lookups.
"""
import socket
import ipaddress
import logging
from dataclasses import dataclass
from typing import List, Optional, Tuple
from urllib.parse import urlparse, urlunparse

import httpx

from core.config import (
    UPSTREAM_MAX_REDIRECTS,
    UPSTREAM_ALLOWED_SCHEMES,
    UPSTREAM_ALLOWED_PORTS,
)

logger = logging.getLogger(__name__)

# Ranges that Python's address flags do not mark as private or reserved,
# but which must not be reachable from a user-supplied URL. Each of these
# reports no restrictive flag at all, so the flag checks alone let them
# through.
_EXTRA_BLOCKED_NETWORKS = tuple(ipaddress.ip_network(cidr) for cidr in (
    "100.64.0.0/10",     # RFC 6598 shared address space (carrier NAT)
    "192.88.99.0/24",    # Deprecated 6to4 relay anycast
    "fec0::/10",         # Deprecated IPv6 site-local addressing
    "2001:db8::/32",     # Documentation range
))


class UnsafeUpstreamError(Exception):
    """Raised when a URL may not be fetched."""


@dataclass(frozen=True)
class PinnedUpstream:
    """A validated URL together with the address it must be fetched from."""
    url: str
    hostname: str
    ip: str
    port: int
    scheme: str

    @property
    def connect_url(self) -> str:
        """The request URL rewritten to address the pinned IP directly."""
        parsed = urlparse(self.url)
        host = f"[{self.ip}]" if ":" in self.ip else self.ip
        return urlunparse(parsed._replace(netloc=f"{host}:{self.port}"))


def _is_public_ip(ip_str: str) -> bool:
    """True only for addresses that are safe to reach outward."""
    try:
        addr = ipaddress.ip_address(ip_str)
    except ValueError:
        return False

    if (
        addr.is_private
        or addr.is_reserved
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_multicast
        or addr.is_unspecified
    ):
        return False

    # An IPv4 address tunnelled inside IPv6 has to be judged on the address
    # it actually reaches, not on the wrapper around it.
    tunnelled = getattr(addr, "ipv4_mapped", None) or getattr(addr, "sixtofour", None)
    if tunnelled is not None and not _is_public_ip(str(tunnelled)):
        return False

    return not any(
        addr in network
        for network in _EXTRA_BLOCKED_NETWORKS
        if network.version == addr.version
    )


def _resolve_public_addresses(hostname: str, port: int) -> List[str]:
    """Resolve a hostname, requiring every answer to be a public address.

    Rejecting the whole name when any answer is private closes the
    round-robin variant of rebinding, where a name alternates between a
    public and a private address.
    """
    try:
        addr = ipaddress.ip_address(hostname)
        if not _is_public_ip(str(addr)):
            raise UnsafeUpstreamError("Access to internal networks is not allowed")
        return [str(addr)]
    except ValueError:
        pass  # Not a literal address; resolve it below.

    try:
        results = socket.getaddrinfo(hostname, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise UnsafeUpstreamError(f"Could not resolve host: {exc}") from exc

    addresses = []
    for *_unused, sockaddr in results:
        ip_str = sockaddr[0]
        if not _is_public_ip(ip_str):
            raise UnsafeUpstreamError("Access to internal networks is not allowed")
        if ip_str not in addresses:
            addresses.append(ip_str)

    if not addresses:
        raise UnsafeUpstreamError("Host did not resolve to any address")
    return addresses


def validate_url(url: str) -> Tuple[str, int, str]:
    """Check scheme, host and port. Returns (hostname, port, scheme)."""
    parsed = urlparse(url)

    if parsed.scheme not in UPSTREAM_ALLOWED_SCHEMES:
        raise UnsafeUpstreamError("Only http/https URLs are allowed")
    if not parsed.hostname:
        raise UnsafeUpstreamError("Invalid URL: no hostname")

    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    if port not in UPSTREAM_ALLOWED_PORTS:
        raise UnsafeUpstreamError(f"Port {port} is not allowed")

    return parsed.hostname, port, parsed.scheme


def pin_url(url: str) -> PinnedUpstream:
    """Validate a URL and pin it to a resolved public address."""
    hostname, port, scheme = validate_url(url)
    addresses = _resolve_public_addresses(hostname, port)
    return PinnedUpstream(
        url=url, hostname=hostname, ip=addresses[0], port=port, scheme=scheme,
    )


def request_kwargs(pinned: PinnedUpstream, headers: dict) -> dict:
    """Build client kwargs that connect to the pinned address.

    The URL carries the IP so no second DNS lookup happens, while the
    Host header and the TLS SNI keep the original hostname so signed
    URLs and certificate validation still work.
    """
    outgoing = dict(headers)
    outgoing["Host"] = pinned.hostname
    return {
        "url": pinned.connect_url,
        "headers": outgoing,
        "extensions": {"sni_hostname": pinned.hostname},
    }


async def open_upstream_stream(
    client: httpx.AsyncClient,
    url: str,
    headers: Optional[dict] = None,
    max_redirects: int = UPSTREAM_MAX_REDIRECTS,
) -> Tuple[httpx.Response, PinnedUpstream]:
    """Start a streaming GET, validating the URL and every redirect hop.

    Redirects are resolved as part of the real request rather than by a
    separate probe, so validating them costs no extra round trip. The
    caller owns the returned response and must close it.
    """
    headers = headers or {}
    current = url

    for _hop in range(max_redirects + 1):
        pinned = pin_url(current)
        request = client.build_request("GET", **request_kwargs(pinned, headers))
        response = await client.send(request, stream=True, follow_redirects=False)

        location = response.headers.get("location")
        if not (300 <= response.status_code < 400 and location):
            return response, pinned

        await response.aclose()
        current = str(httpx.URL(current).join(location))
        logger.debug("Upstream redirect %d to %s", response.status_code, current[:120])

    raise UnsafeUpstreamError(f"Too many redirects (limit {max_redirects})")


async def resolve_upstream(
    client: httpx.AsyncClient,
    url: str,
    headers: Optional[dict] = None,
    max_redirects: int = UPSTREAM_MAX_REDIRECTS,
) -> PinnedUpstream:
    """Resolve a URL to its validated, pinned final destination.

    Follows redirects with the same per-hop validation as
    open_upstream_stream, discarding the body.
    """
    response, pinned = await open_upstream_stream(client, url, headers, max_redirects)
    await response.aclose()
    return pinned
