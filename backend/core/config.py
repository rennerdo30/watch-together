"""
Core configuration and constants for the Watch Together backend.
"""
import os

# Cache configuration
CACHE_DIR = "data/cache"
COOKIES_DIR = "data/cookies"
# yt-dlp's own cache (player JS, signature timestamps). Kept on the data
# volume so a container rebuild does not force it to re-fetch everything.
YTDLP_CACHE_DIR = "data/yt_dlp_cache"
# Segment cache budget. Once it is reached, nothing new is cached at all
# until the janitor evicts — so a budget smaller than a viewing session
# silently turns caching off partway through. An hour of 1080p is a couple
# of GB; `MIN_DISK_FREE_BYTES` is the real safety floor.
MAX_CACHE_SIZE_GB = float(os.environ.get("MAX_CACHE_SIZE_GB", "4"))
MAX_CACHE_SIZE_BYTES = int(MAX_CACHE_SIZE_GB * 1024 * 1024 * 1024)
# Segment bodies are immutable and keyed on the rendition's stable identity,
# so an entry stays valid for as long as it is worth keeping. The size cap
# above is what actually bounds the cache; this only expires cold content.
CACHE_TTL_SECONDS = 21600  # 6 hours
MIN_DISK_FREE_BYTES = 500 * 1024 * 1024  # Keep at least 500MB free
MAX_CACHEABLE_FILE_BYTES = 50 * 1024 * 1024  # Don't cache files larger than 50MB
# A partial download left by a crash or a client that vanished mid-body. It
# can never be completed, so it is removed once no writer could still own it.
STALE_TEMP_FILE_SECONDS = 3600
# How long a measured cache size may be reused. The size is consulted on
# every proxied request and measuring it means scanning the whole cache
# directory, which is thousands of files once the cache is warm.
CACHE_SIZE_MEASURE_TTL_SECONDS = 10
# How much a full cache frees in one pass. Evicting only enough for the body
# in hand would rescan the directory for every segment; freeing a batch
# amortises that over many writes.
CACHE_EVICTION_BATCH_BYTES = MAX_CACHE_SIZE_BYTES // 10

# googlevideo byte ranges. A `Range` header is served through the throttled
# progressive path; the `range=` query parameter returns the same bytes at
# full speed, which is what yt-dlp uses. See services/gvs_range.py.
GVS_HOST_SUFFIX = ".googlevideo.com"
# Cap for a range request with no end. yt-dlp fetches in chunks of the same
# size, and an uncapped request would pull the rest of the file.
GVS_MAX_RANGE_BYTES = 10 * 1024 * 1024

# In-memory cache configuration for hot segments
MEMORY_CACHE_SIZE_BYTES = 256 * 1024 * 1024  # 256 MB in-memory LRU cache
MEMORY_CACHE_MAX_ITEM_PERCENT = 0.25  # Don't cache items > 25% of max size

# Prefetch configuration
PREFETCH_VIDEO_COUNT = 3  # Number of video segments to prefetch
PREFETCH_AUDIO_COUNT = 5  # Number of audio segments to prefetch (more critical)
PREFETCH_SESSION_TTL = 300  # 5 minutes - cleanup inactive prefetch sessions

# Format cache configuration
FORMAT_CACHE_TTL_SECONDS = 7200  # 2 hours - YouTube URLs typically valid for 6 hours
# Live streams get a much shorter entry. A live playlist URL carries a signed
# token with its own expiry (Twitch usher tokens died mid-session in
# production, turning every proxied fetch into a 403), and a cached live
# format keeps handing that dead URL to every viewer who re-resolves. Five
# minutes still deduplicates the resolve fan-out when a room full of members
# receives the same set_video broadcast.
FORMAT_CACHE_LIVE_TTL_SECONDS = 300

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

# Rungs kept per codec family. A player commits to one codec for the
# session, so each family needs a complete ladder of its own — a budget
# shared across codecs leaves the chosen one with gaps and nothing to drop
# to. Each rendition costs one small range request to probe, cached for
# hours afterwards.
QUALITY_LADDER_SIZE = 8

# Stream URL -> resolving member, kept in memory so the proxy can attach the
# right cookies without a database read per segment. Each video registers
# its whole quality ladder, so this covers a few hundred videos.
STREAM_OWNER_MAX_ENTRIES = 20_000

# Seek-bar preview thumbnails. yt-dlp lists YouTube's storyboards as
# `sb<n>` formats at a few sizes; the sheet closest to this frame width is
# sent to the client (the smallest sheets are too blurry, the largest are
# several megabytes each).
STORYBOARD_PREFERRED_FRAME_WIDTH = 320

# DASH manifest generation
MANIFEST_PROBE_BYTES = 64 * 1024  # Prefix read to locate ftyp/moov/sidx
# Ceiling for a re-probe once a `sidx` header states its real size. A segment
# index carries 12 bytes per segment, so a multi-hour VOD outgrows the prefix
# above — 101 KB at 12 hours, 159 KB at 19. This bounds what a URL can make the
# server hold: the declared size comes from the remote file, not from us.
MANIFEST_MAX_INDEX_BYTES = 4 * 1024 * 1024
MANIFEST_INDEX_CACHE_TTL_SECONDS = 7200  # Byte ranges are stable per rendition
MANIFEST_INDEX_CACHE_MAX_ENTRIES = 500
MANIFEST_MIN_BANDWIDTH = 1000  # Floor so a manifest never declares 0 bps
MANIFEST_MAX_VIDEO_REPRESENTATIONS = 24  # Room for a full ladder per codec family
MANIFEST_MAX_AUDIO_REPRESENTATIONS = 2

