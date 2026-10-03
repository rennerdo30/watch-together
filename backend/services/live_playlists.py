"""
One upstream session per live stream, however many members watch it.

Each fetch of a live master playlist makes the origin open a new playback
session: its own media-playlist URLs and, on Twitch, its own ad schedule. A
room whose players each fetched the master watched different sessions — one
member got the "Commercial break in progress" slate while the other watched
the stream. Members also hold different resolves of one channel (different
`sig`/`token`), so the raw URL is no key for "the same stream".

So a master playlist is fetched once per stream and fetch identity, and every
viewer is served that body: the same media-playlist URLs, the same session.
It is dropped LIVE_MASTER_SHARE_SECONDS after its playlists were last
fetched, or at once when one of them answers 4xx (the session expired), so
the next master fetch starts a fresh shared session.

Media playlists are coalesced: viewers asking for one at the same moment
share a single upstream fetch, and a body fetched less than
LIVE_PLAYLIST_SHARE_SECONDS ago answers the next viewer.

Nothing is ever shared across cookie identities: every key carries the
`cache_identity` of the fetch (None only when no cookie was sent).
"""
import asyncio
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Dict, List, Optional, Tuple
from urllib.parse import urljoin, urlparse

from core.config import LIVE_MASTER_SHARE_SECONDS, LIVE_PLAYLIST_SHARE_SECONDS, TWITCH_USHER_HOST
from services.cache import stream_identity

logger = logging.getLogger(__name__)

# A playlist that lists variants is a master playlist.
MASTER_MARKER = "#EXT-X-STREAM-INF"
_URI_ATTRIBUTE = re.compile(r'URI="([^"]+)"')


@dataclass(frozen=True)
class Playlist:
    """One upstream answer for a playlist."""
    status_code: int
    text: str
    #: The URL the body was fetched from; its relative URIs resolve against it.
    source_url: str


Fetch = Callable[[], Awaitable[Playlist]]
_MasterKey = Tuple[str, str, Optional[str]]
_MediaKey = Tuple[str, Optional[str]]


@dataclass
class _Master:
    playlist: Playlist
    last_used: float
    variants: List[str] = field(default_factory=list)


_masters: Dict[_MasterKey, _Master] = {}
# (media playlist URL, cache identity) -> the shared master that listed it.
_variant_master: Dict[_MediaKey, _MasterKey] = {}
_master_flights: Dict[_MasterKey, "asyncio.Task[Playlist]"] = {}
_media: Dict[_MediaKey, Tuple[Playlist, float]] = {}
_media_flights: Dict[_MediaKey, "asyncio.Task[Playlist]"] = {}


def master_key(url: str, cache_identity: Optional[str]) -> Optional[_MasterKey]:
    """What makes two master-playlist URLs the same stream, or None.

    Twitch's usher URL names the channel in its path; its query is signed
    per resolve. Elsewhere only a stable stream identity qualifies — a URL
    with nothing stable in it is never shared under any other URL.
    """
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if host == TWITCH_USHER_HOST:
        return (host, parsed.path, cache_identity)
    identity = stream_identity(url)
    if identity == url:
        return None
    return (host, identity, cache_identity)


def _label(key: _MasterKey) -> str:
    host, path, _identity = key
    if host == TWITCH_USHER_HOST:
        return path.rsplit("/", 1)[-1].rsplit(".", 1)[0]
    return f"{host}{path}"


def variant_urls(playlist: Playlist) -> List[str]:
    """Every playlist a master lists: variant streams and alternate renditions."""
    urls = []
    for raw in playlist.text.split("\n"):
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#"):
            urls.extend(urljoin(playlist.source_url, uri) for uri in _URI_ATTRIBUTE.findall(line))
            continue
        urls.append(urljoin(playlist.source_url, line))
    return urls


def _drop_master(key: _MasterKey, reason: str) -> None:
    master = _masters.pop(key, None)
    if master is None:
        return
    for url in master.variants:
        if _variant_master.get((url, key[2])) == key:
            del _variant_master[(url, key[2])]
    logger.info("Shared live session for %s dropped: %s", _label(key), reason)


def _expire_masters(now: float) -> None:
    for key in [k for k, m in _masters.items() if now - m.last_used >= LIVE_MASTER_SHARE_SECONDS]:
        _drop_master(key, f"unused for {LIVE_MASTER_SHARE_SECONDS}s")


def _flight(flights: dict, key, load: Callable[[], Awaitable[Playlist]]) -> "asyncio.Task[Playlist]":
    """The fetch under way for `key`, started if there is none.

    The fetch runs as its own task, so a viewer who leaves does not cancel
    it for the others waiting on it.
    """
    task = flights.get(key)
    if task is None:
        task = asyncio.ensure_future(load())
        flights[key] = task

        def finished(done: asyncio.Task) -> None:
            if flights.get(key) is done:
                del flights[key]
            if not done.cancelled():
                done.exception()  # retrieved, even if every waiter left

        task.add_done_callback(finished)
    return task


async def fetch_playlist(url: str, cache_identity: Optional[str], fetch: Fetch) -> Playlist:
    """The playlist at `url`, fetched by `fetch` only when no viewer's copy will do."""
    now = time.monotonic()
    _expire_masters(now)
    key = master_key(url, cache_identity)
    if key is not None:
        shared = _masters.get(key)
        if shared is not None:
            shared.last_used = now
            return shared.playlist
        return await asyncio.shield(_flight(_master_flights, key, lambda: _load_master(key, fetch)))

    media_key = (url, cache_identity)
    hit = _media.get(media_key)
    if hit is not None and now - hit[1] < LIVE_PLAYLIST_SHARE_SECONDS:
        _touch_master(media_key, now)
        return hit[0]
    return await asyncio.shield(_flight(_media_flights, media_key, lambda: _load_media(media_key, fetch)))


async def _load_master(key: _MasterKey, fetch: Fetch) -> Playlist:
    playlist = await fetch()
    if playlist.status_code == 200 and MASTER_MARKER in playlist.text:
        variants = variant_urls(playlist)
        _masters[key] = _Master(playlist, time.monotonic(), variants)
        for url in variants:
            _variant_master[(url, key[2])] = key
        logger.info("Shared live session for %s created (%d playlists)", _label(key), len(variants))
    return playlist


def _touch_master(media_key: _MediaKey, now: float) -> None:
    master_key_ = _variant_master.get(media_key)
    master = _masters.get(master_key_) if master_key_ else None
    if master is not None:
        master.last_used = now


async def _load_media(key: _MediaKey, fetch: Fetch) -> Playlist:
    playlist = await fetch()
    now = time.monotonic()
    for stale in [k for k, (_, at) in _media.items() if now - at >= LIVE_PLAYLIST_SHARE_SECONDS]:
        del _media[stale]
    if playlist.status_code == 200:
        _media[key] = (playlist, now)
        _touch_master(key, now)
    else:
        _media.pop(key, None)
        if 400 <= playlist.status_code < 500:
            master = _variant_master.get(key)
            if master is not None:
                _drop_master(master, f"a playlist answered {playlist.status_code}")
    return playlist


def forget_all() -> None:
    _masters.clear()
    _variant_master.clear()
    _master_flights.clear()
    _media.clear()
    _media_flights.clear()
