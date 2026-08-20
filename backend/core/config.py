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

# PO token provider (bgutil) for YouTube.
#
# The bgutil yt-dlp plugin reads its address from the
# `youtubepot-bgutilhttp:base_url` extractor arg and otherwise defaults to
# 127.0.0.1:4416 — which is nothing inside the backend container, where the
# provider is a separate service. It must be passed explicitly.
POT_PROVIDER_URL = os.environ.get(
    "BGUTIL_YTDLP_POT_PROVIDER_URL", "http://127.0.0.1:4416")

# Extractor args every YouTube extraction needs so the provider is reachable.
POT_PROVIDER_EXTRACTOR_ARGS = {
    "youtubepot-bgutilhttp": {"base_url": [POT_PROVIDER_URL]},
}

# Cookie files hold live session credentials: owner read/write only.
COOKIE_FILE_MODE = 0o600

# Rate limiting for upload endpoints
RATE_LIMIT_WINDOW_SECONDS = 60.0
RATE_LIMIT_MAX_REQUESTS = 10  # Uploads allowed per user per window
RATE_LIMIT_STORE_MAX_KEYS = 1000  # Counters kept before stale ones are pruned

# Renditions offered to the player, spanning the quality range. Each one
# costs a small range request to probe once per video, so the cap trades
# choice against startup work. It has to be generous enough to include the
# low rungs: a viewer on a slow link needs 360p more than a fourth 1080p.
QUALITY_LADDER_SIZE = 10

# DASH manifest generation
MANIFEST_PROBE_BYTES = 64 * 1024  # Prefix read to locate ftyp/moov/sidx
MANIFEST_INDEX_CACHE_TTL_SECONDS = 7200  # Byte ranges are stable per rendition
MANIFEST_INDEX_CACHE_MAX_ENTRIES = 500
MANIFEST_MIN_BANDWIDTH = 1000  # Floor so a manifest never declares 0 bps
MANIFEST_MAX_VIDEO_REPRESENTATIONS = 10  # Renditions offered for adaptive switching
MANIFEST_MAX_AUDIO_REPRESENTATIONS = 2

# Per-user cookie jar caching for upstream fetches
COOKIE_JAR_CACHE_TTL_SECONDS = 60  # Re-read a user's cookie file at most this often
COOKIE_JAR_CACHE_MAX_USERS = 50  # Parsed jars kept in memory

# Upstream fetching (media proxy) limits
UPSTREAM_MAX_REDIRECTS = 3  # Redirect hops followed, each one re-validated
UPSTREAM_ALLOWED_SCHEMES = ("http", "https")
UPSTREAM_ALLOWED_PORTS = (80, 443, 8080, 8443)

# Cloudflare Access authentication
# Team domain, e.g. "https://example.cloudflareaccess.com", and the
# Access application's AUD tag. Both are required to verify assertions;
# when unset the backend falls back to trusting the identity header and
# logs a warning at startup.
CF_ACCESS_TEAM_DOMAIN = os.environ.get("CF_ACCESS_TEAM_DOMAIN", "")
CF_ACCESS_AUD = os.environ.get("CF_ACCESS_AUD", "")
CF_ACCESS_JWKS_CACHE_SECONDS = 3600  # Refresh signing keys hourly
CF_ACCESS_JWKS_TIMEOUT_SECONDS = 5  # Network timeout fetching signing keys
CF_ACCESS_ALGORITHMS = ("RS256",)  # Algorithms Cloudflare Access signs with

# Proxy metrics configuration
METRICS_SAMPLE_CAPACITY = 500  # Recent proxy transfers kept in the ring buffer
METRICS_SLOW_UPSTREAM_MS = 5000  # Upstream fetches slower than this are counted
METRICS_DEFAULT_SAMPLE_LIMIT = 50  # Samples returned by the metrics endpoint

# Ensure directories exist
for directory in [CACHE_DIR, COOKIES_DIR, "data", "data/yt_dlp_cache"]:
    if not os.path.exists(directory):
        os.makedirs(directory)
