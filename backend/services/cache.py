"""
Caching services for video formats and segments.
"""
import os
import time
import hashlib
import shutil
import asyncio
import logging
import json
from typing import Dict, Tuple, Optional
from urllib.parse import urlparse, parse_qs
import aiofiles

from collections import OrderedDict

from core.config import (
    CACHE_DIR,
    MAX_CACHE_SIZE_BYTES,
    CACHE_TTL_SECONDS,
    MIN_DISK_FREE_BYTES,
    MAX_CACHEABLE_FILE_BYTES,
    CACHE_SIZE_MEASURE_TTL_SECONDS,
    CACHE_EVICTION_BATCH_BYTES,
    STALE_TEMP_FILE_SECONDS,
    FORMAT_CACHE_TTL_SECONDS,
    MEMORY_CACHE_SIZE_BYTES,
    MEMORY_CACHE_MAX_ITEM_PERCENT,
)

logger = logging.getLogger(__name__)


# ============================================================================
# In-Memory LRU Cache with Audio Priority
# ============================================================================

class MemoryCache:
    """
    LRU in-memory cache for hot video/audio segments.

    Features:
    - Configurable max size (default 100 MB)
    - Audio priority eviction (audio segments evicted last)
    - Async-safe with asyncio.Lock
    - O(1) get/put operations using OrderedDict
    """

    def __init__(self, max_size_bytes: int = MEMORY_CACHE_SIZE_BYTES):
        # key -> (data, content_type, content_range, added_at)
        # content_range is the upstream's Content-Range for a partial body.
        # A 206 must reproduce it exactly: returning a cached body under a
        # different range makes the response self-contradictory, which the
        # player rejects ("payload length does not match range requested").
        self._cache: OrderedDict[str, tuple[bytes, str, str | None, float]] = OrderedDict()
        self._current_size = 0
        self._max_size = max_size_bytes
        self._lock = asyncio.Lock()
        self._audio_keys: set[str] = set()  # Track audio segments for priority eviction
        self._hits = 0
        self._misses = 0

    async def get(self, key: str) -> tuple[bytes, str, str | None] | None:
        """
        Get item from cache.

        Returns (data, content_type, content_range) or None if not found.
        """
        async with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)  # LRU: move to end (most recently used)
                data, ctype, crange, _ = self._cache[key]
                self._hits += 1
                return (data, ctype, crange)
            self._misses += 1
        return None

    async def put(self, key: str, data: bytes, content_type: str, is_audio: bool = False,
                  content_range: str | None = None):
        """
        Add item to cache, evicting LRU items if needed.

        Audio segments are protected from early eviction.
        Items larger than 25% of max cache size are not cached.
        """
        # Don't cache items that are too large
        max_item_size = int(self._max_size * MEMORY_CACHE_MAX_ITEM_PERCENT)
        if len(data) > max_item_size:
            logger.debug(f"Item too large for memory cache: {len(data)} > {max_item_size}")
            return

        async with self._lock:
            # If key exists, remove old data first
            if key in self._cache:
                old_data, _, _, _ = self._cache.pop(key)
                self._current_size -= len(old_data)
                self._audio_keys.discard(key)

            # Evict until we have space
            while self._current_size + len(data) > self._max_size and self._cache:
                # First try to evict non-audio segments (LRU order)
                evicted = False
                for old_key in list(self._cache.keys()):
                    if old_key not in self._audio_keys:
                        old_data, _, _, _ = self._cache.pop(old_key)
                        self._current_size -= len(old_data)
                        evicted = True
                        logger.debug(f"Evicted video segment from memory cache: {old_key[:40]}...")
                        break

                if not evicted and self._cache:
                    # All items are audio, evict oldest audio (least recently used)
                    old_key, (old_data, _, _, _) = self._cache.popitem(last=False)
                    self._current_size -= len(old_data)
                    self._audio_keys.discard(old_key)
                    logger.debug(f"Evicted audio segment from memory cache: {old_key[:40]}...")

            # Add new item
            self._cache[key] = (data, content_type, content_range, time.time())
            self._current_size += len(data)
            if is_audio:
                self._audio_keys.add(key)

    async def remove(self, key: str) -> bool:
        """Remove item from cache. Returns True if item was removed."""
        async with self._lock:
            if key in self._cache:
                data, _, _, _ = self._cache.pop(key)
                self._current_size -= len(data)
                self._audio_keys.discard(key)
                return True
        return False

    async def clear(self) -> None:
        """Drop every entry. Used on shutdown and by tests exercising the
        disk tier, which only answers what memory no longer holds."""
        async with self._lock:
            self._cache.clear()
            self._audio_keys.clear()
            self._current_size = 0

    def get_stats(self) -> dict:
        """Get cache statistics."""
        total_requests = self._hits + self._misses
        hit_rate = (self._hits / total_requests * 100) if total_requests > 0 else 0
        return {
            "items": len(self._cache),
            "size_mb": round(self._current_size / 1024 / 1024, 2),
            "max_mb": round(self._max_size / 1024 / 1024, 2),
            "audio_items": len(self._audio_keys),
            "hits": self._hits,
            "misses": self._misses,
            "hit_rate_percent": round(hit_rate, 1),
        }


