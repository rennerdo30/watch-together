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
import aiofiles

from collections import OrderedDict

from core.config import (
    CACHE_DIR,
    MAX_CACHE_SIZE_BYTES,
    CACHE_TTL_SECONDS,
    MIN_DISK_FREE_BYTES,
    MAX_CACHEABLE_FILE_BYTES,
    BUCKET_SIZE_BYTES,
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
        # key -> (data, content_type, added_at)
        self._cache: OrderedDict[str, tuple[bytes, str, float]] = OrderedDict()
        self._current_size = 0
        self._max_size = max_size_bytes
        self._lock = asyncio.Lock()
        self._audio_keys: set[str] = set()  # Track audio segments for priority eviction
        self._hits = 0
        self._misses = 0

    async def get(self, key: str) -> tuple[bytes, str] | None:
        """
        Get item from cache.

        Returns (data, content_type) or None if not found.
        """
        async with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)  # LRU: move to end (most recently used)
                data, ctype, _ = self._cache[key]
                self._hits += 1
                return (data, ctype)
            self._misses += 1
        return None

    async def put(self, key: str, data: bytes, content_type: str, is_audio: bool = False):
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
                old_data, _, _ = self._cache.pop(key)
                self._current_size -= len(old_data)
                self._audio_keys.discard(key)

            # Evict until we have space
            while self._current_size + len(data) > self._max_size and self._cache:
                # First try to evict non-audio segments (LRU order)
                evicted = False
                for old_key in list(self._cache.keys()):
                    if old_key not in self._audio_keys:
                        old_data, _, _ = self._cache.pop(old_key)
                        self._current_size -= len(old_data)
                        evicted = True
                        logger.debug(f"Evicted video segment from memory cache: {old_key[:40]}...")
                        break

                if not evicted and self._cache:
                    # All items are audio, evict oldest audio (least recently used)
                    old_key, (old_data, _, _) = self._cache.popitem(last=False)
                    self._current_size -= len(old_data)
                    self._audio_keys.discard(old_key)
                    logger.debug(f"Evicted audio segment from memory cache: {old_key[:40]}...")

            # Add new item
            self._cache[key] = (data, content_type, time.time())
            self._current_size += len(data)
            if is_audio:
                self._audio_keys.add(key)

    async def remove(self, key: str) -> bool:
        """Remove item from cache. Returns True if item was removed."""
        async with self._lock:
            if key in self._cache:
                data, _, _ = self._cache.pop(key)
                self._current_size -= len(data)
                self._audio_keys.discard(key)
                return True
        return False

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


def get_segment_cache_key(url: str, range_start: int = 0) -> str:
    """
    Generate a cache key for a segment.

    Uses SHA-256 hash of URL with range start position.
    """
    url_hash = hashlib.sha256(url.encode()).hexdigest()[:24]
    return f"seg_{url_hash}_{range_start}"


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

# In-flight request tracking for deduplication
# Maps URL to (asyncio.Event, bytes | None, error | None)
_in_flight_requests: Dict[str, asyncio.Event] = {}
_in_flight_results: Dict[str, Tuple[Optional[bytes], Optional[Exception]]] = {}
_in_flight_lock = asyncio.Lock()


async def get_or_fetch_segment(url: str, fetch_fn) -> bytes:
    """
    Coalesce concurrent requests for the same URL.
    
    If a request for this URL is already in-flight, wait for it to complete
    and return the same result. This prevents multiple downloads of the same
    segment when multiple clients request it simultaneously.
    """
    async with _in_flight_lock:
        if url in _in_flight_requests:
            # Another request is already fetching this URL
            logger.info(f"COALESCE: Waiting for in-flight request: {url[:60]}...")
            event = _in_flight_requests[url]
        else:
            # We're the first - create event and register
            event = asyncio.Event()
            _in_flight_requests[url] = event
            event = None  # Signal that we're the fetcher
    
    if event is not None:
        # Wait for the other request to complete (with timeout to prevent hanging)
        try:
            await asyncio.wait_for(event.wait(), timeout=60.0)
        except asyncio.TimeoutError:
            logger.warning(f"In-flight request wait timed out: {url[:60]}...")
            raise Exception("Timed out waiting for in-flight request")
        result_data, result_error = _in_flight_results.get(url, (None, None))
        if result_error:
            raise result_error
        if result_data is None:
            raise Exception("In-flight request returned no data")
        return result_data
    
    # We're the fetcher
    try:
        data = await fetch_fn()
        _in_flight_results[url] = (data, None)
        return data
    except Exception as e:
        _in_flight_results[url] = (None, e)
        raise
    finally:
        # Signal waiters and cleanup
        async with _in_flight_lock:
            if url in _in_flight_requests:
                _in_flight_requests[url].set()
                del _in_flight_requests[url]
            # Schedule cleanup of result after short delay
            asyncio.create_task(_cleanup_in_flight_result(url))


async def _cleanup_in_flight_result(url: str, delay: float = 5.0):
    """Clean up in-flight result after a short delay."""
    await asyncio.sleep(delay)
    _in_flight_results.pop(url, None)


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


def get_bucket_for_position(byte_pos: int) -> int:
    """Get the bucket number for a byte position."""
    return byte_pos // BUCKET_SIZE_BYTES


def get_bucket_cache_key(url: str, bucket_num: int) -> Tuple[str, str]:
    """Get cache key and path for a bucket.

    Uses SHA-256 for better collision resistance and includes full URL in hash.
    DASH video and audio URLs have different itag parameters so they won't collide.
    """
    # Use SHA-256 with 24 char prefix for better collision resistance
    url_hash = hashlib.sha256(url.encode()).hexdigest()[:24]
    cache_key = f"bucket_{url_hash}_{bucket_num}"
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


def get_current_cache_size() -> int:
    """Get total size of cached files in bytes."""
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
                    if f.endswith(".tmp"):  # Clean up stale temp files
                        path = os.path.join(CACHE_DIR, f)
                        if current_time - os.path.getmtime(path) > 3600:
                            os.remove(path)
                        continue
                        
                    path = os.path.join(CACHE_DIR, f)
                    if not os.path.isfile(path):
                        continue
                        
                    stat = os.stat(path)

                    # Extract URL hash from filename for adaptive TTL
                    # Filename format: bucket_<hash>_<num> or seg_<hash>_<pos>
                    url_hash = None
                    if f.startswith('bucket_') or f.startswith('seg_'):
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
