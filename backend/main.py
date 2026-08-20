"""
Watch Together Backend - Main Application

This is the entry point for the FastAPI application.
Most logic has been extracted to:
- core/: Configuration and security utilities
- services/: Caching, video resolution
- api/routes/: REST API endpoints
- connection_manager.py: WebSocket room management
"""
import os
import asyncio
import time
import json
import logging
from urllib.parse import urljoin, quote
import re

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import StreamingResponse, Response
from contextlib import asynccontextmanager
import httpx
import aiofiles
import yt_dlp

# Import modules
from core.config import (
    CACHE_DIR, COOKIES_DIR, MAX_CACHE_SIZE_BYTES, CACHE_TTL_SECONDS,
    MIN_DISK_FREE_BYTES, MAX_CACHEABLE_FILE_BYTES, FORMAT_CACHE_TTL_SECONDS,
    METRICS_DEFAULT_SAMPLE_LIMIT, POT_PROVIDER_EXTRACTOR_ARGS,
    MANIFEST_MAX_VIDEO_REPRESENTATIONS, MANIFEST_MAX_AUDIO_REPRESENTATIONS,
)
from core.security import (
    get_user_cookie_path, get_user_from_request, get_user_from_websocket,
    log_auth_configuration,
)
from core.access_jwt import is_configured as access_is_configured
from services.cache import (
    parse_range_header, get_bucket_for_position, get_bucket_cache_key,
    check_disk_space, get_current_cache_size,
    cache_cleanup_task,
    memory_cache, get_segment_cache_key, is_audio_url, mark_content_active,
)
from services.prefetcher import (
    get_or_create_session, notify_segment_for_url,
    prefetch_initial_segments, prefetch_cleanup_task,
)
from services.upstream import (
    UnsafeUpstreamError, pin_url, request_kwargs,
    open_upstream_stream, resolve_upstream,
)
from services.user_cookies import get_cookie_header
from services.manifest import build_manifest_for_formats, ManifestError
from services.metrics import (
    proxy_metrics, OUTCOME_OK, OUTCOME_UPSTREAM_ERROR,
    OUTCOME_CLIENT_ABORTED, OUTCOME_TRUNCATED,
)
from services.database import init_database, cache_format, get_cached_format
from services.resolver import refresh_video_url, _extract_stream_url
from api.routes.cookies import router as cookies_router
from api.routes.rooms import router as rooms_router
from api.routes.tokens import router as tokens_router
from api.routes.extension import router as extension_router
from connection_manager import manager

# Configure logging. LOG_LEVEL=DEBUG turns on the per-transfer proxy traces,
# which record the byte range the origin actually received — the only way to
# tell a player's ranged request apart from an intermediary rewriting it.
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(level=getattr(logging, LOG_LEVEL, logging.INFO))
logger = logging.getLogger(__name__)

# Allowed origins for CORS (set via environment variable, comma-separated)
ALLOWED_ORIGINS = os.environ.get("ALLOWED_ORIGINS", "").split(",") if os.environ.get("ALLOWED_ORIGINS") else ["*"]

# Connection limits
MAX_CONNECTIONS_PER_ROOM = int(os.environ.get("MAX_CONNECTIONS_PER_ROOM", "50"))
MAX_CONNECTIONS_PER_USER = int(os.environ.get("MAX_CONNECTIONS_PER_USER", "10"))

# Whether anonymous access to rooms and the proxy is rejected. Defaults to
# on once Cloudflare Access is configured, so a hardened deployment does
# not also have to remember to set this.
_require_auth_setting = os.environ.get("REQUIRE_AUTHENTICATION", "").strip()
REQUIRE_AUTHENTICATION = (
    _require_auth_setting.lower() in ("true", "1", "yes")
    if _require_auth_setting
    else access_is_configured()
)


def check_single_worker() -> None:
    """Refuse to start with multiple workers.

    Room state, the caches, the in-flight request table and the rate
    limiter all live in this process's memory. A second worker gets its
    own copy of each, so users in one room would be split across workers
    and never see each other — a failure that looks like a sync bug
    rather than a deployment mistake. Fail loudly instead.
    """
    workers = os.environ.get("WEB_CONCURRENCY") or os.environ.get("UVICORN_WORKERS")
    if workers and workers.strip().isdigit() and int(workers) > 1:
        raise RuntimeError(
            f"This backend must run with a single worker (got {workers}). "
            "Room state and caches are held in process memory, so extra "
            "workers would split rooms and silently break synchronization. "
            "Remove WEB_CONCURRENCY/UVICORN_WORKERS or set it to 1."
        )


async def fetch_upstream_body(client, url: str, headers: dict):
    """Fetch a small upstream resource (a manifest) in full.

    Uses the same validation and IP pinning as segment streaming, then
    reads the body so callers can rewrite it.
    """
    response, _pinned = await open_upstream_stream(client, url, headers)
    try:
        await response.aread()
        return response
    finally:
        await response.aclose()


def validate_proxy_url(url: str) -> None:
    """Validate that a proxy URL is safe to fetch.

    Every host is checked, including well-known CDNs: hostname suffixes
    prove nothing when an attacker can own a subdomain of an allowlisted
    domain. Raises HTTPException on failure.
    """
    try:
        pin_url(url)
    except UnsafeUpstreamError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# ============================================================================