# Per-user cookie jar caching for upstream fetches
COOKIE_JAR_CACHE_TTL_SECONDS = 60  # Re-read a user's cookie file at most this often
COOKIE_JAR_CACHE_MAX_USERS = 50  # Parsed jars kept in memory

# Upstream fetching (media proxy) limits
UPSTREAM_MAX_REDIRECTS = 3  # Redirect hops followed, each one re-validated
UPSTREAM_ALLOWED_SCHEMES = ("http", "https")
UPSTREAM_ALLOWED_PORTS = (80, 443, 8080, 8443)

# Admin panel access. Comma-separated list of verified identities allowed to
# call /api/admin. Empty (the default) disables the panel entirely — no
# identity matches — so granting access is always an explicit deployment
# decision rather than a value baked into the repo.
ADMIN_EMAILS = frozenset(
    email.strip().lower()
    for email in os.environ.get("ADMIN_EMAILS", "").split(",")
    if email.strip()
)
# How much detail the cache inspection returns per request.
ADMIN_SEGMENT_LIST_LIMIT = 50   # Newest segment cache entries listed
ADMIN_PROXY_SAMPLE_LIMIT = 20   # Recent proxy transfer samples included

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

# SponsorBlock (https://sponsor.ajay.app): community-submitted segments to
# skip in YouTube videos. Looked up per video with the privacy-preserving
# hash-prefix endpoint, so the server never tells SponsorBlock which video a
# room is watching. The URL is overridable so tests can point at a stub.
SPONSORBLOCK_API_URL = os.environ.get("SPONSORBLOCK_API_URL", "https://sponsor.ajay.app")
SPONSORBLOCK_HASH_PREFIX_LENGTH = 4  # Hex characters of the video id's SHA-256 sent upstream
SPONSORBLOCK_TIMEOUT_SECONDS = 8.0
SPONSORBLOCK_USER_AGENT = "watch-together (https://github.com/rennerdo30/watch-together)"
# Segments change rarely once a video has been up for a while; an hour keeps
# a room that replays or re-resolves a video from re-fetching each time.
SPONSORBLOCK_CACHE_TTL_SECONDS = 3600
SPONSORBLOCK_CACHE_MAX_ENTRIES = 500
# Every category SponsorBlock defines for skippable segments, in the order
# the settings UI lists them. Chapters and highlights are not segments to skip.
SPONSORBLOCK_CATEGORIES = (
    "sponsor",
    "selfpromo",
    "interaction",
    "intro",
    "outro",
    "preview",
    "filler",
    "music_offtopic",
    "exclusive_access",
)
# What a new room skips: paid promotion and the like/subscribe reminders.
# Intros, outros and filler are a matter of taste and stay opt-in.
SPONSORBLOCK_DEFAULT_CATEGORIES = ("sponsor", "selfpromo", "interaction")
SPONSORBLOCK_DEFAULT_ENABLED = True
# A jump shorter than this is not worth interrupting playback for.
SPONSORBLOCK_MIN_SEGMENT_SECONDS = 1.0
# Segments that overlap or nearly touch are skipped in one jump, and a skip
# that lands within this distance of a segment's end is considered past it.
SPONSORBLOCK_SKIP_TOLERANCE_SECONDS = 0.5

# Browser identity presented to sites by yt-dlp and by requests made on a
# member's behalf with their cookies. One value, so a session looks like one
# browser throughout.
DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

# YouTube watch history (opt-in per user, needs that user's cookies). The
# room's position is reported the way YouTube's own player does it: one
# playback ping when the video starts and a watch-time ping every so often,
# carrying the range watched since the last one and the current position.
YOUTUBE_HISTORY_PING_INTERVAL_SECONDS = 30.0
YOUTUBE_HISTORY_TIMEOUT_SECONDS = 10.0
# A watched range shorter than this is noise (a seek landing, a stutter) and
# is not reported.
YOUTUBE_HISTORY_MIN_RANGE_SECONDS = 1.0
# A position that differs from the expected one by more than this was a seek.
YOUTUBE_HISTORY_SEEK_THRESHOLD_SECONDS = 2.0
YOUTUBE_HISTORY_CPN_LENGTH = 16  # Client playback nonce, as the web player generates it

# Per-user preferences and their defaults. Anything not listed here is dropped.
USER_SETTINGS_DEFAULTS = {
    "youtube_history": False,
}

# Proxy metrics configuration
METRICS_SAMPLE_CAPACITY = 500  # Recent proxy transfers kept in the ring buffer
METRICS_SLOW_UPSTREAM_MS = 5000  # Upstream fetches slower than this are counted
METRICS_DEFAULT_SAMPLE_LIMIT = 50  # Samples returned by the metrics endpoint

# Ensure directories exist
for directory in [CACHE_DIR, COOKIES_DIR, "data", YTDLP_CACHE_DIR]:
    if not os.path.exists(directory):
        os.makedirs(directory)