# Global memory cache instance
memory_cache = MemoryCache()


# Query parameters that identify *which* rendition a URL addresses, as
# opposed to the signing parameters that rotate on every resolution.
_STREAM_IDENTITY_PARAMS = ("itag", "clen", "lmt", "mime")


def stream_identity(url: str) -> str:
    """Identity of the bytes a URL addresses, ignoring the parts that rotate.

    Signed CDN URLs carry expiry and token parameters that change on every
    resolution while addressing exactly the same bytes. Keying a cache on
    the raw URL therefore throws the whole cache away each time a room
    refreshes its stream URLs — which is every few minutes for YouTube — so
    nothing is ever served twice however long it is kept.

    The path alone is not enough either: every YouTube rendition lives at
    /videoplayback and is told apart only by its query. `itag` names the
    format, and `clen` + `lmt` (exact length and transcode timestamp in
    microseconds) pin it to one specific file.

    The host is deliberately excluded: the same rendition served from a
    different edge is byte-identical.
    """
    parsed = urlparse(url)
    params = parse_qs(parsed.query)
    identity = [
        f"{name}={params[name][0]}"
        for name in _STREAM_IDENTITY_PARAMS
        if params.get(name)
    ]
    if not identity:
        # Nothing stable to key on. Correctness beats cache hits.
        return url
    return f"{parsed.path}?{'&'.join(identity)}"


def get_segment_cache_key(url: str, range_start: int = 0, range_end: int = None,
                          identity: str = None) -> str:
    """
    Generate a cache key for a segment.

    The key covers the whole requested range, not just its start. Keying on
    the start alone let a body cached for one range answer a request for a
    different one, and a 206 whose body does not match the requested range
    is rejected by players and by intermediaries.

    `identity` is set when the fetch carried a specific user's cookies,
    which keeps authenticated content out of the shared, anonymous entries.
    """
    url_hash = hashlib.sha256(stream_identity(url).encode()).hexdigest()[:24]
    span = f"{range_start}-{'' if range_end is None else range_end}"
    key = f"seg_{url_hash}_{span}"
    if identity:
        identity_hash = hashlib.sha256(identity.encode()).hexdigest()[:16]
        key = f"{key}_u{identity_hash}"
    return key


def is_audio_url(url: str) -> bool:
    """Check if URL is for an audio segment."""
    url_lower = url.lower()
    # YouTube audio itags
    audio_itags = ['itag=140', 'itag=251', 'itag=250', 'itag=249', 'itag=139']
    if any(itag in url_lower for itag in audio_itags):
        return True
    # Generic audio indicators
    if '/audio/' in url_lower or 'audio' in url_lower.split('/')[-1]:
        return True
    return False