# Background Tasks
# ============================================================================

async def cleanup_task():
    """Background task for cleaning up stale rooms."""
    while True:
        await asyncio.sleep(60)
        await manager.cleanup_stale_rooms(ttl_seconds=300)


async def sync_heartbeat_task():
    """Background task for sync heartbeat - broadcasts authoritative time every 5 seconds."""
    consecutive_errors = 0
    while True:
        await asyncio.sleep(5)
        try:
            for room_id, state in list(manager.room_states.items()):
                if state.get("is_playing") and manager.active_connections.get(room_id):
                    # H8: Acquire room lock to prevent reading state while it's being modified
                    async with manager._get_room_lock(room_id):
                        sync_payload = manager.get_sync_payload(room_id)
                    await manager.broadcast({
                        "type": "heartbeat",
                        "payload": {
                            "timestamp": sync_payload.get("timestamp", 0),
                            "server_time": time.time() * 1000,
                            "is_playing": True
                        }
                    }, room_id)
            consecutive_errors = 0
        except Exception as e:
            consecutive_errors += 1
            if consecutive_errors <= 3:
                logger.warning(f"Heartbeat error: {e}")
            elif consecutive_errors == 4:
                logger.error(f"Heartbeat errors persist ({consecutive_errors}x), suppressing further warnings")
            # M3: Exponential backoff for failing heartbeats
            await asyncio.sleep(min(2 ** consecutive_errors, 30))


# ============================================================================
# Application Lifecycle
# ============================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan - start/stop background tasks."""
    tasks = []
    try:
        check_single_worker()
        log_auth_configuration()

        # Initialize database and run migrations
        init_database()

        # Load persisted room states
        await manager.initialize()
        logger.info(f"Loaded {len(manager.room_states)} rooms from database")

        tasks = [
            asyncio.create_task(cleanup_task()),
            asyncio.create_task(cache_cleanup_task()),
            asyncio.create_task(sync_heartbeat_task()),
            asyncio.create_task(prefetch_cleanup_task()),
        ]
        logger.info("Started background tasks: room cleanup, cache cleanup, sync heartbeat, prefetch cleanup")
        yield
    finally:
        # Cancel and await all background tasks (even on startup failure)
        for task in tasks:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass  # Expected when task is cancelled
            except Exception as e:
                logger.warning(f"Error during task shutdown: {e}")

        if tasks:
            logger.info("All background tasks shut down cleanly")

        # Clean up HTTP client. Closing can fail if the client was created
        # on a different event loop than the one shutting down, which must
        # not turn a clean shutdown into an error.
        global _proxy_client
        if _proxy_client is not None:
            try:
                await _proxy_client.aclose()
                logger.info("Closed proxy HTTP client")
            except Exception as exc:
                logger.warning(f"Proxy HTTP client did not close cleanly: {exc}")
            finally:
                _proxy_client = None


# ============================================================================
# App Initialization
# ============================================================================

app = FastAPI(title="Watch Together Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True if ALLOWED_ORIGINS != ["*"] else False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include API routers
app.include_router(cookies_router)
app.include_router(rooms_router)
app.include_router(tokens_router)
app.include_router(extension_router)


# ============================================================================
# HTTP Client
# ============================================================================

_proxy_client = None

async def get_proxy_client():
    """Get or create the HTTP client for proxying.

    The client deliberately holds no cookie jar and does not follow
    redirects. Cookies belong to individual users and are attached per
    request; redirects are followed by the upstream helper so every hop
    is validated.
    """
    global _proxy_client
    if _proxy_client is None:
        _proxy_client = httpx.AsyncClient(
            follow_redirects=False,
            timeout=httpx.Timeout(connect=10.0, read=300.0, write=10.0, pool=None),
            limits=httpx.Limits(max_connections=100, max_keepalive_connections=20)
        )
    return _proxy_client


# ============================================================================
# Core Endpoints
# ============================================================================

@app.get("/")
def read_root():
    """Health check endpoint."""
    return {"status": "ok", "service": "Watch Together Backend"}


@app.get("/api/metrics/proxy")
async def proxy_metrics_endpoint(
    request: Request,
    samples: int = Query(METRICS_DEFAULT_SAMPLE_LIMIT, ge=0, le=500),
):
    """Diagnostic view of recent proxy transfers.

    Used to characterise streaming failures (truncated transfers, slow
    upstreams, aborted clients) that browser captures miss.
    """
    if not get_user_from_request(request):
        raise HTTPException(status_code=401, detail="User identity required")
    return await proxy_metrics.snapshot(sample_limit=samples)


def _build_resolve_response(url: str, info: dict, stream_info: dict) -> dict:
    """Shape a resolved video for the client."""
    response = {
        "original_url": url,
        "stream_url": stream_info["url"],
        "title": info.get("title", "Unknown Title"),
        "is_live": info.get("is_live", False),
        "thumbnail": info.get("thumbnail"),
        "backend_engine": "yt-dlp",
        "duration": info.get("duration"),
        "quality": f"{stream_info.get('height', '?')}p" if stream_info.get("height") else "auto",
        "has_audio": stream_info.get("has_audio", True),
        "stream_type": stream_info.get("type", "unknown"),
    }

    if stream_info.get("type") == "dash":
        response["video_url"] = stream_info.get("video_url")
        response["audio_url"] = stream_info.get("audio_url")
        response["available_qualities"] = stream_info.get("available_qualities", [])
        response["audio_options"] = stream_info.get("audio_options", [])

    return response


def _extract_with_options(url: str, ydl_opts: dict) -> dict:
    """Run yt-dlp for one option set. Blocking; call in a worker thread."""
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False, process=False)
        # A playlist or shortened link resolves to another URL first.
        if info.get("_type") == "url":
            info = ydl.extract_info(info["url"], download=False, process=False)
        return info


