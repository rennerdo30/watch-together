"""
Per-user cookies, held in memory only.

Cookies are live session credentials — worth more than a password, since
they skip the login. They are therefore never written to the database or
to a file the process keeps: the browser extension posts a copy every few
minutes, the copy lives in this process until it is refreshed or expires,
and it vanishes with the process. yt-dlp needs a cookie file, so one is
written to a private scratch directory (RAM-backed where the platform has
one) for the duration of a single extraction and removed right after.

Cookies are looked up per user and attached per request. Resolving a video
is the one place a member's cookies are used on someone else's behalf:
most members never install the extension, so the member pasting a link
often has no cookies while somebody else in the room does. Lending is
limited to members connected to that room, to the sites in
`COOKIE_SHARE_EXTRACTORS`, and to single-video pages — a feed or history
URL fetched with a lender's session would publish that member's account
to the room.
"""
import asyncio
import http.cookiejar
import logging
import os
import shutil
import tempfile
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import AsyncIterator, Dict, Iterable, List, Optional, Sequence
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from core.config import (
    COOKIE_FILE_MODE, COOKIE_HOST_ALIASES, COOKIE_MAX_BYTES, COOKIE_MEMORY_TTL_SECONDS,
    COOKIE_SCRATCH_DIR, COOKIE_SCRATCH_PREFIX, COOKIE_SHARE_EXTRACTORS,
    COOKIE_STORE_MAX_USERS, GUEST_IDENTITY, YOUTUBE_PLAYLIST_PARAMS,
)

logger = logging.getLogger(__name__)

NETSCAPE_HEADER = "# Netscape HTTP Cookie File"
NETSCAPE_FIELD_COUNT = 7
# Browsers export HttpOnly cookies behind this prefix; it is not a comment.
HTTPONLY_PREFIX = "#HttpOnly_"
HTTPONLY_ATTR = "HttpOnly"
SCRATCH_FILE_NAME = "cookies.txt"


class CookieFormatError(ValueError):
    """The submitted text is not a usable Netscape cookie file."""


@dataclass
class CookieEntry:
    cookies: List[http.cookiejar.Cookie]
    synced_at: float
    browser: Optional[str]
    domains: Sequence[str]

    @property
    def expires_at(self) -> float:
        return self.synced_at + COOKIE_MEMORY_TTL_SECONDS


# user_email -> entry. The only copy of anyone's cookies this server holds.
_store: Dict[str, CookieEntry] = {}


# ----------------------------------------------------------------------------
# Netscape format
# ----------------------------------------------------------------------------

def parse_netscape(text: str) -> List[http.cookiejar.Cookie]:
    """Parse Netscape cookie-file text strictly.

    Every data line must carry exactly seven tab-separated fields; a file
    without a single cookie is rejected rather than stored as "cookies".
    """
    if len(text.encode("utf-8")) > COOKIE_MAX_BYTES:
        raise CookieFormatError("Cookie content exceeds the size limit")

    cookies: List[http.cookiejar.Cookie] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        http_only = line.startswith(HTTPONLY_PREFIX)
        if http_only:
            line = line[len(HTTPONLY_PREFIX):]
        elif line.startswith("#"):
            continue

        fields = line.split("\t")
        if len(fields) != NETSCAPE_FIELD_COUNT:
            raise CookieFormatError(
                "Invalid Netscape cookie format. Each data line must have 7 tab-separated fields."
            )
        domain, include_subdomains, path, secure, expires, name, value = fields
        try:
            expiry = int(expires) if expires not in ("", "0") else None
        except ValueError as exc:
            raise CookieFormatError("Invalid cookie expiry") from exc

        cookies.append(http.cookiejar.Cookie(
            version=0, name=name, value=value,
            port=None, port_specified=False,
            domain=domain, domain_specified=bool(domain),
            domain_initial_dot=domain.startswith("."),
            path=path or "/", path_specified=bool(path),
            secure=secure.upper() == "TRUE",
            expires=expiry, discard=expiry is None,
            comment=None, comment_url=None,
            rest={HTTPONLY_ATTR: None} if http_only else {},
        ))

    if not cookies:
        raise CookieFormatError("No cookie data lines found")
    return cookies


def to_netscape(cookies: Iterable[http.cookiejar.Cookie]) -> str:
    """Render cookies as the file yt-dlp reads."""
    lines = [NETSCAPE_HEADER, ""]
    for cookie in cookies:
        prefix = HTTPONLY_PREFIX if cookie.has_nonstandard_attr(HTTPONLY_ATTR) else ""
        lines.append("\t".join([
            prefix + cookie.domain,
            "TRUE" if cookie.domain.startswith(".") else "FALSE",
            cookie.path or "/",
            "TRUE" if cookie.secure else "FALSE",
            str(int(cookie.expires)) if cookie.expires else "0",
            cookie.name,
            cookie.value or "",
        ]))
    return "\n".join(lines) + "\n"


# ----------------------------------------------------------------------------
# The store
# ----------------------------------------------------------------------------

def store(user_email: str, text: str, *, browser: Optional[str] = None,
          domains: Sequence[str] = ()) -> CookieEntry:
    """Replace a user's cookies with a freshly synced copy."""
    if not user_email or user_email == GUEST_IDENTITY:
        raise ValueError("Cookies need an authenticated owner")
    entry = CookieEntry(parse_netscape(text), time.time(), browser, tuple(domains))
    _store[user_email] = entry
    prune_expired()
    while len(_store) > COOKIE_STORE_MAX_USERS:
        oldest = min(_store, key=lambda email: _store[email].synced_at)
        del _store[oldest]
    logger.debug(f"Holding {len(entry.cookies)} cookies for {user_email} until they expire or are refreshed")
    return entry