# ============================================================================
# Active Content Tracking for Adaptive TTL
# ============================================================================

_active_content: Dict[str, float] = {}
_active_content_lock = asyncio.Lock()


async def mark_content_active(url_hash: str):
    """Mark content as actively being watched."""
    async with _active_content_lock:
        _active_content[url_hash] = time.time()


def is_content_active(url_hash: str) -> bool:
    """Check if content was accessed in last 5 minutes."""
    if url_hash not in _active_content:
        return False
    return time.time() - _active_content[url_hash] < 300


async def cleanup_active_content():
    """Remove stale entries from active content tracking."""
    async with _active_content_lock:
        now = time.time()
        stale = [k for k, v in _active_content.items() if now - v > 300]
        for k in stale:
            del _active_content[k]

# Format cache - stores resolved video formats in memory
_format_cache: Dict[str, Tuple[dict, float]] = {}

def make_room(needed_bytes: int) -> bool:
    """Evict oldest entries until `needed_bytes` fits inside the budget.

    The write path used to simply stop caching once the budget was
    reached, which is not what a cache does: the first entries to arrive
    held the space forever and everything afterwards went uncached until
    the janitor's next sweep trimmed back to exactly the limit. Measured
    in production, that left 37 writes across 5179 transfers.

    Eviction frees a whole batch rather than just enough for this one
    body, so the directory scan is amortised over many writes instead of
    repeating for every segment.
    """
    if needed_bytes > MAX_CACHE_SIZE_BYTES:
        return False

    size = get_current_cache_size()
    if size + needed_bytes <= MAX_CACHE_SIZE_BYTES:
        # Reserve the space. Writes land far faster than the measurement is
        # refreshed, so without this every caller inside one measurement
        # window sees the same stale total and the budget is never reached.
        # Over-counting an aborted write only evicts a little early, and the
        # janitor's own scan corrects the figure.
        _publish_cache_size(size + needed_bytes)
        return True

    target = MAX_CACHE_SIZE_BYTES - max(needed_bytes, CACHE_EVICTION_BATCH_BYTES)
    entries = []
    try:
        for name in os.listdir(CACHE_DIR):
            if name.endswith('.meta') or name.endswith('.tmp'):
                continue
            path = os.path.join(CACHE_DIR, name)
            try:
                stat = os.stat(path)
            except OSError:
                continue
            if os.path.isfile(path):
                entries.append((stat.st_mtime, stat.st_size, path))
    except OSError as exc:
        logger.warning(f"Could not scan the cache to make room: {exc}")
        return False

    entries.sort(key=lambda entry: entry[0])
    freed = 0
    evicted = 0
    for _mtime, entry_size, path in entries:
        if size - freed <= target:
            break
        try:
            os.remove(path)
            # The sidecar goes with its body; either half alone is unusable
            # and still occupies the budget.
            meta = path + '.meta'
            if os.path.exists(meta):
                os.remove(meta)
            freed += entry_size
            evicted += 1
        except OSError:
            continue

    remaining = max(0, size - freed)
    if evicted:
        logger.info(
            f"Evicted {evicted} cache entries ({freed / 1024 / 1024:.1f} MB) "
            f"to make room")
    if remaining + needed_bytes > MAX_CACHE_SIZE_BYTES:
        _publish_cache_size(remaining)
        return False
    _publish_cache_size(remaining + needed_bytes)
    return True


def parse_range_header(range_header: str) -> Tuple[int, int | None]:
    """Parse Range header like 'bytes=12345-' or 'bytes=12345-67890' returning (start, end)."""
    if not range_header or not range_header.startswith("bytes="):
        return (0, None)
    try:
        range_spec = range_header[6:]  # Remove 'bytes='
        if '-' in range_spec:
            parts = range_spec.split('-')
            start = int(parts[0]) if parts[0] else 0
            end = int(parts[1]) if parts[1] else None
            return (start, end)
    except (ValueError, IndexError):
        pass
    return (0, None)