@app.get("/api/resolve")
async def resolve_stream(
    request: Request,
    url: str = Query(..., description="The URL of the video/stream to resolve"),
    user_agent: str = Query(None, description="User agent from the client browser")
):
    """
    Uses yt-dlp to resolve the input URL to a playable stream URL.
    """
    user_email = get_user_from_request(request)
    logger.info(f"Resolving URL: {url} (User: {user_email or 'anonymous'})")

    cookie_path = get_user_cookie_path(user_email) if user_email else None
    has_cookies = cookie_path and os.path.exists(cookie_path)

    cache_dir = os.path.join("data", "yt_dlp_cache")
    if not os.path.exists(cache_dir):
        os.makedirs(cache_dir)

    base_opts = {
        'quiet': False,
        'no_warnings': False,
        'nocheckcertificate': True,
        'socket_timeout': 30,
        'http_headers': {
            'User-Agent': user_agent or 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
        },
        'skip_download': True,
        'ignore_no_formats_error': True,
        'cache_dir': cache_dir,
        # The PO token provider address must be passed explicitly: the bgutil
        # plugin otherwise looks for it on localhost, gets no token, and
        # YouTube answers "Sign in to confirm you're not a bot" with no
        # playable formats.
        'extractor_args': dict(POT_PROVIDER_EXTRACTOR_ARGS),
    }

    if has_cookies:
        logger.info(f"Using cookies for user: {user_email}")
        base_opts['cookiefile'] = cookie_path

    # The player client is deliberately not pinned. Lists such as
    # ['mweb', 'web'] or ['tv'] now return storyboard images and no media,
    # because YouTube expects per-client tokens a fixed list does not carry.
    # yt-dlp keeps its own client selection current, so the choice is left
    # to it; the only variation worth trying is where the challenge script
    # comes from.
    # First attempt uses the Deno runtime in the image to solve the
    # JavaScript challenge; the second lets yt-dlp fetch the challenge
    # script from GitHub in case the local runtime cannot run it.
    #
    # The value must be the string 'ejs:github'. Passing {'ejs': 'github'}
    # makes yt-dlp log "Ignoring unsupported remote component(s): ejs" and
    # carry on without it.
    attempts = [
        ("local challenge runtime", dict(base_opts)),
        ("remote challenge components", {**base_opts, 'remote_components': 'ejs:github'}),
    ]

    last_error = None
    for label, ydl_opts in attempts:
        try:
            info = await asyncio.to_thread(_extract_with_options, url, ydl_opts)
            stream_info = _extract_stream_url(info)

            if stream_info and stream_info.get('url'):
                response = _build_resolve_response(url, info, stream_info)
                # Cache it so /api/dash-manifest can build a manifest for
                # this video without resolving it again. Without this the
                # manifest endpoint 404s on a freshly pasted link.
                try:
                    await cache_format(url, response)
                except Exception as exc:
                    logger.warning(f"Could not cache resolved format: {exc}")
                return response

            logger.info(f"{label}: no playable formats")
        except Exception as e:
            last_error = str(e)
            logger.info(f"{label} failed: {last_error[:150]}")

    if last_error and "Sign in to confirm your age" in last_error:
        raise HTTPException(
            status_code=403,
            detail="Age-restricted video. Please upload valid YouTube cookies.",
        )

    raise HTTPException(status_code=400, detail="Could not resolve a playable stream URL.")


# ============================================================================
# HLS/DASH Proxy
# ============================================================================

def rewrite_dash_manifest(content: str, base_url: str, proxy_base: str) -> str:
    """Rewrite URLs in DASH MPD manifest to go through our proxy.

    Handles:
    - <BaseURL> tags
    - media/initialization attributes in SegmentTemplate
    - Absolute URLs in various attributes
    """
    # Replace BaseURL content
    def replace_baseurl(match):
        url = match.group(1).strip()
        if url and not url.startswith('data:'):
            full_url = url if url.startswith('http') else urljoin(base_url, url)
            return f'<BaseURL>{proxy_base}{quote(full_url, safe="")}</BaseURL>'
        return match.group(0)

    content = re.sub(r'<BaseURL>([^<]+)</BaseURL>', replace_baseurl, content)

    # Replace media/initialization URLs in SegmentTemplate
    def replace_attr_url(match):
        attr_name = match.group(1)
        url = match.group(2)
        if url.startswith('http'):
            return f'{attr_name}="{proxy_base}{quote(url, safe="")}"'
        return match.group(0)

    # Handle media="url" and initialization="url" attributes
    content = re.sub(r'(media|initialization)="(https?://[^"]+)"', replace_attr_url, content)

    # Handle sourceURL attributes
    content = re.sub(r'(sourceURL)="(https?://[^"]+)"', replace_attr_url, content)

    return content


