"""
When a signed stream URL stops being served.

A CDN hands out URLs that carry their own deadline: YouTube states it as
`expire=<unix seconds>` in the query (and, on some edges, as an `/expire/
<unix seconds>/` path segment), Twitch and others use `expires=`. Past that
moment every request for the URL is answered `403`, whoever asks and
whatever cookies it carries — the signature, not the session, is what has
run out.

That matters for anything fetched speculatively. A queue entry keeps the
resolve it was added with, and a room can sit on it for hours; probing its
renditions then is not a fetch that might fail, it is 14 guaranteed 403s
per attempt. The deadline is in the URL, so it can be read before a single
byte is requested, and an expired source re-resolved instead.
"""
import logging
import time
from typing import Optional
from urllib.parse import parse_qs, urlparse

from services.stream_owner import stream_urls

logger = logging.getLogger(__name__)

#: Query parameters a CDN states its deadline in, in order of preference.
EXPIRY_QUERY_PARAMS = ("expire", "expires")
#: Some googlevideo URLs carry it as `/expire/<unix seconds>/` instead.
EXPIRY_PATH_SEGMENT = "expire"
#: Below this, a value is not a unix timestamp (2001-09-09). Some CDNs put a
#: lifetime in seconds under the same name; treating "3600" as an absolute
#: time would declare every URL long dead.
MIN_PLAUSIBLE_EXPIRY_EPOCH = 1_000_000_000


def _timestamp(value: str) -> Optional[float]:
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return None
    return seconds if seconds >= MIN_PLAUSIBLE_EXPIRY_EPOCH else None


def expires_at(url: str) -> Optional[float]:
    """The unix time this URL stops being served, if it states one."""
    if not isinstance(url, str) or not url:
        return None
    parsed = urlparse(url)
    params = parse_qs(parsed.query)
    for name in EXPIRY_QUERY_PARAMS:
        for value in params.get(name, []):
            stamp = _timestamp(value)
            if stamp is not None:
                return stamp

    segments = parsed.path.split("/")
    for position, segment in enumerate(segments[:-1]):
        if segment == EXPIRY_PATH_SEGMENT:
            stamp = _timestamp(segments[position + 1])
            if stamp is not None:
                return stamp
    return None


def seconds_remaining(video_data: dict) -> Optional[float]:
    """How long the shortest-lived stream URL of a resolve has left.

    `None` when no URL states a deadline — a direct file, or a site that
    does not sign its URLs. Unknown is not expired: the caller fetches.
    """
    if not isinstance(video_data, dict):
        return None
    now = time.time()
    deadlines = [expires_at(url) for url in stream_urls(video_data)]
    stated = [deadline - now for deadline in deadlines if deadline is not None]
    return min(stated) if stated else None


def is_fresh(video_data: dict, min_seconds: float) -> bool:
    """Whether this resolve's URLs will still be served `min_seconds` from now."""
    remaining = seconds_remaining(video_data)
    return remaining is None or remaining >= min_seconds