def forget(user_email: str) -> bool:
    """Drop a user's cookies now. Returns whether there were any."""
    return _store.pop(user_email, None) is not None


def prune_expired(now: Optional[float] = None) -> int:
    """Drop every copy the extension has stopped refreshing."""
    now = time.time() if now is None else now
    expired = [email for email, entry in _store.items() if entry.expires_at <= now]
    for email in expired:
        del _store[email]
        logger.info(f"Cookies of {email} expired without a refresh and were dropped")
    return len(expired)


def _entry(user_email: Optional[str]) -> Optional[CookieEntry]:
    if not user_email:
        return None
    entry = _store.get(user_email)
    if entry is None:
        return None
    if entry.expires_at <= time.time():
        prune_expired()
        return None
    return entry


def has_cookies(user_email: str) -> bool:
    return _entry(user_email) is not None


def status(user_email: str) -> dict:
    """What a user may know about their own cookies: presence and timing, never values."""
    entry = _entry(user_email)
    if entry is None:
        return {"has_cookies": False}
    return {
        "has_cookies": True,
        "synced_at": entry.synced_at,
        "expires_at": entry.expires_at,
        "cookie_count": len(entry.cookies),
        "browser": entry.browser,
    }


def holders() -> List[str]:
    """Identities whose cookies are currently held."""
    prune_expired()
    return sorted(_store)


def clear_all() -> None:
    _store.clear()


# ----------------------------------------------------------------------------
# Lookup
# ----------------------------------------------------------------------------

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
    entry = _entry(user_email)
    if entry is None:
        return None

    parsed = urlparse(url)
    host = parsed.hostname or ""
    is_secure = parsed.scheme == "https"
    now = time.time()

    pairs = []
    for cookie in entry.cookies:
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


def _page_url(url: str) -> str:
    """The URL whose cookies decide whether a member is signed in to `url`'s site."""
    parsed = urlparse(url)
    alias = COOKIE_HOST_ALIASES.get((parsed.hostname or "").lower())
    if not alias:
        return url
    return urlunparse(parsed._replace(netloc=alias))


def has_cookies_for(user_email: str, url: str) -> bool:
    """Whether this user's cookies include any live one for the site serving `url`."""
    return get_cookie_header(user_email, _page_url(url)) is not None


# ----------------------------------------------------------------------------
# Lending cookies to a room
# ----------------------------------------------------------------------------

_share_extractors: Optional[list] = None


def _single_video_url(url: str) -> str:
    """A watch URL without its playlist context.

    `watch?v=X&list=WL` is a video the member wants to watch, but yt-dlp's
    single-video matcher hands anything with a list to the tab extractor.
    With `noplaylist` set the extraction still covers only the video, so the
    check ignores the playlist parameters.
    """
    parsed = urlparse(url)
    query = [(k, v) for k, v in parse_qsl(parsed.query, keep_blank_values=True)
             if k not in YOUTUBE_PLAYLIST_PARAMS]
    return urlunparse(parsed._replace(query=urlencode(query)))


def is_shareable(url: str) -> bool:
    """Whether another member's cookies may be used to resolve `url`.

    Only the single-video extractors of the allowlisted sites qualify. A
    channel, playlist, feed or history page would be extracted with the
    lender's session and its contents broadcast to the room.
    """
    global _share_extractors
    if _share_extractors is None:
        from yt_dlp.extractor import gen_extractor_classes
        _share_extractors = [ie for ie in gen_extractor_classes() if ie.IE_NAME in COOKIE_SHARE_EXTRACTORS]
    candidate = _single_video_url(url)
    return any(ie.suitable(candidate) for ie in _share_extractors)


def choose_cookie_source(url: str, requester: Optional[str], members: Iterable[str] = ()) -> Optional[str]:
    """Pick the member whose cookies should resolve `url`, or None for anonymous.

    The requester's own cookies win whenever they cover the site. Otherwise,
    for a shareable single-video page, the first of `members` (the room's
    connected identities, in join order) who is signed in to the site lends
    theirs. Guests and anyone not in the room are never a source.
    """
    if requester == GUEST_IDENTITY:
        requester = None
    if requester and has_cookies_for(requester, url):
        return requester

    if not is_shareable(url):
        return None
    for email in members:
        if not email or email == GUEST_IDENTITY or email == requester:
            continue
        if has_cookies_for(email, url):
            logger.info(f"Resolving {url} for {requester or 'anonymous'} with cookies lent by {email}")
            return email
    return None


# ----------------------------------------------------------------------------
# A cookie file for one extraction
# ----------------------------------------------------------------------------

def _write_private(path: str, text: str) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, COOKIE_FILE_MODE)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)


@asynccontextmanager
async def cookie_file(user_email: Optional[str]) -> AsyncIterator[Optional[str]]:
    """A Netscape cookie file for yt-dlp, alive only inside the block.

    Yields None when the user has no cookies. The file sits in a fresh
    private directory under `COOKIE_SCRATCH_DIR` and is removed — with
    whatever yt-dlp wrote back — as soon as the block ends.
    """
    entry = _entry(user_email)
    if entry is None:
        yield None
        return

    directory = await asyncio.to_thread(tempfile.mkdtemp, prefix=COOKIE_SCRATCH_PREFIX, dir=COOKIE_SCRATCH_DIR)
    path = os.path.join(directory, SCRATCH_FILE_NAME)
    try:
        await asyncio.to_thread(_write_private, path, to_netscape(entry.cookies))
        yield path
    finally:
        await asyncio.to_thread(shutil.rmtree, directory, True)