def rewrite_hls_manifest(content: str, base_url: str, proxy_base: str) -> str:
    """Rewrite URLs in HLS manifest to go through our proxy."""
    lines = content.split('\n')
    result = []

    for line in lines:
        line = line.strip()
        if not line:
            result.append(line)
            continue

        if line.startswith('#'):
            if 'URI="' in line:
                def replace_uri(match):
                    uri = match.group(1)
                    full_url = uri if uri.startswith('http') else urljoin(base_url, uri)
                    return f'URI="{proxy_base}{quote(full_url, safe="")}"'
                line = re.sub(r'URI="([^"]+)"', replace_uri, line)
            result.append(line)
            continue

        full_url = line if line.startswith('http') else urljoin(base_url, line)
        result.append(f"{proxy_base}{quote(full_url, safe='')}")

    return '\n'.join(result)


@app.get("/api/dash-manifest")
async def dash_manifest(request: Request, url: str):
    """Build a DASH manifest for an already-resolved video.

    Lets one media element play the adaptive video and audio streams
    through MSE, instead of a <video> and an <audio> element being kept
    in step by hand.
    """
    user_email = get_user_from_request(request)
    if REQUIRE_AUTHENTICATION and not user_email:
        raise HTTPException(status_code=401, detail="User identity required")

    cached = await get_cached_format(url)
    if not cached:
        raise HTTPException(
            status_code=404,
            detail="Video has not been resolved yet. Call /api/resolve first.",
        )

    duration = cached.get("duration")
    if not duration:
        raise HTTPException(status_code=422, detail="Video duration is unknown")

    video_formats = [
        {
            "id": quality.get("format_id") or f"v{position}",
            "url": quality.get("video_url"),
            "width": quality.get("width"),
            "height": quality.get("height"),
            "vcodec": quality.get("vcodec"),
            "tbr": quality.get("tbr"),
            "fps": quality.get("fps"),
        }
        for position, quality in enumerate(
            cached.get("available_qualities", [])[:MANIFEST_MAX_VIDEO_REPRESENTATIONS]
        )
    ]
    audio_formats = [
        {
            "id": option.get("format_id") or f"a{position}",
            "url": option.get("audio_url"),
            "acodec": option.get("acodec"),
            "abr": option.get("abr"),
            "asr": option.get("asr"),
            "audio_channels": option.get("audio_channels"),
        }
        for position, option in enumerate(
            cached.get("audio_options", [])[:MANIFEST_MAX_AUDIO_REPRESENTATIONS]
        )
    ]

    if not video_formats or not audio_formats:
        raise HTTPException(status_code=422, detail="Video has no adaptive streams")

    host = request.headers.get("host")
    proto = "https" if request.headers.get("x-forwarded-proto") == "https" else "http"
    proxy_base = f"{proto}://{host}/api/proxy?url="

    outgoing_headers = {
        "User-Agent": request.headers.get("user-agent", "Mozilla/5.0"),
        "Referer": "https://www.youtube.com/",
    }
    cookie_header = get_cookie_header(user_email, video_formats[0]["url"]) if user_email else None
    if cookie_header:
        outgoing_headers["Cookie"] = cookie_header

    try:
        manifest = await build_manifest_for_formats(
            await get_proxy_client(),
            duration_seconds=float(duration),
            video_formats=video_formats,
            audio_formats=audio_formats,
            proxy_base=proxy_base,
            headers=outgoing_headers,
        )
    except UnsafeUpstreamError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ManifestError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return Response(
        content=manifest,
        media_type="application/dash+xml",
        headers={
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-cache",
        },
    )


@app.options("/api/proxy")
async def proxy_options():
    """Handle CORS preflight requests."""
    return Response(
        content="",
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Max-Age": "86400",
        }
    )