def get_segment_disk_key(url: str, range_start: int = 0, range_end: int = None,
                         identity: str = None) -> Tuple[str, str]:
    """Cache key and path for one exact byte range on disk.

    Keyed by the whole requested range, like the memory cache. It used to be
    keyed by a position bucket, which could not answer an arbitrary range:
    a hit streamed from an offset to the end of its bucket, so the body did
    not match the request and the response had no Content-Range to describe
    it. Ranged requests had to bypass it entirely, which meant no persistent
    caching at all for adaptive playback — every request is ranged.

    `identity` separates content fetched with a specific user's cookies from
    the shared anonymous entries.
    """
    url_hash = hashlib.sha256(stream_identity(url).encode()).hexdigest()[:24]
    span = f"{range_start}-{'' if range_end is None else range_end}"
    cache_key = f"seg_{url_hash}_{span}"
    if identity:
        identity_hash = hashlib.sha256(identity.encode()).hexdigest()[:16]
        cache_key = f"{cache_key}_u{identity_hash}"
    cache_path = os.path.join(CACHE_DIR, cache_key)
    return cache_key, cache_path


def check_disk_space() -> tuple[bool, int]:
    """
    Check if there's enough disk space for caching.
    Returns (ok_to_cache, free_bytes).
    """
    try:
        usage = shutil.disk_usage(CACHE_DIR)
        free_bytes = usage.free
        ok_to_cache = free_bytes > MIN_DISK_FREE_BYTES
        return ok_to_cache, free_bytes
    except Exception as e:
        logger.error(f"Failed to check disk space: {e}")
        return False, 0


# Last measured cache size, as (bytes, measured_at).
_cache_size_measurement: Tuple[int, float] = (0, 0.0)


def measure_cache_size() -> int:
    """Total size of cached bodies in bytes, by scanning the directory."""
    total = 0
    try:
        if os.path.exists(CACHE_DIR):
            for f in os.listdir(CACHE_DIR):
                path = os.path.join(CACHE_DIR, f)
                if os.path.isfile(path) and not f.endswith('.tmp') and not f.endswith('.meta'):
                    total += os.path.getsize(path)
    except Exception as e:
        logger.error(f"Failed to get cache size: {e}")
    return total


def _publish_cache_size(size: int) -> None:
    """Record an authoritative measurement for the proxy to read."""
    global _cache_size_measurement
    _cache_size_measurement = (size, time.time())


def release_room(reserved_bytes: int) -> None:
    """Return a reservation made by `make_room` for a write that never landed.

    Seeking cancels transfers constantly, and each cancelled write removes
    its temp file but — without this — kept its reservation. Because every
    publish refreshes the measurement's timestamp, a busy session never
    re-measures, so phantom reservations only accumulate; enough seeking
    filled the whole budget with them and caching refused again until the
    janitor's sweep. That is the very failure eviction was added to remove.

    If a fresh scan happened between reserve and release, releasing
    under-counts slightly; that only evicts a little late, and the
    janitor's authoritative scan corrects it.
    """
    if reserved_bytes <= 0:
        return
    size, _measured_at = _cache_size_measurement
    _publish_cache_size(max(0, size - reserved_bytes))


def get_current_cache_size(max_age_seconds: float = CACHE_SIZE_MEASURE_TTL_SECONDS) -> int:
    """Cache size, re-measured at most every `max_age_seconds`.

    This is consulted on every proxied request, and measuring means
    stat-ing every file in the cache directory — thousands of them once the
    cache is warm. The only writers are the proxy and the janitor, so a
    slightly stale figure just means the budget is enforced a few seconds
    late. Pass 0 to force a fresh measurement.
    """
    size, measured_at = _cache_size_measurement
    now = time.time()
    if max_age_seconds > 0 and now - measured_at < max_age_seconds:
        return size
    size = measure_cache_size()
    _publish_cache_size(size)
    return size


