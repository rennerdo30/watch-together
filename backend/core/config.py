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
BUCKET_SIZE_BYTES = 10 * 1024 * 1024  # 10MB buckets

# Format cache configuration
FORMAT_CACHE_TTL_SECONDS = 7200  # 2 hours - YouTube URLs typically valid for 6 hours

# Ensure directories exist
for directory in [CACHE_DIR, COOKIES_DIR, "data", "data/yt_dlp_cache"]:
    if not os.path.exists(directory):
        os.makedirs(directory)