@app.get("/api/proxy")
async def proxy_stream(request: Request, url: str):
    """Proxy HLS manifests and segments to bypass CORS/restrictions."""
    if not url:
        raise HTTPException(status_code=400, detail="Missing URL")

    # The proxy fetches upstream content on the caller's behalf, so it must
    # know who the caller is before doing any work.
    user_email = get_user_from_request(request)
    if REQUIRE_AUTHENTICATION and not user_email:
        raise HTTPException(status_code=401, detail="User identity required")

    # SSRF protection: validate URL before proxying
    validate_proxy_url(url)

    # Dynamic referer based on URL domain
    from urllib.parse import urlparse
    parsed_url = urlparse(url)
    hostname = parsed_url.hostname or ""
    if "youtube.com" in hostname or "googlevideo.com" in hostname or "ytimg.com" in hostname:
        referer = "https://www.youtube.com/"
    elif "twitch.tv" in hostname or "ttvnw.net" in hostname:
        referer = "https://www.twitch.tv/"
    elif "vimeo.com" in hostname or "vimeocdn.com" in hostname:
        referer = "https://vimeo.com/"
    elif "dailymotion.com" in hostname or "dm-event.net" in hostname:
        referer = "https://www.dailymotion.com/"
    else:
        referer = f"{parsed_url.scheme}://{hostname}/"

    host = request.headers.get("host")
    proto = "https" if request.headers.get("x-forwarded-proto") == "https" else "http"
    proxy_base = f"{proto}://{host}/api/proxy?url="

    url_path = url.split('?')[0]
    is_hls_manifest = url_path.endswith('.m3u8') or url_path.endswith('.m3u')
    is_dash_manifest = url_path.endswith('.mpd')

    outgoing_headers = {
        "User-Agent": request.headers.get("user-agent", "Mozilla/5.0"),
        "Referer": referer,
        "Accept-Language": "en-US,en;q=0.9",
        "Range": request.headers.get("range", ""),
    }
    if not outgoing_headers["Range"]:
        del outgoing_headers["Range"]

    # Attach the caller's own cookies, never another user's. Fetches that
    # carry cookies are cached separately so authenticated content is not
    # served to a different user from a shared cache entry.
    cookie_header = get_cookie_header(user_email, url) if user_email else None
    if cookie_header:
        outgoing_headers["Cookie"] = cookie_header
    cache_identity = user_email if cookie_header else None

    segment_client = await get_proxy_client()

    try:
        if is_hls_manifest:
            logger.info(f"Proxying HLS manifest for {url[:100]}...")
            response = await fetch_upstream_body(segment_client, url, outgoing_headers)
            if response.status_code >= 400:
                return Response(content=response.text, status_code=response.status_code)

            rewritten = rewrite_hls_manifest(response.text, url, proxy_base)

            # Initialize prefetch session and parse manifest for segment URLs
            is_audio = is_audio_url(url)
            session = await get_or_create_session(url, is_audio=is_audio)
            await session.parse_hls_manifest(response.text, url)

            return Response(
                content=rewritten,
                media_type="application/vnd.apple.mpegurl",
                headers={
                    "Access-Control-Allow-Origin": "*",
                    "Cache-Control": "no-cache",
                }
            )
        elif is_dash_manifest:
            logger.info(f"Proxying DASH manifest for {url[:100]}...")
            response = await fetch_upstream_body(segment_client, url, outgoing_headers)
            if response.status_code >= 400:
                return Response(content=response.text, status_code=response.status_code)

            rewritten = rewrite_dash_manifest(response.text, url, proxy_base)
            return Response(
                content=rewritten,
                media_type="application/dash+xml",
                headers={
                    "Access-Control-Allow-Origin": "*",
                    "Cache-Control": "no-cache",
                }
            )
        else:
            # Segment proxying with memory cache + disk bucket cache
            range_header = outgoing_headers.get("Range", "")
            range_start, range_end = parse_range_header(range_header)

            # Notify prefetcher about this segment request (triggers prefetch of next segments)
            await notify_segment_for_url(url)

            # Check memory cache first (fastest). The key spans the whole
            # requested range: a 206 has to answer exactly what was asked
            # for, and a body cached for a different range is not an answer.
            segment_cache_key = get_segment_cache_key(
                url, range_start, range_end, identity=cache_identity)
            is_audio = is_audio_url(url)
            mem_result = await memory_cache.get(segment_cache_key)
            if mem_result:
                data, content_type, cached_content_range = mem_result
                logger.info(f"MEMORY HIT: {url[:60]}... ({len(data)} bytes)")

                # Mark content as active for adaptive TTL
                url_hash = segment_cache_key.split('_')[1] if '_' in segment_cache_key else None
                if url_hash:
                    await mark_content_active(url_hash)

                cached_headers = {
                    "Access-Control-Allow-Origin": "*",
                    "Accept-Ranges": "bytes",
                    "Cache-Control": "private, no-store, no-transform",
                }
                # A partial response without its Content-Range is malformed:
                # the player rejects it ("payload length does not match range
                # requested bytes") and Cloudflare turns it into a 416. Only
                # answer 206 when the stored range can be reproduced.
                serve_partial = bool(range_header and cached_content_range)
                if serve_partial:
                    cached_headers["Content-Range"] = cached_content_range

                return Response(
                    content=data,
                    media_type=content_type,
                    status_code=206 if serve_partial else 200,
                    headers=cached_headers,
                )

            # The position-bucket cache is only consulted for whole-object
            # requests. It streams from an offset to the end of its bucket,
            # which cannot satisfy a specific byte range, and it has no
            # record of the object's total size to build a Content-Range
            # from. Adaptive playback is entirely ranged requests, so this
            # costs nothing there and keeps the responses honest.
            start_bucket = get_bucket_for_position(range_start)
            _, bucket_cache_path = get_bucket_cache_key(url, start_bucket, identity=cache_identity)
            bucket_meta_path = bucket_cache_path + ".meta"

            # Check bucket cache (with race condition protection)
            if not range_header and os.path.exists(bucket_cache_path) and os.path.exists(bucket_meta_path):
                try:
                    async with aiofiles.open(bucket_meta_path, 'r') as f:
                        bucket_meta = json.loads(await f.read())

                    bucket_start = bucket_meta.get("bucket_start", 0)
                    bucket_end = bucket_meta.get("bucket_end", 0)

                    if bucket_start <= range_start < bucket_end:
                        offset = range_start - bucket_start

                        # Open the cache file BEFORE returning the response
                        # This handles the race condition where the file could be deleted
                        # between os.path.exists() check and the actual read
                        try:
                            cache_file = await aiofiles.open(bucket_cache_path, 'rb')
                            await cache_file.seek(offset)
                            # M1: Wrap utime in its own try-except for TOCTOU race
                            try:
                                os.utime(bucket_cache_path, None)
                            except (FileNotFoundError, OSError):
                                pass  # File may have been deleted between open and utime
                        except FileNotFoundError:
                            logger.warning(f"Bucket cache file deleted during read: {bucket_cache_path}")
                            # Fall through to upstream fetch
                        else:
                            async def iter_bucket():
                                try:
                                    while True:
                                        chunk = await cache_file.read(64 * 1024)
                                        if not chunk:
                                            break
                                        yield chunk
                                finally:
                                    await cache_file.close()

                            logger.info(f"BUCKET HIT: {start_bucket} for {url[:60]}...")
                            return StreamingResponse(
                                iter_bucket(),
                                status_code=206,
                                headers={
                                    "Access-Control-Allow-Origin": "*",
                                    "Accept-Ranges": "bytes",
                                    "Cache-Control": "private, no-store, no-transform",
                                    "Content-Type": bucket_meta.get("content_type", "application/octet-stream"),
                                }
                            )
                except FileNotFoundError:
                    logger.warning(f"Bucket cache metadata deleted: {bucket_meta_path}")
                except Exception as e:
                    logger.warning(f"Bucket cache read error: {e}")

            # Fetch from upstream
            upstream_started = time.monotonic()
            r, pinned = await open_upstream_stream(segment_client, url, outgoing_headers)
            upstream_ms = (time.monotonic() - upstream_started) * 1000
            upstream_host = pinned.hostname
            expected_bytes = int(r.headers.get("content-length", 0)) or None

            response_headers = {
                "Access-Control-Allow-Origin": "*",
                "Accept-Ranges": "bytes",
                # Never let an intermediary cache or rewrite these. Segments
                # are fetched with the caller's own cookies, so a shared cache
                # would hand one user's authenticated content to another; and
                # a cacheable response invites Cloudflare to fetch the whole
                # object from the origin to satisfy a small range, which is
                # how a 700-byte request became a 479MB origin transfer.
                "Cache-Control": "private, no-store, no-transform",
                # Connection is deliberately not forced closed. It used to be
                # set to "close" to work around HTTP/2 stream errors, but
                # those came from partial responses sent without a
                # Content-Range, which is fixed at the source now. Closing
                # after every response costs a fresh connection per segment,
                # and adaptive playback is thousands of small range requests
                # — expensive on any link, punitive on an intercontinental
                # one.
            }
            for key in ["content-type", "content-length", "content-range"]:
                if key in r.headers:
                    response_headers[key] = r.headers[key]

            # Check if we should cache
            should_cache = r.status_code in (200, 206)
            disk_ok, _ = check_disk_space()
            if not disk_ok:
                should_cache = False
            if get_current_cache_size() >= MAX_CACHE_SIZE_BYTES:
                should_cache = False
            content_length = int(r.headers.get("content-length", 0))
            if content_length > MAX_CACHEABLE_FILE_BYTES:
                should_cache = False

            # Check for late-detected manifest (content-type based detection)
            ctype = r.headers.get("content-type", "").lower()
            if "mpegurl" in ctype:
                content = await r.read()
                text = content.decode('utf-8', errors='replace')
                rewritten = rewrite_hls_manifest(text, url, proxy_base)
                return Response(content=rewritten, media_type="application/vnd.apple.mpegurl")
            elif "dash+xml" in ctype or "mpd" in ctype:
                content = await r.read()
                text = content.decode('utf-8', errors='replace')
                rewritten = rewrite_dash_manifest(text, url, proxy_base)
                return Response(content=rewritten, media_type="application/dash+xml")

            if should_cache:
                _, cache_path = get_bucket_cache_key(url, start_bucket, identity=cache_identity)
                cache_meta_path = cache_path + ".meta"

                async def stream_and_cache():
                    temp_path = cache_path + f".{time.time()}.tmp"
                    total = 0
                    chunks = []  # Collect chunks for memory cache
                    content_type = r.headers.get("content-type", "video/mp4")
                    transfer_started = time.monotonic()
                    outcome = OUTCOME_OK
                    transfer_error = None
                    try:
                        async with aiofiles.open(temp_path, 'wb') as f:
                            async for chunk in r.aiter_bytes():
                                await f.write(chunk)
                                total += len(chunk)
                                chunks.append(chunk)
                                yield chunk

                        if r.status_code in (200, 206):
                            os.rename(temp_path, cache_path)
                            meta = {
                                "bucket_num": start_bucket,
                                "bucket_start": range_start,
                                "bucket_end": range_start + total,
                                "content_type": content_type,
                                "cached_at": time.time(),
                            }
                            async with aiofiles.open(cache_meta_path, 'w') as f:
                                await f.write(json.dumps(meta))

                            # Also add to memory cache for faster subsequent access
                            if total < 25 * 1024 * 1024:  # Only cache segments < 25MB in memory
                                full_data = b''.join(chunks)
                                await memory_cache.put(
                                    segment_cache_key,
                                    full_data,
                                    content_type,
                                    is_audio=is_audio,
                                    content_range=r.headers.get("content-range"),
                                )
                                logger.info(f"Added to memory cache: {url[:60]}... ({total} bytes)")

                                # Mark content as active
                                url_hash = segment_cache_key.split('_')[1] if '_' in segment_cache_key else None
                                if url_hash:
                                    await mark_content_active(url_hash)
                    except asyncio.CancelledError:
                        # Only an abort if the client left mid-body. A
                        # cancellation after full delivery is the normal end
                        # of a streamed response.
                        if not expected_bytes or total < expected_bytes:
                            outcome = OUTCOME_CLIENT_ABORTED
                        if os.path.exists(temp_path):
                            os.remove(temp_path)
                        raise
                    except Exception as e:
                        outcome = OUTCOME_TRUNCATED
                        transfer_error = f"{type(e).__name__}: {e}"
                        logger.warning(f"Cache error: {e}")
                        if os.path.exists(temp_path):
                            os.remove(temp_path)
                    finally:
                        await r.aclose()
                        if outcome == OUTCOME_OK and expected_bytes and total < expected_bytes:
                            outcome = OUTCOME_TRUNCATED
                            transfer_error = f"sent {total} of {expected_bytes} bytes"
                        await proxy_metrics.record(
                            host=upstream_host,
                            status=r.status_code,
                            outcome=outcome,
                            upstream_ms=upstream_ms,
                            transfer_ms=(time.monotonic() - transfer_started) * 1000,
                            bytes_sent=total,
                            range_start=range_start,
                            expected_bytes=expected_bytes,
                            error=transfer_error,
                        )

                return StreamingResponse(stream_and_cache(), status_code=r.status_code, headers=response_headers)
            else:
                async def stream_only():
                    transfer_started = time.monotonic()
                    total = 0
                    outcome = OUTCOME_OK
                    transfer_error = None
                    try:
                        async for chunk in r.aiter_bytes():
                            total += len(chunk)
                            yield chunk
                    except asyncio.CancelledError:
                        # See above: a cancellation after the last byte is a
                        # completed response, not a failed one.
                        if not expected_bytes or total < expected_bytes:
                            outcome = OUTCOME_CLIENT_ABORTED
                        raise
                    except Exception as e:
                        outcome = OUTCOME_TRUNCATED
                        transfer_error = f"{type(e).__name__}: {e}"
                        raise
                    finally:
                        await r.aclose()
                        if outcome == OUTCOME_OK and expected_bytes and total < expected_bytes:
                            outcome = OUTCOME_TRUNCATED
                            transfer_error = f"sent {total} of {expected_bytes} bytes"
                        await proxy_metrics.record(
                            host=upstream_host,
                            status=r.status_code,
                            outcome=outcome,
                            upstream_ms=upstream_ms,
                            transfer_ms=(time.monotonic() - transfer_started) * 1000,
                            bytes_sent=total,
                            range_start=range_start,
                            expected_bytes=expected_bytes,
                            error=transfer_error,
                        )

                return StreamingResponse(stream_only(), status_code=r.status_code, headers=response_headers)

    except Exception as e:
        logger.error(f"Proxy error for {url}: {e}")
        await proxy_metrics.record(
            host=parsed_url.hostname or "unknown",
            status=None,
            outcome=OUTCOME_UPSTREAM_ERROR,
            upstream_ms=0.0,
            transfer_ms=0.0,
            bytes_sent=0,
            error=f"{type(e).__name__}: {e}",
        )
        raise HTTPException(status_code=500, detail=f"Proxy error: {e}")


