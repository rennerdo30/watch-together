"""
Which member's session a video's stream URLs belong to.

A video is resolved once, with one member's cookies, and the signed stream
URLs that come back are bound to that session. Every fetch of those URLs —
the probes that build the manifest and the segments the proxy serves — has
to carry the same cookies, whoever asks: with another member's cookies (or
none) the CDN refuses, most renditions silently vanish from that member's
manifest, and quality selection "does nothing" for everyone but the person
who added the video.

The identity is recorded with the format cache entry as `resolved_by` and
kept here in memory keyed by the stream's cache-stable identity, so the
proxy can look a segment URL up without a database round trip. Only URLs
that a resolve actually produced are registered, which is what keeps one
member's cookies from being used for arbitrary addresses.
"""

import logging
from collections import OrderedDict
from typing import Iterable, Optional, Set
from urllib.parse import urlparse

from core.config import STREAM_OWNER_MAX_ENTRIES
from services.cache import stream_identity

logger = logging.getLogger(__name__)

RESOLVED_BY_KEY = "resolved_by"

# (host, stream identity) -> resolving identity (None: resolved anonymously).
# The host is part of the key: the stream identity ignores it on purpose
# (the same rendition from another edge is the same bytes), but cookies
# must only ever go to the host the resolve actually produced.
_owners: "OrderedDict[tuple, Optional[str]]" = OrderedDict()


def _key(url: str) -> tuple:
    return ((urlparse(url).hostname or "").lower(), stream_identity(url))


def identities(video_data: dict) -> Set[tuple]:
    return {_key(url) for url in stream_urls(video_data)}


def stream_urls(video_data: dict) -> Iterable[str]:
    """Every stream URL a resolved video carries."""
    for key in ("stream_url", "video_url", "audio_url"):
        url = video_data.get(key)
        if isinstance(url, str) and url:
            yield url
    for quality in video_data.get("available_qualities") or []:
        url = quality.get("video_url") if isinstance(quality, dict) else None
        if isinstance(url, str) and url:
            yield url
    for option in video_data.get("audio_options") or []:
        url = option.get("audio_url") if isinstance(option, dict) else None
        if isinstance(url, str) and url:
            yield url


def remember(video_data: Optional[dict]) -> None:
    """Record who resolved this video's URLs, from its `resolved_by` field."""
    if not isinstance(video_data, dict) or RESOLVED_BY_KEY not in video_data:
        return
    owner = video_data.get(RESOLVED_BY_KEY)
    owner = owner if isinstance(owner, str) and owner else None
    for url in stream_urls(video_data):
        key = _key(url)
        _owners.pop(key, None)
        _owners[key] = owner
    while len(_owners) > STREAM_OWNER_MAX_ENTRIES:
        _owners.popitem(last=False)


def owner_of(url: str) -> Optional[str]:
    """The identity whose cookies fetched this stream, if it is known at all."""
    return _owners.get(_key(url))


def is_known(url: str) -> bool:
    return _key(url) in _owners


def sanitize_client_video(video_data: dict, cached: Optional[dict]) -> None:
    """A client's copy of a video must not decide whose cookies are used.

    The resolving identity comes from the server's own cache entry for the
    same video, never from the message body — and only if the copy's stream
    URLs are the ones that resolve produced. A copy carrying other URLs
    under a known video's address would otherwise have those URLs fetched
    with the resolver's cookies.
    """
    video_data.pop(RESOLVED_BY_KEY, None)
    # Watch progress is the server's record of the room's own playback, never
    # something the message body gets to assert.
    video_data.pop("progress", None)
    if not cached or RESOLVED_BY_KEY not in cached:
        return
    if identities(video_data) <= identities(cached):
        video_data[RESOLVED_BY_KEY] = cached.get(RESOLVED_BY_KEY)
    else:
        logger.warning("Client copy of %s carries stream URLs the resolve did not produce; "
                       "it will be fetched without the resolver's cookies", video_data.get("original_url"))


def forget_all() -> None:
    _owners.clear()
