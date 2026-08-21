"""
Byte-range requests against googlevideo.

googlevideo accepts a byte range two ways, and they are not equivalent.
A `Range` header goes through the progressive-playback path, which is
rate-limited to roughly what a player consuming in real time needs. The
`range=start-end` query parameter — what yt-dlp uses to fetch arbitrary
chunks — returns the same bytes as a plain 200 at full speed.

Measured on one 720p rendition, 1 MB at the same offset:

    Range header        206   ttfb  68 ms   total 122 ms    8.6 MB/s
    range query param   200   ttfb   9 ms   total  29 ms   36.4 MB/s

That gap barely shows during steady playback, where the buffer is already
ahead. It shows when the buffer is empty and has to be filled before
anything can be displayed — which is exactly a seek.
"""
import logging
from typing import NamedTuple, Optional
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse

from core.config import GVS_HOST_SUFFIX, GVS_MAX_RANGE_BYTES

logger = logging.getLogger(__name__)


class MediaRange(NamedTuple):
    """A range request rewritten for googlevideo.

    `url` carries the range as a query parameter and must be fetched
    *without* a Range header. The response is a 200 whose body is exactly
    the requested bytes, so the proxy synthesises the 206 it owes its own
    caller from `start`, `end` and `total`.
    """
    url: str
    start: int
    end: int
    total: int

    @property
    def content_range(self) -> str:
        return f"bytes {self.start}-{self.end}/{self.total}"

    @property
    def length(self) -> int:
        return self.end - self.start + 1


def _content_length(params: dict) -> Optional[int]:
    """The exact length of the file, which googlevideo states as `clen`."""
    values = params.get("clen")
    if not values:
        return None
    try:
        length = int(values[0])
    except (TypeError, ValueError):
        return None
    return length if length > 0 else None


def rewrite_range(url: str, range_start: int, range_end: Optional[int]) -> Optional[MediaRange]:
    """Move a byte range into googlevideo's `range` query parameter.

    Returns None when this does not apply — a different host, a URL with
    no declared length, or a range that falls outside the file — in which
    case the caller must fetch the URL unchanged with its Range header.
    Declining is always safe; guessing is not.
    """
    parsed = urlparse(url)
    hostname = (parsed.hostname or "").lower()
    if not hostname.endswith(GVS_HOST_SUFFIX):
        return None

    params = parse_qs(parsed.query)
    total = _content_length(params)
    if total is None:
        return None

    if range_start < 0 or range_start >= total:
        # Let the origin answer an unsatisfiable range itself rather than
        # inventing a response for it.
        return None

    if range_end is None:
        # An open-ended request would otherwise pull the rest of the file.
        # Capping it is legal: a 206 may return less than was asked for,
        # as long as its Content-Range says what it returned.
        end = min(range_start + GVS_MAX_RANGE_BYTES - 1, total - 1)
    else:
        end = min(range_end, total - 1)

    if end < range_start:
        return None

    params["range"] = [f"{range_start}-{end}"]
    rewritten = urlunparse(parsed._replace(query=urlencode(params, doseq=True)))
    return MediaRange(url=rewritten, start=range_start, end=end, total=total)