# ============================================================================
# WebSocket Handler
# ============================================================================

@app.websocket("/ws/{room_id}")
async def websocket_endpoint(websocket: WebSocket, room_id: str):
    """WebSocket handler for room synchronization."""
    # H1: Sanitize room ID to prevent injection attacks
    room_id = re.sub(r'[^a-zA-Z0-9_-]', '', room_id)
    if not room_id:
        await websocket.close(code=4000, reason="Invalid room ID")
        return

    user_email = get_user_from_websocket(websocket)
    if not user_email:
        if REQUIRE_AUTHENTICATION:
            await websocket.close(code=4003, reason="Authentication required")
            return
        user_email = "Guest"

    # Connection limits are checked atomically inside connect() under _state_lock
    connected = await manager.connect(
        websocket, room_id, user_email,
        max_per_room=MAX_CONNECTIONS_PER_ROOM,
        max_per_user=MAX_CONNECTIONS_PER_USER,
    )
    if not connected:
        return
    MAX_WS_MESSAGE_SIZE = 100 * 1024  # 100KB
    try:
        while True:
            data = await websocket.receive_text()
            if len(data) > MAX_WS_MESSAGE_SIZE:
                logger.warning(f"Oversized message from {user_email}: {len(data)} bytes")
                continue
            try:
                message = json.loads(data)
            except json.JSONDecodeError:
                logger.warning(f"Invalid JSON received from {user_email} in room {room_id}")
                continue

            msg_type = message.get("type")
            if not isinstance(msg_type, str) or len(msg_type) > 50:
                logger.warning(f"Invalid message type from {user_email} in room {room_id}")
                continue
            payload = message.get("payload", {})
            
            if msg_type == "play":
                await manager.update_state(room_id, {"is_playing": True, "timestamp": payload.get("timestamp", 0)})
                await manager.broadcast({"type": "play", "payload": payload}, room_id, exclude=websocket)
                
            elif msg_type == "pause":
                await manager.update_state(room_id, {"is_playing": False, "timestamp": payload.get("timestamp", 0)})
                await manager.broadcast({"type": "pause", "payload": payload}, room_id, exclude=websocket)
                
            elif msg_type == "seek":
                await manager.update_state(room_id, {"timestamp": payload.get("timestamp", 0)})
                await manager.broadcast({"type": "seek", "payload": payload}, room_id, exclude=websocket)
                
            elif msg_type == "set_video":
                video_data = payload.get("video_data")
                if video_data:
                    video_data["added_by"] = user_email
                    if video_data.get("original_url"):
                        await cache_format(video_data["original_url"], video_data)

                    # Trigger initial prefetch for faster startup
                    video_url = video_data.get("video_url") or video_data.get("stream_url")
                    audio_url = video_data.get("audio_url")
                    if video_url:
                        asyncio.create_task(prefetch_initial_segments(
                            video_url,
                            audio_url,
                            await get_proxy_client()
                        ))

                next_v, queue, playing_index = await manager.prepend_to_queue(room_id, video_data)
                if next_v:
                    await manager.broadcast({"type": "set_video", "payload": {"video_data": next_v}}, room_id)
                    await manager.broadcast({"type": "queue_update", "payload": {"queue": queue, "playing_index": playing_index}}, room_id)

            elif msg_type == "queue_add":
                video_data = payload.get("video_data")
                if video_data:
                    video_data["added_by"] = user_email
                    if video_data.get("original_url"):
                        await cache_format(video_data["original_url"], video_data)
                queue = await manager.add_to_queue(room_id, video_data)
                state = manager.room_states.get(room_id, {})
                await manager.broadcast({"type": "queue_update", "payload": {"queue": queue, "playing_index": state.get("playing_index", -1)}}, room_id)

            elif msg_type == "queue_remove":
                queue = await manager.remove_from_queue(room_id, payload.get("index"))
                state = manager.room_states.get(room_id, {})
                await manager.broadcast({"type": "queue_update", "payload": {"queue": queue, "playing_index": state.get("playing_index", -1)}}, room_id)

            elif msg_type == "queue_reorder":
                queue = await manager.reorder_queue(room_id, payload.get("old_index"), payload.get("new_index"))
                state = manager.room_states.get(room_id, {})
                await manager.broadcast({"type": "queue_update", "payload": {"queue": queue, "playing_index": state.get("playing_index", -1)}}, room_id)

            elif msg_type == "queue_pin":
                queue = await manager.toggle_pin(room_id, payload.get("index"))
                state = manager.room_states.get(room_id, {})
                await manager.broadcast({"type": "queue_update", "payload": {"queue": queue, "playing_index": state.get("playing_index", -1)}}, room_id)

            elif msg_type == "queue_play":
                next_v, queue, playing_index = await manager.play_from_queue(room_id, payload.get("index"))
                if next_v:
                    next_v = await refresh_video_url(next_v, user_email=user_email)
                    await manager.broadcast({"type": "set_video", "payload": {"video_data": next_v}}, room_id)
                await manager.broadcast({"type": "queue_update", "payload": {"queue": queue, "playing_index": playing_index}}, room_id)

            elif msg_type == "video_ended":
                next_v, queue, playing_index = await manager.next_video(room_id)
                if next_v:
                    next_v = await refresh_video_url(next_v, user_email=user_email)
                    await manager.broadcast({"type": "set_video", "payload": {"video_data": next_v}}, room_id)
                await manager.broadcast({"type": "queue_update", "payload": {"queue": queue, "playing_index": playing_index}}, room_id)
                
            elif msg_type == "promote":
                target = payload.get("target_email")
                role = payload.get("role")
                if target and role and await manager.promote_user(room_id, user_email, target, role):
                    state = manager.room_states.get(room_id, {})
                    await manager.broadcast({"type": "roles_update", "payload": {"roles": state.get("roles", {})}}, room_id)
            
            elif msg_type == "toggle_permanent":
                if await manager.toggle_permanent(room_id, user_email):
                    state = manager.room_states.get(room_id, {})
                    await manager.broadcast({
                        "type": "room_settings_update",
                        "payload": {"permanent": state.get("permanent", False)}
                    }, room_id)
            
            elif msg_type == "quality_change":
                # User switched video quality - prefetch segments for new quality
                new_video_url = payload.get("new_video_url")
                audio_url = payload.get("audio_url")
                if new_video_url:
                    asyncio.create_task(prefetch_initial_segments(
                        new_video_url,
                        audio_url,
                        await get_proxy_client()
                    ))
                    logger.info(f"Quality change prefetch triggered for {user_email}")

            elif msg_type == "ping":
                await websocket.send_json({
                    "type": "pong",
                    "payload": {"client_time": payload.get("client_time"), "server_time": time.time() * 1000}
                })

    except WebSocketDisconnect:
        pass  # Normal disconnect, handled in finally
    except Exception as e:
        logger.error(f"WebSocket error for {user_email} in room {room_id}: {e}")
    finally:
        # Always clean up the connection, regardless of how the handler exits
        await manager.disconnect_and_notify(websocket, room_id)


# ============================================================================
# Entry Point
# ============================================================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