async def cache_cleanup_task():
    """
    Background task to enforce cache limits (size and TTL).
    """
    # Import cleanup from database to run it periodically
    from services.database import cleanup_expired_format_cache
    
    while True:
        await asyncio.sleep(120)  # Run every 2 minutes
        try:
            current_time = time.time()
            total_size = 0
            files = []

            # 1. Scan files and remove expired
            if os.path.exists(CACHE_DIR):
                for f in os.listdir(CACHE_DIR):
                    path = os.path.join(CACHE_DIR, f)

                    if f.endswith(".tmp"):  # Clean up stale temp files
                        if current_time - os.path.getmtime(path) > STALE_TEMP_FILE_SECONDS:
                            os.remove(path)
                            logger.info(f"Removed abandoned partial download: {f}")
                        continue

                    # Sidecars are handled with the body they describe, never
                    # on their own: expiring or evicting one half leaves an
                    # entry that can never be served but still takes space.
                    if f.endswith(".meta"):
                        if not os.path.exists(path[:-len(".meta")]):
                            os.remove(path)
                            logger.info(f"Removed orphaned cache metadata: {f}")
                        continue

                    if not os.path.isfile(path):
                        continue

                    stat = os.stat(path)

                    # A body whose metadata is gone cannot describe its own
                    # range, so the read path will not use it.
                    if not os.path.exists(path + ".meta"):
                        os.remove(path)
                        logger.info(f"Removed cache body with no metadata: {f}")
                        continue

                    # Extract URL hash from filename for adaptive TTL.
                    # Filename format: seg_<hash>_<range>[_u<identity>]
                    url_hash = None
                    if f.startswith('seg_'):
                        parts = f.split('_')
                        if len(parts) >= 2:
                            url_hash = parts[1]

                    # Adaptive TTL: double TTL for actively watched content
                    effective_ttl = CACHE_TTL_SECONDS
                    if url_hash and is_content_active(url_hash):
                        effective_ttl = CACHE_TTL_SECONDS * 2

                    # Remove if older than effective TTL
                    if current_time - stat.st_mtime > effective_ttl:
                        os.remove(path)
                        logger.info(f"Removed expired cache file: {f}")
                        if os.path.exists(path + ".meta"):
                            os.remove(path + ".meta")
                    else:
                        files.append((stat.st_mtime, stat.st_size, path))
                        total_size += stat.st_size

            # 2. Enforce size limit (LRU-ish: delete oldest mtime)
            if total_size > MAX_CACHE_SIZE_BYTES:
                files.sort(key=lambda x: x[0])
                
                bytes_to_free = total_size - MAX_CACHE_SIZE_BYTES
                freed = 0
                
                for _, size, path in files:
                    if freed >= bytes_to_free:
                        break
                    
                    try:
                        os.remove(path)
                        freed += size
                        if os.path.exists(path + ".meta"):
                            os.remove(path + ".meta")
                        logger.info(f"Evicted cache file: {os.path.basename(path)}")
                    except OSError:
                        pass
                
                logger.info(f"Cache cleanup freed {freed / 1024 / 1024:.2f} MB")
                total_size -= freed

            # This scan is authoritative and just finished, so publish it
            # rather than leaving the proxy to re-measure. Getting it wrong
            # in the pessimistic direction stops caching entirely until the
            # next sweep.
            _publish_cache_size(total_size)

            # Clean expired format cache entries in DB
            cleaned = await cleanup_expired_format_cache()
            if cleaned:
                logger.info(f"Cleaned {cleaned} expired format cache entries from DB")

            # Clean stale active content tracking entries
            await cleanup_active_content()

            # Log memory cache stats periodically
            stats = memory_cache.get_stats()
            if stats["items"] > 0:
                logger.info(f"Memory cache: {stats['items']} items, {stats['size_mb']} MB, "
                           f"{stats['hit_rate_percent']}% hit rate")

        except Exception as e:
            logger.error(f"Error in cache cleanup task: {e}")
