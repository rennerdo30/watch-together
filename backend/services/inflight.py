"""
Fetches of exact byte spans that are under way right now.

A warm and a viewer often want the same bytes at nearly the same moment:
the read-ahead fetches the next subsegment, and the player asks for it a
beat later. Without this the request misses the cache — the warm has not
finished — and fetches the very same bytes from the CDN a second time,
racing the warm for the same link.

A request that finds its span inside one being fetched waits for that fetch
(bounded) and is then answered from memory. Only fetches whose result lands
in the memory cache register here; waiting on anything else would be a
delay with nothing at the end of it.
"""
import asyncio
import logging
import time
from contextlib import contextmanager
from typing import Dict, Iterator, List, Optional, Tuple

from core.config import INFLIGHT_MAX_AGE_SECONDS
from services.cache import get_segment_cache_key

logger = logging.getLogger(__name__)

# Stream-and-identity key -> spans being fetched: first byte, last byte, when
# the fetch started, and the future that resolves when its bytes are in the
# memory cache (or the fetch gave up).
_Span = Tuple[int, int, float, asyncio.Future]
_spans: Dict[str, List[_Span]] = {}


def _stream_key(url: str, cache_identity: Optional[str]) -> str:
    return get_segment_cache_key(url, 0, None, cache_identity)


@contextmanager
def fetching(url: str, start: int, end: int, cache_identity: Optional[str]) -> Iterator[None]:
    """Mark `start`-`end` of `url` as being fetched for the duration of the block."""
    key = _stream_key(url, cache_identity)
    future: asyncio.Future = asyncio.get_running_loop().create_future()
    entry = (start, end, time.monotonic(), future)
    _spans.setdefault(key, []).append(entry)
    try:
        yield
    finally:
        _drop(key, entry)
        if not future.done():
            future.set_result(None)


def _drop(key: str, entry: _Span) -> None:
    spans = _spans.get(key)
    if spans is not None and entry in spans:
        spans.remove(entry)
        if not spans:
            del _spans[key]


def _covering(url: str, start: int, end: int, cache_identity: Optional[str]) -> List[_Span]:
    """Live fetches that cover the span, forgetting any that outlived their age.

    A registration is released when its fetch ends, but a streamed response
    the server never got to send (the viewer left first) may never run the
    code that releases it; the age bound keeps such a leftover from
    swallowing warms of those bytes for good.
    """
    key = _stream_key(url, cache_identity)
    now = time.monotonic()
    live = []
    for entry in list(_spans.get(key, ())):
        first, last, started, future = entry
        if now - started > INFLIGHT_MAX_AGE_SECONDS:
            _drop(key, entry)
            if not future.done():
                future.set_result(None)
        elif first <= start and end <= last:
            live.append(entry)
    return live


def is_fetching(url: str, start: int, end: int, cache_identity: Optional[str]) -> bool:
    """Whether a fetch under way already covers this span."""
    return bool(_covering(url, start, end, cache_identity))


async def join(url: str, start: int, end: int, cache_identity: Optional[str],
               timeout: float) -> bool:
    """Wait for a fetch under way that covers this span.

    Returns True when one finished within `timeout` — the caller then looks
    in the cache again — and False when there was none to wait for or it
    took too long, in which case the caller fetches for itself.
    """
    futures = [future for _first, _last, _started, future in _covering(url, start, end, cache_identity)]
    if not futures:
        return False
    # Whichever covering fetch lands first answers; one that will never
    # finish (a leftover, see `_covering`) must not mask one that will.
    done, _pending = await asyncio.wait([asyncio.shield(f) for f in futures], timeout=timeout,
                                        return_when=asyncio.FIRST_COMPLETED)
    if not done:
        logger.info("Gave up waiting %.1fs for an in-flight fetch of %s", timeout, url[:60])
    return bool(done)


def count() -> int:
    """How many spans are being fetched (diagnostics and tests)."""
    return sum(len(spans) for spans in _spans.values())
