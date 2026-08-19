"""
Per-user cookie handling for upstream fetches.

The proxy used to hold one global cookie jar loaded from a single file
and send it upstream for everybody. That mixed identities: one user's
credentials fetched another user's segments, and because cached entries
were keyed by URL alone, content fetched with one user's cookies could
be served to anyone.

Cookies are now looked up per user and attached per request. Parsed jars
are cached briefly, keyed by file path and modification time, so a busy
stream does not re-read and re-parse the file for every segment.
"""
import os
import time
import http.cookiejar
import logging
from typing import Dict, Optional, Tuple
from urllib.parse import urlparse

from core.security import get_user_cookie_path
from core.config import COOKIE_JAR_CACHE_TTL_SECONDS, COOKIE_JAR_CACHE_MAX_USERS

logger = logging.getLogger(__name__)

# user_email -> (jar, mtime, cached_at)
_jar_cache: Dict[str, Tuple[http.cookiejar.MozillaCookieJar, float, float]] = {}


def _prune_cache(now: float) -> None:
    """Drop expired entries, then the oldest ones if still oversized."""
    expired = [
        email for email, (_jar, _mtime, cached_at) in _jar_cache.items()
        if now - cached_at > COOKIE_JAR_CACHE_TTL_SECONDS
    ]
    for email in expired:
        del _jar_cache[email]

    while len(_jar_cache) > COOKIE_JAR_CACHE_MAX_USERS:
        oldest = min(_jar_cache, key=lambda e: _jar_cache[e][2])
        del _jar_cache[oldest]


def _load_jar(user_email: str) -> Optional[http.cookiejar.MozillaCookieJar]:
    """Load (or reuse) the cookie jar belonging to one user."""
    if not user_email:
        return None

    cookie_path = get_user_cookie_path(user_email)
    if not cookie_path or not os.path.exists(cookie_path):
        return None

    try:
        mtime = os.path.getmtime(cookie_path)
    except OSError:
        return None

    now = time.time()
    cached = _jar_cache.get(user_email)
    if cached:
        jar, cached_mtime, cached_at = cached
        fresh = (now - cached_at) <= COOKIE_JAR_CACHE_TTL_SECONDS
        if fresh and cached_mtime == mtime:
            return jar

    jar = http.cookiejar.MozillaCookieJar()
    try:
        jar.load(cookie_path, ignore_discard=True, ignore_expires=True)
    except Exception as exc:
        logger.warning(f"Could not load cookies for {user_email}: {exc}")
        return None

    _jar_cache[user_email] = (jar, mtime, now)
    _prune_cache(now)
    logger.debug(f"Loaded cookie jar for {user_email} ({len(jar)} cookies)")
    return jar


def _domain_matches(cookie_domain: str, host: str) -> bool:
    """Netscape domain matching: exact host, or any subdomain of a dotted domain."""
    cookie_domain = cookie_domain.lower()
    host = host.lower()
    if cookie_domain.startswith("."):
        return host == cookie_domain[1:] or host.endswith(cookie_domain)
    return host == cookie_domain


def get_cookie_header(user_email: str, url: str) -> Optional[str]:
    """Build the Cookie header a specific user should send to a URL.

    Returns None when the user has no cookies for that host, so callers
    can tell an authenticated fetch from an anonymous one.
    """
    jar = _load_jar(user_email)
    if jar is None:
        return None

    parsed = urlparse(url)
    host = parsed.hostname or ""
    is_secure = parsed.scheme == "https"
    now = time.time()

    pairs = []
    for cookie in jar:
        if not _domain_matches(cookie.domain, host):
            continue
        if cookie.secure and not is_secure:
            continue
        if cookie.expires and cookie.expires < now:
            continue
        if not parsed.path.startswith(cookie.path or "/"):
            continue
        pairs.append(f"{cookie.name}={cookie.value}")

    return "; ".join(pairs) if pairs else None


def invalidate(user_email: str) -> None:
    """Forget a user's cached jar (called when their cookies change)."""
    _jar_cache.pop(user_email, None)


def clear_cache() -> None:
    """Drop every cached jar."""
    _jar_cache.clear()
