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

from core.config import (
    CACHE_DIR,
    MAX_CACHE_SIZE_BYTES,
    CACHE_TTL_SECONDS,
    MIN_DISK_FREE_BYTES,
    MAX_CACHEABLE_FILE_BYTES,
    BUCKET_SIZE_BYTES,
    FORMAT_CACHE_TTL_SECONDS,
)

logger = logging.getLogger(__name__)

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
        # Wait for the other request to complete
        await event.wait()
        result_data, result_error = _in_flight_results.get(url, (None, None))
        if result_error:
            raise result_error
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
    """Get cache key and path for a bucket."""
    url_hash = hashlib.md5(url.encode()).hexdigest()[:16]
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
                    
                    # Remove if older than TTL
                    if current_time - stat.st_mtime > CACHE_TTL_SECONDS:
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
                
        except Exception as e:
            logger.error(f"Error in cache cleanup task: {e}")
