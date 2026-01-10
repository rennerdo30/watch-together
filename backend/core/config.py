"""
Core configuration and constants for the Watch Together backend.
"""
import os

# Cache configuration
CACHE_DIR = "data/cache"
COOKIES_DIR = "data/cookies"
MAX_CACHE_SIZE_BYTES = 200 * 1024 * 1024  # 200 MB
CACHE_TTL_SECONDS = 1800  # 30 minutes
MIN_DISK_FREE_BYTES = 500 * 1024 * 1024  # Keep at least 500MB free
MAX_CACHEABLE_FILE_BYTES = 50 * 1024 * 1024  # Don't cache files larger than 50MB

# Bucket cache configuration for position-aware caching
BUCKET_SIZE_BYTES = 3 * 1024 * 1024  # 3MB buckets (aligned with typical DASH segment size)

# In-memory cache configuration for hot segments
MEMORY_CACHE_SIZE_BYTES = 100 * 1024 * 1024  # 100 MB in-memory LRU cache
MEMORY_CACHE_MAX_ITEM_PERCENT = 0.25  # Don't cache items > 25% of max size

# Prefetch configuration
PREFETCH_VIDEO_COUNT = 3  # Number of video segments to prefetch
PREFETCH_AUDIO_COUNT = 5  # Number of audio segments to prefetch (more critical)
PREFETCH_SESSION_TTL = 300  # 5 minutes - cleanup inactive prefetch sessions

# Format cache configuration
FORMAT_CACHE_TTL_SECONDS = 7200  # 2 hours - YouTube URLs typically valid for 6 hours

# Ensure directories exist
for directory in [CACHE_DIR, COOKIES_DIR, "data", "data/yt_dlp_cache"]:
    if not os.path.exists(directory):
        os.makedirs(directory)
