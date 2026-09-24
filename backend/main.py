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
import contextlib
import time
import json
import logging
from functools import partial
from typing import Optional
from urllib.parse import urljoin, quote, urlparse
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
    CACHE_DIR, YTDLP_CACHE_DIR, GUEST_IDENTITY,
    MAX_CACHEABLE_FILE_BYTES, FORMAT_CACHE_TTL_SECONDS,
    METRICS_DEFAULT_SAMPLE_LIMIT, POT_PROVIDER_EXTRACTOR_ARGS,
    PREWARM_NEXT_VIDEO_SECONDS, STREAM_URL_MIN_LIFETIME_SECONDS,
    PREWARM_CODEC_PREFERENCE, PREWARM_DEFAULT_HEIGHT, PREWARM_RATE_LIMIT_PER_MINUTE,
    QUEUE_URL_MAX_LENGTH, QUEUE_UNRESOLVABLE_SKIP_LIMIT, PREWARM_MAX_POSITION_SECONDS,
    STREAM_URL_SERVE_MIN_SECONDS, DEFAULT_USER_AGENT, INFLIGHT_JOIN_TIMEOUT_SECONDS,
    SHARE_TITLE_MAX_LENGTH, SHARE_QUALITY_MAX_LENGTH,
    SHARE_CHUNK_MAX_BYTES, SHARE_CONTROL_FORMAT, SHARE_CONTROL_MAX_BYTES,
    SHARE_CLOSE_PROTOCOL, SHARE_CLOSE_NOT_AUTHORIZED, SHARE_CLOSE_NO_SHARE,
    BROWSER_TITLE_MAX_LENGTH, BROWSER_BUSY_LIVE_SHARE,
)
from core.security import (
    get_user_from_request, get_user_from_websocket,
    log_auth_configuration,
)
from core.access_jwt import is_configured as access_is_configured
from services.cache import (
    parse_range_header, get_segment_disk_key,
    check_disk_space, make_room, release_room,
    cache_cleanup_task,
    memory_cache, get_segment_cache_key, is_audio_url, mark_content_active,
)
from services.prefetcher import (
    get_or_create_session, notify_segment_for_url,
    prefetch_cleanup_task, prefetch_ahead, shutdown_prefetch,
)
from services import inflight
from services.gvs_range import rewrite_range, is_whole_file_grab
from services.upstream import (
    UnsafeUpstreamError, request_kwargs,
    open_upstream_stream, resolve_upstream,
)
from services.user_cookies import choose_cookie_source, cookie_file, get_cookie_header
from services.manifest import build_manifest_for_formats, manifest_formats, probe_formats, ManifestError, proxied_url
from services import prewarm
from services.metrics import (
    proxy_metrics, OUTCOME_OK, OUTCOME_UPSTREAM_ERROR,
    OUTCOME_CLIENT_ABORTED, OUTCOME_TRUNCATED,
    TIER_MEMORY, TIER_DISK,
)
from services.database import init_database, cache_format, get_cached_format
from services.resolver import _extract_stream_url, _build_resolve_response
from core.rate_limit import check_rate_limit
from api.routes.cookies import router as cookies_router
from api.routes.rooms import router as rooms_router
from api.routes.tokens import router as tokens_router
from api.routes.extension import router as extension_router
from api.routes.admin import router as admin_router
from api.routes.user_settings import router as user_settings_router
from api.routes.browser import router as browser_router
from api.routes.playlists import router as playlists_router
from connection_manager import manager
from services.sponsorblock import SponsorSkipper
from services.watch_history import reporter as history_reporter
from services import stream_owner
from services import stream_expiry
from services import shared_browser
from services import startup_timing
from services.share_relay import RelayRefused, relay as share_relay

# Room-wide SponsorBlock skipping; armed from the WebSocket handler below.
sponsor_skipper = SponsorSkipper(manager)
# A skip moves the room; the history reporter closes the watched range there
# rather than crediting the skipped stretch as watched.
sponsor_skipper.on_skip = history_reporter.rearm


def _warm_skip_destination(video_data: dict, seconds: float) -> None:
    """Fetch the bytes on the far side of a scheduled skip.

    A skip empties every viewer's buffer at a position none of them has
    fetched, so without this the room stares at a spinner for exactly as
    long as one segment takes to arrive from the CDN.
    """
    # Only warm once the proxy client exists; before the first request
    # there is nothing to fetch with, and creating it here would make a
    # speculative fetch the thing that opens the connection pool.
    if _proxy_client is None:
        return
    prewarm.warm_position(_proxy_client, video_data, seconds,
                          identity=video_data.get(stream_owner.RESOLVED_BY_KEY))


sponsor_skipper.prewarm = _warm_skip_destination

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


# ============================================================================
# Background Tasks
# ============================================================================

async def cleanup_task():
    """Background task for cleaning up stale rooms."""
    while True:
        await asyncio.sleep(60)
        await manager.cleanup_stale_rooms(ttl_seconds=300)


async def _playable_source(url: str, known: Optional[dict], room_id: str, *,
                           min_lifetime: float,
                           user_email: Optional[str] = None,
                           user_agent: str = DEFAULT_USER_AGENT) -> Optional[dict]:
    """A resolve of `url` whose signed URLs the CDN will still serve.

    `known` is the best copy the caller already has — a cache entry, or a
    queue entry a room has been sitting on. Either can outlive its URLs:
    they carry an `expire` timestamp and answer 403 to everything
    afterwards, cookies or no cookies. Resolving again is the only way to
    get URLs that work, and it is a yt-dlp run, so it happens when the
    deadline says it must and not on a timer.

    `min_lifetime` is how much life the caller needs the URLs to have. It
    differs by caller on purpose: warming fetches ahead of time and wants a
    margin, while a request someone is waiting on wants whatever is still
    signed — a source that issues short-lived URLs plays perfectly well,
    and refusing it would make it unplayable rather than early.

    A resolve that fails with its own reason (age-restricted, no playable
    formats) raises: on demand that reason belongs to the caller, and
    speculation discards it either way.
    """
    if known and stream_expiry.is_fresh(known, min_lifetime):
        return known
    remaining = stream_expiry.seconds_remaining(known or {})
    logger.info("Stream URLs of %s have %.0fs left; resolving it again", url, remaining or 0)
    try:
        fresh = await resolve_url(url, user_agent, refresh=True,
                                  room_id=room_id, user_email=user_email)
    except HTTPException:
        raise
    except Exception as exc:
        logger.info("Could not re-resolve %s: %s", url, str(exc)[:150])
        return None
    if not stream_expiry.is_fresh(fresh, min_lifetime):
        logger.info("Re-resolving %s produced URLs that are already spent", url)
        return None
    return fresh


async def _prepare_queued_video(video_data: dict, room_id: str) -> Optional[dict]:
    """Probe a queued video's renditions so the advance hits warm caches.

    Everything the first moments of a video wait on happens here instead:
    the index probe of every rendition (which is what building the manifest
    spends its time on) and, through the caller, the opening bytes.

    What is probed is a resolve whose URLs are still signed for now. The
    cached one is preferred over the queue entry, and when neither survives
    the video is resolved again before anything is fetched: a queue entry
    keeps the URLs it was added with, and probing a dead signature is not a
    warm that might miss but a refusal per rendition, every heartbeat, for
    as long as the room takes to finish the video before it.

    Returns the source to warm — which is the queue entry itself when there
    is nothing to probe — or None when these URLs do not answer, which stops
    the caller fetching bytes from the same dead addresses.
    """
    original_url = video_data.get("original_url")
    if not original_url:
        return None
    known = (await get_cached_format(original_url)) or video_data
    source = await _playable_source(original_url, known, room_id,
                                    min_lifetime=STREAM_URL_MIN_LIFETIME_SECONDS)
    if source is None:
        return None
    video_formats, audio_formats = manifest_formats(source)
    if not video_formats or not audio_formats:
        # A direct file or an HLS playlist has no ladder and no index to
        # probe. There is nothing to prepare, but its opening bytes are
        # still worth warming — that is the whole prewarm for such a video —
        # so this is a source, not a failure.
        logger.debug("No adaptive ladder to prepare for %s", original_url)
        return source

    stream_owner.remember(source)
    identity = source.get(stream_owner.RESOLVED_BY_KEY)
    headers = {"User-Agent": DEFAULT_USER_AGENT, "Referer": "https://www.youtube.com/"}
    cookie_header = get_cookie_header(identity, video_formats[0]["url"]) if identity else None
    if cookie_header:
        headers["Cookie"] = cookie_header

    wanted = len(video_formats) + len(audio_formats)
    probed = await probe_formats(await get_proxy_client(),
                                 video_formats + audio_formats, headers)
    if not probed:
        # The individual refusals are debug, being speculative; this line is
        # not. The URLs are signed for now and still nothing could be read,
        # which is the shape of a cookie or PO-token problem — the only
        # production signal that warming is broken for a live resolve.
        logger.info("Prepared none of the %d representations of %s", wanted, original_url)
        return None
    logger.info("Prepared %d/%d representations of the next video: %s",
                probed, wanted, original_url)
    return source


def _warm_next_video_if_close(room_id: str, state: dict, position: float) -> None:
    """Prepare the next queue entry as the current video runs out."""
    if _proxy_client is None:
        return
    video = state.get("video_data") or {}
    duration = video.get("duration")
    if video.get("is_live") or not duration:
        return
    if float(duration) - position > PREWARM_NEXT_VIDEO_SECONDS:
        return
    upcoming = manager.peek_next_video(room_id)
    if upcoming:
        # The room is what makes a re-resolve possible for a video nobody
        # requested: its connected members are who can lend the cookies. It
        # also scopes the backoff, for the same reason. The start is warmed
        # on the rungs the room is watching now, where it will resume.
        prewarm.warm_video(_proxy_client, upcoming,
                           partial(_prepare_queued_video, room_id=room_id),
                           room_id=room_id,
                           rungs=prewarm.playing_rungs(video),
                           seconds=manager._resume_position(upcoming))


async def _refresh_entry(entry: dict, room_id: str, user_email: Optional[str]) -> dict:
    """Give a queue entry stream URLs that play now, in place.

    The same path every other resolve takes: the cached resolve when its
    signed URLs are still alive, otherwise a coalesced re-resolve with the
    room's cookies. An entry that could not be refreshed is returned as it
    was; the player re-resolves on its own when the CDN refuses it.
    """
    url = entry.get("original_url")
    if not url:
        return entry
    cached = await get_cached_format(url)
    known = cached or (entry if entry.get("stream_url") else None)
    try:
        if known is None:
            # Nothing stale to replace — a placeholder still being resolved,
            # typically. A plain resolve joins that extraction; a refresh
            # would start a second one of the same URL beside it.
            source = await resolve_url(url, room_id=room_id, user_email=user_email)
        else:
            source = await _playable_source(url, known, room_id,
                                            min_lifetime=STREAM_URL_SERVE_MIN_SECONDS,
                                            user_email=user_email)
    except HTTPException as exc:
        logger.info("Could not refresh %s for room %s: %s", url, room_id, exc.detail)
        source = None
    if source is None or source is entry:
        return entry
    room_fields = {key: entry[key] for key in ("original_url", "added_by", "pinned", "progress")
                   if key in entry}
    entry.clear()
    entry.update(source)
    entry.update(room_fields)
    entry.pop("pending", None)
    stream_owner.remember(entry)
    return entry


async def _start_entry(room_id: str, entry: dict, user_email: Optional[str],
                       _skipped: int = 0) -> None:
    """Hand the room the entry it just moved to, with URLs that play.

    Runs off the sender's socket loop: a refresh can be a yt-dlp run, and the
    sender's next messages must not queue behind it. By the time it is done
    the room may have moved on again, in which case nothing is announced.

    A queued placeholder that still cannot be resolved has nothing a player
    could load, so the room moves past it (a bounded number of times) rather
    than being handed an address with no stream.
    """
    await _refresh_entry(entry, room_id, user_email)
    if manager.room_states.get(room_id, {}).get("video_data") is not entry:
        return
    if entry.get("pending"):
        logger.info("Skipping %s in room %s: it could not be resolved", entry.get("original_url"), room_id)
        next_v, queue, playing_index, advanced = await manager.next_video(
            room_id, entry.get("original_url"))
        if not advanced:
            return
        await manager.broadcast({"type": "queue_update", "payload": {
            "queue": queue, "playing_index": playing_index}}, room_id)
        if next_v and _skipped < QUEUE_UNRESOLVABLE_SKIP_LIMIT:
            await _start_entry(room_id, next_v, user_email, _skipped + 1)
            return
        entry = None
    await manager.broadcast({"type": "set_video", "payload": {"video_data": entry}}, room_id)
    sponsor_skipper.video_changed(room_id)
    history_reporter.video_changed(room_id)


# Queue entries being resolved in the background, by room and URL.
_queued_resolves: set = set()


def _is_queueable_url(url) -> bool:
    if not (isinstance(url, str) and 0 < len(url) <= QUEUE_URL_MAX_LENGTH
            and url.startswith(("https://", "http://"))):
        return False
    try:
        parsed = urlparse(url)
        host = (parsed.hostname or "").lower()
    except ValueError:
        return False
    return not (host in {"youtube.com", "www.youtube.com", "m.youtube.com",
                         "music.youtube.com", "youtube-nocookie.com",
                         "www.youtube-nocookie.com"} and parsed.path == "/playlist")


async def _resolve_queued(room_id: str, url: str, user_email: Optional[str],
                          websocket: Optional[WebSocket] = None,
                          user_agent: Optional[str] = None) -> None:
    """Resolve a queued URL behind its placeholder, then fill it in.

    The sender no longer waits on yt-dlp to queue something: the room shows
    the entry at once and it becomes playable when this finishes. On
    failure the placeholder goes and the sender (if still connected) is told
    why. The ladder is probed straight away, so the manifest is free when
    the entry is reached.
    """
    key = (room_id, url)
    if key in _queued_resolves:
        return
    _queued_resolves.add(key)
    try:
        try:
            data = await resolve_url(url, user_agent, room_id=room_id, user_email=user_email)
        except HTTPException as exc:
            detail = str(exc.detail)
        except Exception as exc:
            logger.warning("Resolving queued %s failed: %s", url, str(exc)[:150])
            detail = "Could not resolve a playable stream URL."
        else:
            entry = await manager.resolve_pending(room_id, url, data)
            if entry is None:
                return  # Removed while it resolved.
            state = manager.room_states.get(room_id, {})
            await manager.broadcast({"type": "queue_update", "payload": {
                "queue": state.get("queue", []), "playing_index": state.get("playing_index", -1)}}, room_id)
            await publish_room_activity(room_id, "queue_added", user_email, entry)
            try:
                await _prepare_queued_video(entry, room_id)
            except Exception as exc:  # Speculation; the advance probes again.
                logger.debug("Probing queued %s failed: %s", url, exc)
            return
        if await manager.drop_pending(room_id, url):
            state = manager.room_states.get(room_id, {})
            await manager.broadcast({"type": "queue_update", "payload": {
                "queue": state.get("queue", []), "playing_index": state.get("playing_index", -1)}}, room_id)
        if websocket is not None:
            try:
                await websocket.send_json({"type": "resolve_failed",
                                           "payload": {"url": url, "detail": detail}})
            except Exception:
                pass  # The sender left; the placeholder going is the answer.
    finally:
        _queued_resolves.discard(key)


async def sync_heartbeat_task():
    """Background task for sync heartbeat - broadcasts authoritative time every 5 seconds."""
    consecutive_errors = 0
    while True:
        await asyncio.sleep(5)
        try:
            for room_id, state in list(manager.room_states.items()):
                if state.get("is_playing") and not state.get("startup_pending") and manager.active_connections.get(room_id):
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
                    # The room is about to need the next video; the beat that
                    # already knows where everyone is, is where that is seen.
                    _warm_next_video_if_close(room_id, state, sync_payload.get("timestamp", 0))
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
        await prewarm.shutdown()
        await shutdown_prefetch()
        await sponsor_skipper.client.aclose()
        await history_reporter.aclose()

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
app.include_router(admin_router)
app.include_router(user_settings_router)
app.include_router(browser_router)
app.include_router(playlists_router)


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
    # Any signed-in viewer may read this; it must not say who fetched what.
    return await proxy_metrics.snapshot(sample_limit=samples)


def _extract_with_options(url: str, ydl_opts: dict) -> dict:
    """Run yt-dlp for one option set. Blocking; call in a worker thread."""
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False, process=False)
        # A playlist or shortened link resolves to another URL first.
        if info.get("_type") == "url":
            info = ydl.extract_info(info["url"], download=False, process=False)
        return info


ROOM_ID_DISALLOWED = re.compile(r'[^a-zA-Z0-9_-]')


def sanitize_room_id(room_id: Optional[str]) -> str:
    """Room ids are alphanumeric plus hyphen and underscore; anything else is dropped."""
    return ROOM_ID_DISALLOWED.sub('', room_id or '')


@app.get("/api/resolve")
async def resolve_stream(
    request: Request,
    url: str = Query(..., description="The URL of the video/stream to resolve"),
    user_agent: str = Query(None, description="User agent from the client browser"),
    refresh: bool = Query(False, description="Replace a rejected cached stream URL"),
    room: str = Query(None, description="Room whose signed-in members may lend their cookies"),
):
    """
    Uses yt-dlp to resolve the input URL to a playable stream URL.
    """
    return await resolve_video(request, url, user_agent, refresh=refresh, room_id=sanitize_room_id(room))


_resolve_tasks: dict[tuple, asyncio.Task] = {}


async def resolve_video(request: Request, url: str, user_agent: str = None, *,
                        refresh: bool = False, room_id: str = "") -> dict:
    """Resolve for whoever is asking over HTTP."""
    return await resolve_url(url, user_agent, refresh=refresh, room_id=room_id,
                             user_email=get_user_from_request(request))


async def resolve_url(url: str, user_agent: str = None, *, refresh: bool = False,
                      room_id: str = "", user_email: Optional[str] = None) -> dict:
    """Share one extraction among everyone who needs the same answer.

    Takes the identity rather than the request, because not every resolve
    has one: the heartbeat re-resolves a queued video whose signed URLs the
    CDN no longer serves, on nobody's behalf, and the room's own members
    lend the cookies for it.

    Two requests need the same answer when they are for the same URL and
    would run with the same cookies — not when they come from the same
    person with the same user agent. A paste-time speculative resolve, the
    click that follows it, the manifest request and the heartbeat's warm
    are one extraction, not four. A request that would accept a cached
    answer also joins a refresh already under way, whose answer is fresher
    still; a refresh never joins a plain resolve, which may return exactly
    the stale entry it is meant to replace.
    """
    cookie_owner = choose_cookie_source(url, user_email, manager.member_emails(room_id))
    task = None if refresh else _resolve_tasks.get((url, cookie_owner, True))
    key = (url, cookie_owner, refresh)
    task = task or _resolve_tasks.get(key)
    if task is None:
        task = asyncio.create_task(_resolve_video(user_email, url, user_agent, refresh=refresh,
                                                  cookie_owner=cookie_owner))
        _resolve_tasks[key] = task
        def finished(done: asyncio.Task) -> None:
            _resolve_tasks.pop(key, None)
            if not done.cancelled():
                done.exception()  # Retrieve failures even if every caller disconnected.
        task.add_done_callback(finished)
    return await asyncio.shield(task)


async def _resolve_video(user_email: Optional[str], url: str, user_agent: str = None, *,
                         refresh: bool = False, cookie_owner: Optional[str] = None) -> dict:
    """Resolve a URL to playable streams and cache the result.

    Shared by `/api/resolve` and `/api/dash-manifest`: the manifest cannot
    be built without resolved formats, and requiring the caller to have
    resolved first turns an expired cache entry or a restarted backend into
    a dead end for anything already in a room's queue.

    `cookie_owner` is whose cookies the extraction runs with, chosen by the
    caller from the requester and the room (see `choose_cookie_source`):
    most members never install the extension, so the requester usually has
    none, and a member of the room signed in to the site lends theirs.
    """
    started = time.monotonic()
    # Serve a fresh resolution from the cache before extracting. Extraction
    # costs seconds of yt-dlp work per call, and the room multiplies calls:
    # the sender resolves once to paste, then the set_video broadcast makes
    # every member — sender included — resolve the same URL again. Signed
    # stream URLs stay valid for hours, so within the cache TTL those are
    # all the same answer.
    cached = None if refresh else await get_cached_format(url)
    if cached and cached.get("stream_url"):
        logger.info(f"Resolve cache hit: {url} (User: {user_email or 'anonymous'})")
        startup_timing.record_resolve(url, (time.monotonic() - started) * 1000,
                                      startup_timing.RESOLVE_CACHED)
        return cached

    logger.info(f"Resolving URL: {url} (User: {user_email or 'anonymous'})")

    os.makedirs(YTDLP_CACHE_DIR, exist_ok=True)

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
        'noplaylist': True,
        'ignore_no_formats_error': True,
        'cache_dir': YTDLP_CACHE_DIR,
        # The PO token provider address must be passed explicitly: the bgutil
        # plugin otherwise looks for it on localhost, gets no token, and
        # YouTube answers "Sign in to confirm you're not a bot" with no
        # playable formats.
        'extractor_args': dict(POT_PROVIDER_EXTRACTOR_ARGS),
    }

    # The cookie file exists only while the attempts below run; see
    # services/user_cookies for why cookies are never kept on disk.
    async with cookie_file(cookie_owner) as cookie_path:
        has_cookies = bool(cookie_path)
        if has_cookies:
            logger.info(f"Using cookies of {cookie_owner} for {user_email or 'anonymous'}")
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
        for attempt, (label, ydl_opts) in enumerate(attempts, start=1):
            try:
                attempt_started = time.monotonic()
                info = await asyncio.to_thread(_extract_with_options, url, ydl_opts)
                logger.info("%s took %.0f ms for %s", label,
                            (time.monotonic() - attempt_started) * 1000, url)
                stream_info = _extract_stream_url(info)

                if stream_info and stream_info.get('url'):
                    response = _build_resolve_response(url, info, stream_info)
                    # The stream URLs are bound to the session whose cookies
                    # fetched them; every later fetch of them must carry the
                    # same cookies, whoever asks. See services/stream_owner.
                    response[stream_owner.RESOLVED_BY_KEY] = cookie_owner if has_cookies else None
                    stream_owner.remember(response)
                    # Cache it so /api/dash-manifest can build a manifest for
                    # this video without resolving it again. Without this the
                    # manifest endpoint 404s on a freshly pasted link.
                    try:
                        await cache_format(url, response)
                    except Exception as exc:
                        logger.warning(f"Could not cache resolved format: {exc}")
                    startup_timing.record_resolve(
                        url, (time.monotonic() - started) * 1000, startup_timing.RESOLVE_EXTRACTED,
                        attempts=attempt, lent_by=cookie_owner if cookie_owner != user_email else None)
                    return response

                logger.info(f"{label}: no playable formats")
            except Exception as e:
                last_error = str(e)
                logger.info(f"{label} failed: {last_error[:150]}")

    startup_timing.record_resolve(url, (time.monotonic() - started) * 1000,
                                  startup_timing.RESOLVE_FAILED, attempts=len(attempts))
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
async def dash_manifest(request: Request, url: str, room: str = None):
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
        # Resolve it now rather than refusing. Stream URLs expire after a
        # couple of hours and the cache is in process memory, so anything
        # left in a room's queue — or any video after a restart — arrives
        # here with nothing cached. Refusing made pressing play on an older
        # queue item a permanent failure: the player asked for the manifest
        # before the page's own re-resolve had finished, got a 404, and
        # reported "the video could not be loaded".
        logger.info(f"Manifest requested for an unresolved video, resolving: {url}")
        cached = await resolve_video(request, url,
                                     request.headers.get("user-agent"),
                                     room_id=sanitize_room_id(room))
    else:
        # A cache entry can outlive the signature on the URLs it holds; every
        # probe of those answers 403 and the manifest comes back empty. Only
        # an expired entry is replaced here: a player is waiting, and a
        # source that signs short-lived URLs still plays.
        cached = await _playable_source(
            url, cached, sanitize_room_id(room),
            min_lifetime=STREAM_URL_SERVE_MIN_SECONDS,
            user_email=user_email,
            user_agent=request.headers.get("user-agent") or DEFAULT_USER_AGENT)
        if cached is None:
            raise HTTPException(status_code=422,
                                detail="Video stream URLs could not be refreshed")

    duration = cached.get("duration")
    if not duration:
        raise HTTPException(status_code=422, detail="Video duration is unknown")

    video_formats, audio_formats = manifest_formats(cached)

    if not video_formats or not audio_formats:
        raise HTTPException(status_code=422, detail="Video has no adaptive streams")

    proxy_base = _proxy_base(request)

    outgoing_headers = {
        "User-Agent": request.headers.get("user-agent", "Mozilla/5.0"),
        "Referer": "https://www.youtube.com/",
    }
    # Probes carry the cookies the URLs were signed for — the resolving
    # member's, not the requester's. With anyone else's cookies the CDN
    # refuses most renditions, each is silently dropped, and this member
    # ends up with a manifest of one or two qualities to "choose" from.
    stream_owner.remember(cached)
    fetch_identity = cached.get(stream_owner.RESOLVED_BY_KEY, user_email)
    cookie_header = get_cookie_header(fetch_identity, video_formats[0]["url"]) if fetch_identity else None
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
            source_url=url,
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


def _proxy_base(request: Request) -> str:
    """The absolute proxy prefix this request's host sees; manifests use it."""
    host = request.headers.get("host")
    proto = "https" if request.headers.get("x-forwarded-proto") == "https" else "http"
    return f"{proto}://{host}/api/proxy?url="


async def _announced_video(request: Request, url: str, room: Optional[str]) -> tuple:
    """The video a player's announcement is about, and the room it may borrow from.

    Only videos the server itself resolved: a cached resolve (what manifests
    are built from) or the room's current video or queue entry — never an
    arbitrary address. The room is dropped for anyone not connected to it:
    a room's members lend their cookies to its re-resolves, and an outsider
    does not get to trigger one. Returns (video or None, room id, identity).
    """
    user_email = get_user_from_request(request)
    if REQUIRE_AUTHENTICATION and not user_email:
        raise HTTPException(status_code=401, detail="User identity required")
    check_rate_limit(user_email or (request.client.host if request.client else "anonymous"),
                     scope="prewarm", max_requests=PREWARM_RATE_LIMIT_PER_MINUTE)
    room_id = sanitize_room_id(room)
    if room_id and not (user_email and _is_connected_to_room(room_id, user_email)):
        room_id = ""
    state = manager.room_states.get(room_id, {}) if room_id else {}
    candidates = [state.get("video_data")] + list(state.get("queue", []))
    video = await get_cached_format(url) or next(
        (entry for entry in candidates
         if isinstance(entry, dict) and entry.get("original_url") == url and not entry.get("pending")),
        None)
    return video, room_id, user_email


@app.get("/api/segment-spans")
async def segment_spans(
    request: Request,
    url: str = Query(..., max_length=QUEUE_URL_MAX_LENGTH, description="The video's original URL"),
    room: str = Query(None),
    t: float = Query(..., ge=0, le=PREWARM_MAX_POSITION_SECONDS, allow_inf_nan=False,
                     description="Where the jump lands, in seconds"),
    h: int = Query(PREWARM_DEFAULT_HEIGHT, ge=1, le=10_000, description="The rung the player is on"),
    codec: str = Query(None, max_length=8, description="Its video codec family"),
):
    """The exact requests a player will make to resume at `t`, to fetch early.

    A scheduled SponsorBlock skip is announced to the room ahead of time
    (`skip_upcoming`). Warming the server's cache for it still leaves every
    viewer a round trip to this server — Japan to Germany — after the jump.
    With these spans the player fetches the destination into its own cache
    beforehand, so the jump plays from memory in the page.

    Each span is the proxied URI exactly as the manifest addresses it and
    the byte range the player requests, for the rung and codec given, plus
    audio. Only renditions whose index has been read are described; the
    server warms the same spans so the player's own fetches hit memory.
    """
    video, _room_id, _user = await _announced_video(request, url, room)
    if not video:
        return {"spans": []}
    family = codec if codec in PREWARM_CODEC_PREFERENCE else None
    urls = prewarm.choose_renditions(video, [(h, family)])
    spans = prewarm.spans_at(urls, t)
    if spans and _proxy_client is not None:
        prewarm.warm_position(_proxy_client, video, t,
                              identity=video.get(stream_owner.RESOLVED_BY_KEY), urls=urls)
    proxy_base = _proxy_base(request)
    return {"spans": [{"uri": proxied_url(stream_url, proxy_base), "start": start, "end": end}
                      for stream_url, start, end in spans]}


@app.get("/api/prewarm", status_code=202)
async def prewarm_start(
    request: Request,
    url: str = Query(..., max_length=QUEUE_URL_MAX_LENGTH, description="The video's original URL"),
    room: str = Query(None),
    t: float = Query(0.0, ge=0, le=PREWARM_MAX_POSITION_SECONDS, allow_inf_nan=False,
                     description="Where the start or jump lands, in seconds"),
    h: int = Query(PREWARM_DEFAULT_HEIGHT, ge=1, le=10_000, description="Tallest rung the player may open on"),
    codec: str = Query(None, max_length=8, description="Video codec family the player will pick"),
):
    """Warm the bytes a start or jump a viewer is about to make will ask for.

    The player announces it — a video about to load, the pointer resting on
    the seek bar, a queue row about to be clicked — and the server probes
    the video's ladder (coalesced with any manifest build) and fetches the
    exact subsegments covering `t` on the rung the player will open on,
    while the player is still on its way. Answers at once; the work is
    speculative, bounded and deduplicated (services/prewarm).

    Only videos the server itself resolved are warmed — the room's current
    video or queue entry for `url`, or a cached resolve — so this is never a
    way to have the server fetch an arbitrary address.
    """
    video, room_id, _user = await _announced_video(request, url, room)
    if not video:
        return {"status": "unknown"}
    family = codec if codec in PREWARM_CODEC_PREFERENCE else None
    prewarm.warm_video(await get_proxy_client(), video,
                       partial(_prepare_queued_video, room_id=room_id),
                       room_id=room_id, rungs=[(h, family)], seconds=t)
    return {"status": "accepted"}


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

    request_started = time.monotonic()

    # The proxy fetches upstream content on the caller's behalf, so it must
    # know who the caller is before doing any work.
    user_email = get_user_from_request(request)
    if REQUIRE_AUTHENTICATION and not user_email:
        raise HTTPException(status_code=401, detail="User identity required")

    # A bare GET for a whole large media file is never a player; refuse it
    # before spending a DNS lookup or an upstream connection on it.
    if is_whole_file_grab(url, request.headers.get("range")):
        logger.warning(
            f"Refused whole-file media download of {url[:80]} "
            f"(user {user_email or 'anonymous'}, UA {request.headers.get('user-agent', '?')[:60]})")
        raise HTTPException(
            status_code=403,
            detail="Whole-file media downloads are not served; players request byte ranges")

    # SSRF protection is applied where a connection is made: every upstream
    # fetch goes through services/upstream, which validates the host, pins
    # the address it validated and re-validates every redirect. A request
    # answered from cache contacts nothing, so it costs no DNS lookup — and
    # a cached body was validated when it was fetched.

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

    proxy_base = _proxy_base(request)

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

    # A stream URL a resolve produced is fetched with the cookies it was
    # signed for — the resolving member's — so every member gets the same
    # bytes and shares one cache entry. Anything else is fetched with the
    # caller's own cookies, and never another user's: content fetched with
    # cookies is cached under that identity so it cannot be served to
    # someone else from a shared entry.
    fetcher = stream_owner.fetcher_for(url, user_email)
    fetch_identity = fetcher.identity
    if fetcher.cookie:
        outgoing_headers["Cookie"] = fetcher.cookie
    cache_identity = fetcher.cache_identity

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
            session = await get_or_create_session(url, is_audio=is_audio, identity=fetch_identity)
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

            # googlevideo serves a Range header through its throttled
            # progressive path and the `range=` query parameter at full
            # speed. Measured on one rendition, 1 MB at the same offset:
            # 122 ms via the header, 29 ms via the parameter. That gap is
            # invisible while the buffer is ahead and decisive when it is
            # empty and has to be refilled before anything can play — a
            # seek. Declining leaves the request exactly as it was.
            media_range = rewrite_range(url, range_start, range_end) if range_header else None
            upstream_url = url
            if media_range:
                upstream_url = media_range.url
                # The response will be a plain 200 of exactly these bytes,
                # so the range this proxy answers is now fully known.
                range_start, range_end = media_range.start, media_range.end
                outgoing_headers.pop("Range", None)

            # Notify prefetcher about this segment request (triggers prefetch of next segments)
            await notify_segment_for_url(url, identity=fetch_identity)

            # Check memory cache first (fastest). The key spans the whole
            # requested range: a 206 has to answer exactly what was asked
            # for, and a body cached for a different range is not an answer.
            segment_cache_key = get_segment_cache_key(
                url, range_start, range_end, identity=cache_identity)
            is_audio = is_audio_url(url)
            if range_header:
                # Which rendition the room is on is only visible here: the
                # player chooses it and never says so. A skip is warmed on
                # what is being fetched, not on what the resolve preferred.
                prewarm.note_active_stream(url)
                # Read ahead from the subsegment after this one. It never
                # includes the bytes asked for here, so it cannot race this
                # request for them.
                prefetch_ahead(segment_client, url, range_start, fetch_identity)
            finite_range = bool(range_header and range_end is not None
                                and re.fullmatch(r'bytes=\d+-\d*', range_header))

            async def from_memory():
                found = await memory_cache.get(segment_cache_key)
                if found is None and finite_range:
                    found = await memory_cache.get_range(url, range_start, range_end, cache_identity)
                return found

            mem_result = await from_memory()
            # A warm (or another viewer) may be fetching these very bytes
            # right now; waiting for that is faster than fetching them again
            # alongside it, and leaves the link to one copy.
            if mem_result is None and finite_range and await inflight.join(
                    url, range_start, range_end, cache_identity, INFLIGHT_JOIN_TIMEOUT_SECONDS):
                mem_result = await from_memory()
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

                # A hit used to return without recording anything, so the
                # metrics described only the requests that missed: a viewer
                # served from cache looked like a viewer who had stopped
                # watching.
                await proxy_metrics.record(
                    host=hostname,
                    status=206 if serve_partial else 200,
                    outcome=OUTCOME_OK,
                    upstream_ms=0.0,
                    transfer_ms=(time.monotonic() - request_started) * 1000,
                    bytes_sent=len(data),
                    range_start=range_start,
                    expected_bytes=len(data),
                    identity=user_email,
                    cache_tier=TIER_MEMORY,
                )

                return Response(
                    content=data,
                    media_type=content_type,
                    status_code=206 if serve_partial else 200,
                    headers=cached_headers,
                )

            # Persistent cache for this exact range. Keyed on the whole
            # range and storing the origin's Content-Range, so a hit is
            # byte-identical to the miss it replaces and can state what it
            # is. This is what makes a re-watch, a seek backwards, or a
            # second viewer in the room free instead of another trip to the
            # CDN.
            _, disk_cache_path = get_segment_disk_key(
                url, range_start, range_end, identity=cache_identity)
            disk_meta_path = disk_cache_path + ".meta"

            if os.path.exists(disk_cache_path) and os.path.exists(disk_meta_path):
                try:
                    async with aiofiles.open(disk_meta_path, 'r') as f:
                        disk_meta = json.loads(await f.read())

                    stored_range = disk_meta.get("content_range")
                    # A partial response must be able to describe itself.
                    if range_header and not stored_range:
                        raise ValueError("cached entry cannot describe its range")

                    # Open before responding: the janitor may remove the file
                    # between the existence check and the first read.
                    cache_file = await aiofiles.open(disk_cache_path, 'rb')
                    try:
                        os.utime(disk_cache_path, None)
                    except (FileNotFoundError, OSError):
                        pass

                    async def iter_cached():
                        served = 0
                        outcome = OUTCOME_OK
                        try:
                            while True:
                                chunk = await cache_file.read(64 * 1024)
                                if not chunk:
                                    break
                                served += len(chunk)
                                yield chunk
                        except (asyncio.CancelledError, ConnectionResetError):
                            # The viewer navigated away or seeked: their
                            # business, not a failure of ours.
                            outcome = OUTCOME_CLIENT_ABORTED
                            raise
                        finally:
                            await cache_file.close()
                            await proxy_metrics.record(
                                host=hostname,
                                status=206 if (range_header and stored_range) else 200,
                                outcome=outcome,
                                upstream_ms=0.0,
                                transfer_ms=(time.monotonic() - request_started) * 1000,
                                bytes_sent=served,
                                range_start=range_start,
                                expected_bytes=disk_meta.get("size"),
                                identity=user_email,
                                cache_tier=TIER_DISK,
                            )

                    cached_headers = {
                        "Access-Control-Allow-Origin": "*",
                        "Accept-Ranges": "bytes",
                        "Cache-Control": "private, no-store, no-transform",
                        "Content-Type": disk_meta.get("content_type", "video/mp4"),
                    }
                    if range_header and stored_range:
                        cached_headers["Content-Range"] = stored_range
                    # Without a length the reply goes out chunked, and a
                    # partial body whose length the player cannot check up
                    # front is treated as a mismatch.
                    stored_size = disk_meta.get("size")
                    if isinstance(stored_size, int) and stored_size >= 0:
                        cached_headers["Content-Length"] = str(stored_size)

                    logger.info(f"DISK HIT: {url[:60]}... range={range_header or 'full'}")
                    return StreamingResponse(
                        iter_cached(),
                        status_code=206 if (range_header and stored_range) else 200,
                        headers=cached_headers,
                    )
                except FileNotFoundError:
                    logger.warning(f"Disk cache entry vanished: {disk_cache_path}")
                except Exception as e:
                    logger.warning(f"Disk cache read error: {e}")

            # Fetch from upstream. From here until its bytes are in memory,
            # another request for them waits for this one (services/inflight)
            # rather than fetching them again. The caching stream releases it
            # when it ends; every other way out releases it below.
            joinable = (inflight.fetching(url, range_start, range_end, cache_identity)
                        if range_end is not None else contextlib.nullcontext())
            joinable.__enter__()
            handed_off = False
            try:
                upstream_started = time.monotonic()
                r, pinned = await open_upstream_stream(
                    segment_client, upstream_url, outgoing_headers)
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

                # A range moved into the query comes back as a 200, so the
                # partial response this proxy owes its caller is described
                # here. The length the origin actually sent is authoritative:
                # a 206 whose body and Content-Range disagree is rejected.
                # Lower-case keys throughout, matching the copy above: HTTP
                # header names are case-insensitive but dict lookups are not,
                # and the stored Content-Range is read back by key.
                status_code = r.status_code
                if media_range and r.status_code == 200:
                    sent = int(r.headers.get("content-length", 0)) or media_range.length
                    end = media_range.start + sent - 1
                    response_headers["content-range"] = (
                        f"bytes {media_range.start}-{end}/{media_range.total}")
                    response_headers["content-length"] = str(sent)
                    status_code = 206

                # Check if we should cache
                should_cache = r.status_code in (200, 206)
                disk_ok, _ = check_disk_space()
                if not disk_ok:
                    should_cache = False
                content_length = int(r.headers.get("content-length", 0))
                if content_length > MAX_CACHEABLE_FILE_BYTES:
                    should_cache = False
                # A full cache evicts to admit new content. Refusing the write
                # instead — which is what this did — means the first entries to
                # arrive keep the space and everything later goes uncached.
                if should_cache and not make_room(content_length):
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
                    _, cache_path = get_segment_disk_key(
                        url, range_start, range_end, identity=cache_identity)
                    cache_meta_path = cache_path + ".meta"

                    # make_room reserved this many bytes; a write that never
                    # lands must hand them back or seeking fills the budget with
                    # phantom reservations and caching refuses again.
                    reserved_bytes = content_length

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

                            # A body shorter than the origin promised must not
                            # enter the cache: its meta would claim the full
                            # Content-Range, and a later disk hit would replay a
                            # 206 whose body does not match — which players
                            # reject and intermediaries turn into a 416.
                            complete = not expected_bytes or total == expected_bytes
                            if r.status_code in (200, 206) and complete:
                                os.rename(temp_path, cache_path)
                                meta = {
                                    "range_start": range_start,
                                    "range_end": range_end,
                                    "size": total,
                                    # Replayed verbatim on a hit: a 206 that cannot
                                    # state its range is rejected downstream. Read
                                    # from the response being sent, not from the
                                    # origin's headers — a range moved into the
                                    # query comes back as a 200 with no
                                    # Content-Range, and the one that matters is
                                    # the one this proxy synthesised.
                                    "content_range": response_headers.get("content-range"),
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
                                        content_range=response_headers.get("content-range"),
                                    )
                                    logger.info(f"Added to memory cache: {url[:60]}... ({total} bytes)")

                                    # Mark content as active
                                    url_hash = segment_cache_key.split('_')[1] if '_' in segment_cache_key else None
                                    if url_hash:
                                        await mark_content_active(url_hash)
                            else:
                                if os.path.exists(temp_path):
                                    os.remove(temp_path)
                                release_room(reserved_bytes)
                        except asyncio.CancelledError:
                            # Only an abort if the client left mid-body. A
                            # cancellation after full delivery is the normal end
                            # of a streamed response.
                            if not expected_bytes or total < expected_bytes:
                                outcome = OUTCOME_CLIENT_ABORTED
                            if os.path.exists(temp_path):
                                os.remove(temp_path)
                                release_room(reserved_bytes)
                            raise
                        except Exception as e:
                            outcome = OUTCOME_TRUNCATED
                            transfer_error = f"{type(e).__name__}: {e}"
                            logger.warning(f"Cache error: {e}")
                            if os.path.exists(temp_path):
                                os.remove(temp_path)
                                release_room(reserved_bytes)
                        finally:
                            joinable.__exit__(None, None, None)
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
                                identity=user_email,
                            )

                    handed_off = True
                    return StreamingResponse(stream_and_cache(), status_code=status_code, headers=response_headers)
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
                                identity=user_email,
                            )

                    return StreamingResponse(stream_only(), status_code=status_code, headers=response_headers)
            finally:
                if not handed_off:
                    joinable.__exit__(None, None, None)

    except UnsafeUpstreamError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
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
            identity=user_email,
        )
        raise HTTPException(status_code=500, detail=f"Proxy error: {e}")


# ============================================================================
# WebSocket Handler
# ============================================================================

async def publish_room_activity(
    room_id: str,
    action: str,
    actor: Optional[str] = None,
    video: Optional[dict] = None,
    **details,
) -> None:
    """Persist and broadcast one activity derived by the server."""
    activity = await manager.record_activity(
        room_id, action, actor=actor, video=video, **details)
    if activity:
        await manager.broadcast({
            "type": "activity",
            "payload": {"activity": activity},
        }, room_id)


@app.websocket("/ws/{room_id}")
async def websocket_endpoint(websocket: WebSocket, room_id: str):
    """WebSocket handler for room synchronization."""
    # H1: Sanitize room ID to prevent injection attacks
    room_id = sanitize_room_id(room_id)
    if not room_id:
        await websocket.close(code=4000, reason="Invalid room ID")
        return

    user_email = get_user_from_websocket(websocket)
    if not user_email:
        if REQUIRE_AUTHENTICATION:
            await websocket.close(code=4003, reason="Authentication required")
            return
        user_email = GUEST_IDENTITY

    # Connection limits are checked atomically inside connect() under _state_lock
    connected = await manager.connect(
        websocket, room_id, user_email,
        max_per_room=MAX_CONNECTIONS_PER_ROOM,
        max_per_user=MAX_CONNECTIONS_PER_USER,
    )
    if not connected:
        return
    # A room restored from the database, or one whose last member left
    # mid-video, has no segments loaded yet.
    sponsor_skipper.ensure_loaded(room_id)
    history_reporter.member_joined(room_id, user_email)
    # A placeholder whose resolve a restart cut short would otherwise stay
    # "resolving" for good.
    for entry in list(manager.room_states.get(room_id, {}).get("queue", [])):
        if entry.get("pending") and entry.get("original_url"):
            _run_detached(_resolve_queued(room_id, entry["original_url"],
                                          entry.get("added_by") or user_email))
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
            
            if msg_type == "playback_ready":
                if await manager.playback_ready(room_id, payload.get("original_url")):
                    sponsor_skipper.rearm(room_id)
                    history_reporter.rearm(room_id)

            elif msg_type == "play":
                state = manager.room_states.get(room_id, {})
                was_playing = state.get("is_playing", False)
                current_video = state.get("video_data")
                await manager.update_state(room_id, {"is_playing": True, "timestamp": payload.get("timestamp", 0)})
                await manager.broadcast({"type": "play", "payload": payload}, room_id, exclude=websocket)
                if current_video and not was_playing:
                    await publish_room_activity(
                        room_id, "playback_resumed", user_email, current_video)
                sponsor_skipper.rearm(room_id)
                history_reporter.rearm(room_id)

            elif msg_type == "pause":
                state = manager.room_states.get(room_id, {})
                was_playing = state.get("is_playing", False)
                current_video = state.get("video_data")
                await manager.update_state(room_id, {"is_playing": False, "timestamp": payload.get("timestamp", 0)})
                await manager.broadcast({"type": "pause", "payload": payload}, room_id, exclude=websocket)
                if current_video and was_playing:
                    await publish_room_activity(
                        room_id, "playback_paused", user_email, current_video)
                sponsor_skipper.rearm(room_id)
                history_reporter.rearm(room_id)

            elif msg_type == "seek":
                seek_timestamp = payload.get("timestamp", 0)
                current_video = manager.room_states.get(room_id, {}).get("video_data")
                await manager.update_state(room_id, {"timestamp": seek_timestamp})
                await manager.broadcast({"type": "seek", "payload": payload}, room_id, exclude=websocket)
                if current_video and isinstance(seek_timestamp, (int, float)):
                    await publish_room_activity(
                        room_id, "playback_seeked", user_email, current_video,
                        timestamp=max(0, seek_timestamp))
                sponsor_skipper.rearm(room_id)
                history_reporter.rearm(room_id)
                
            elif msg_type == "set_video":
                video_data = payload.get("video_data")
                if video_data:
                    video_data["added_by"] = user_email
                    if video_data.get("original_url"):
                        stream_owner.sanitize_client_video(
                            video_data, await get_cached_format(video_data["original_url"]))
                        await cache_format(video_data["original_url"], video_data, preserve_expiry=True)

                next_v, queue, playing_index = await manager.prepend_to_queue(room_id, video_data)
                if next_v:
                    await manager.broadcast({"type": "set_video", "payload": {"video_data": next_v}}, room_id)
                    await manager.broadcast({"type": "queue_update", "payload": {"queue": queue, "playing_index": playing_index}}, room_id)
                    await publish_room_activity(
                        room_id, "video_started", user_email, next_v)
                    sponsor_skipper.video_changed(room_id)
                    history_reporter.video_changed(room_id)

            elif msg_type == "queue_add":
                # Queued by address; the server resolves it behind a
                # placeholder, so adding never waits on an extraction.
                url = payload.get("url") if isinstance(payload, dict) else None
                if not _is_queueable_url(url):
                    logger.warning(f"Rejected queue_add from {user_email} in room {room_id}")
                    continue
                queue, pending = await manager.queue_url(room_id, url, user_email)
                state = manager.room_states.get(room_id, {})
                await manager.broadcast({"type": "queue_update", "payload": {"queue": queue, "playing_index": state.get("playing_index", -1)}}, room_id)
                if pending is not None:
                    _run_detached(_resolve_queued(room_id, pending["original_url"], user_email, websocket,
                                                  websocket.headers.get("user-agent")))
                else:
                    requeued = queue[-1] if queue else None
                    if requeued:
                        await publish_room_activity(room_id, "queue_added", user_email, requeued)

            elif msg_type == "queue_remove":
                state = manager.room_states.get(room_id, {})
                index = payload.get("index")
                removed_video = None
                if (isinstance(index, int) and 0 <= index < len(state.get("queue", []))
                        and index != state.get("playing_index", -1)):
                    removed_video = state["queue"][index].copy()
                queue = await manager.remove_from_queue(room_id, index)
                state = manager.room_states.get(room_id, {})
                await manager.broadcast({"type": "queue_update", "payload": {"queue": queue, "playing_index": state.get("playing_index", -1)}}, room_id)
                if removed_video:
                    await publish_room_activity(
                        room_id, "queue_removed", user_email, removed_video)

            elif msg_type == "queue_reorder":
                state = manager.room_states.get(room_id, {})
                old_index = payload.get("old_index")
                new_index = payload.get("new_index")
                moved_video = None
                if (isinstance(old_index, int) and isinstance(new_index, int)
                        and old_index != new_index
                        and 0 <= old_index < len(state.get("queue", []))
                        and 0 <= new_index < len(state.get("queue", []))):
                    moved_video = state["queue"][old_index].copy()
                queue = await manager.reorder_queue(room_id, old_index, new_index)
                state = manager.room_states.get(room_id, {})
                await manager.broadcast({"type": "queue_update", "payload": {"queue": queue, "playing_index": state.get("playing_index", -1)}}, room_id)
                if moved_video:
                    await publish_room_activity(
                        room_id, "queue_reordered", user_email, moved_video,
                        position=new_index + 1)

            elif msg_type == "queue_pin":
                state = manager.room_states.get(room_id, {})
                index = payload.get("index")
                pinned_video = None
                was_pinned = False
                if isinstance(index, int) and 0 <= index < len(state.get("queue", [])):
                    pinned_video = state["queue"][index].copy()
                    was_pinned = bool(pinned_video.get("pinned", False))
                queue = await manager.toggle_pin(room_id, index)
                state = manager.room_states.get(room_id, {})
                await manager.broadcast({"type": "queue_update", "payload": {"queue": queue, "playing_index": state.get("playing_index", -1)}}, room_id)
                if pinned_video:
                    await publish_room_activity(
                        room_id, "queue_unpinned" if was_pinned else "queue_pinned",
                        user_email, pinned_video)

            elif msg_type == "queue_play":
                next_v, queue, playing_index = await manager.play_from_queue(room_id, payload.get("index"))
                await manager.broadcast({"type": "queue_update", "payload": {"queue": queue, "playing_index": playing_index}}, room_id)
                if next_v:
                    await publish_room_activity(
                        room_id, "video_started", user_email, next_v)
                    _run_detached(_start_entry(room_id, next_v, user_email))

            elif msg_type == "video_ended":
                # `original_url` names the video the sender's player finished;
                # once the room has moved on, later reports of the same end
                # are dropped rather than advancing the queue again.
                ended_url = payload.get("original_url") if isinstance(payload, dict) else None
                ended_video = manager.room_states.get(room_id, {}).get("video_data")
                next_v, queue, playing_index, advanced = await manager.next_video(
                    room_id, ended_url if isinstance(ended_url, str) else None)
                if advanced:
                    await manager.broadcast({"type": "queue_update", "payload": {"queue": queue, "playing_index": playing_index}}, room_id)
                    if ended_video:
                        await publish_room_activity(
                            room_id,
                            "video_finished" if isinstance(ended_url, str) else "video_skipped",
                            None if isinstance(ended_url, str) else user_email,
                            ended_video,
                        )
                    if next_v:
                        await publish_room_activity(
                            room_id, "video_started", None, next_v)
                        _run_detached(_start_entry(room_id, next_v, user_email))
                    else:
                        await manager.broadcast({"type": "set_video", "payload": {"video_data": None}}, room_id)
                        sponsor_skipper.video_changed(room_id)
                        history_reporter.video_changed(room_id)
                        await publish_room_activity(
                            room_id, "playback_stopped", None)

            elif msg_type == "promote":
                target = payload.get("target_email")
                role = payload.get("role")
                if target and role and await manager.promote_user(room_id, user_email, target, role):
                    state = manager.room_states.get(room_id, {})
                    await manager.broadcast({"type": "roles_update", "payload": {"roles": state.get("roles", {})}}, room_id)
                    await publish_room_activity(
                        room_id, "role_changed", user_email,
                        target=target, role=role)
            
            elif msg_type == "toggle_permanent":
                if await manager.toggle_permanent(room_id, user_email):
                    state = manager.room_states.get(room_id, {})
                    await manager.broadcast({
                        "type": "room_settings_update",
                        "payload": {"permanent": state.get("permanent", False)}
                    }, room_id)
                    await publish_room_activity(
                        room_id, "room_permanence_changed", user_email,
                        enabled=state.get("permanent", False))

            elif msg_type == "rename_room":
                if await manager.rename_room(room_id, user_email, payload.get("name")):
                    state = manager.room_states.get(room_id, {})
                    await manager.broadcast({
                        "type": "room_settings_update",
                        "payload": {
                            "permanent": state.get("permanent", False),
                            "name": state.get("name", ""),
                        }
                    }, room_id)
                    await publish_room_activity(
                        room_id, "room_renamed", user_email,
                        name=state.get("name", ""))
                else:
                    # Refusing in silence reads as a broken button: the
                    # header sits behind the settings modal and the address
                    # never changes, so the sender sees nothing at all.
                    logger.info(f"Refused rename of {room_id} by {user_email}")
                    await websocket.send_json({
                        "type": "error",
                        "payload": {"message": "Only the room admin can rename this room"},
                    })
            
            elif msg_type == "sponsorblock_settings":
                applied = await manager.set_sponsorblock(room_id, user_email, payload)
                if applied is not None:
                    await manager.broadcast({
                        "type": "room_settings_update",
                        "payload": {"sponsorblock": applied},
                    }, room_id)
                    await publish_room_activity(
                        room_id, "sponsorblock_changed", user_email,
                        enabled=applied.get("enabled", False))
                    sponsor_skipper.rearm(room_id)
                else:
                    logger.info(f"Refused SponsorBlock settings change in {room_id} by {user_email}")
                    await websocket.send_json({
                        "type": "error",
                        "payload": {"message": "Only the room admin can change SponsorBlock settings"},
                    })

            elif msg_type == "share_start":
                # One member puts their own screen on the room's player.
                # Whatever was playing stops where it is; its position is
                # already recorded on its queue entry, so ending the share
                # returns the room to it.
                share = manager.start_share(
                    room_id, websocket,
                    title=str(payload.get("title") or "")[:SHARE_TITLE_MAX_LENGTH],
                    quality=str(payload.get("quality") or "")[:SHARE_QUALITY_MAX_LENGTH],
                )
                if share is None:
                    await websocket.send_json({
                        "type": "error",
                        "payload": {"message": "Someone else is already sharing in this room"},
                    })
                else:
                    try:
                        # The relay is opened here rather than when the media
                        # socket arrives, so that a viewer reacting to the
                        # announcement below has something to attach to.
                        share_relay.open(room_id, share["connection_id"], user_email)
                    except RelayRefused as refused:
                        manager.stop_share(room_id, websocket)
                        await websocket.send_json({
                            "type": "error",
                            "payload": {"message": refused.message},
                        })
                    else:
                        await manager.update_state(room_id, {"is_playing": False})
                        await manager.broadcast({"type": "share_started", "payload": share}, room_id)
                        await publish_room_activity(
                            room_id, "share_started", actor=user_email,
                            video={"title": share["title"]} if share["title"] else None)

            elif msg_type == "share_stop":
                share = manager.stop_share(room_id, websocket)
                if share:
                    # The media socket goes with it: nothing may keep
                    # arriving for a share the room has been told is over.
                    share_relay.end(room_id)
                    await manager.broadcast({
                        "type": "share_ended",
                        "payload": {"reason": "stopped", "email": share["email"]},
                    }, room_id)
                    await publish_room_activity(room_id, "share_ended", actor=user_email)

            elif msg_type == "browser_open":
                # The shared browser takes the player, the way a screen share
                # does: whatever was playing stops where it is, and its
                # position is on its queue entry so closing returns to it.
                if not shared_browser.is_available():
                    await websocket.send_json({
                        "type": "error",
                        "payload": {"message": "The shared browser is not available on this instance"},
                    })
                else:
                    session, refusal = manager.open_browser(
                        room_id, websocket,
                        title=str(payload.get("title") or "")[:BROWSER_TITLE_MAX_LENGTH],
                    )
                    if session is None:
                        message = (
                            "Someone is sharing their screen in this room"
                            if refusal == BROWSER_BUSY_LIVE_SHARE
                            else "Another room is using the shared browser"
                        )
                        await websocket.send_json({
                            "type": "error", "payload": {"message": message}})
                    else:
                        await manager.update_state(room_id, {"is_playing": False})
                        await manager.broadcast(
                            {"type": "browser_opened", "payload": session}, room_id)
                        await publish_room_activity(
                            room_id, "browser_opened", actor=user_email)

            elif msg_type == "browser_close":
                session = manager.close_browser(room_id, websocket)
                if session:
                    await manager.broadcast({
                        "type": "browser_closed",
                        "payload": {"reason": "closed", "email": session["opened_by"]},
                    }, room_id)
                    await publish_room_activity(room_id, "browser_closed", actor=user_email)

            elif msg_type == "playback_timing":
                # Diagnostic only, like playback_quality below: how long this
                # viewer's start took, phase by phase. See services/startup_timing.
                startup_timing.record_start(room_id, user_email, payload)

            elif msg_type == "playback_quality":
                # Diagnostic only: never broadcast, never persisted. A change
                # is logged at INFO so the host can read it without a browser.
                manager.record_playback_quality(websocket, payload, room_id)

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
        history_reporter.member_left(room_id, user_email)


def _is_connected_to_room(room_id: str, user_email: str) -> bool:
    """Whether this identity holds a room socket for this room right now.

    A screen share is for the people in the room. The media socket is a
    second connection, so it has to check for itself that whoever opened it
    is actually here — otherwise anyone who can authenticate could watch any
    room's share without ever joining it, and without appearing in it.
    """
    return any(
        getattr(ws, "user_email", GUEST_IDENTITY) == user_email
        for ws in manager.active_connections.get(room_id, [])
    )


@app.websocket("/ws/share/{room_id}")
async def share_media_endpoint(websocket: WebSocket, room_id: str):
    """The screen share's media, in and out.

    Deliberately not the room socket. Play, pause and seek have to arrive
    the moment they are sent, and a WebSocket delivers in order: a megabyte
    of video queued in front of a pause would hold the pause behind it, and
    the room would drift by exactly as long as the video took to flush.
    Two sockets, two queues, one of which may fall behind without taking
    synchronisation with it.

    `?role=publisher` is the sharer pushing chunks up, `?role=viewer` is
    everyone else pulling them down. Identity is resolved exactly as the
    room socket resolves it, and a publisher additionally has to *be* the
    room's current sharer — otherwise a member could push frames into a
    room somebody else is sharing in.
    """
    room_id = sanitize_room_id(room_id)
    if not room_id:
        await websocket.close(code=4000, reason="Invalid room ID")
        return

    user_email = get_user_from_websocket(websocket)
    if not user_email:
        if REQUIRE_AUTHENTICATION:
            await websocket.close(code=4003, reason="Authentication required")
            return
        user_email = GUEST_IDENTITY

    role = websocket.query_params.get("role")
    if role == "publisher":
        await _share_publisher_socket(websocket, room_id, user_email)
    elif role == "viewer":
        await _share_viewer_socket(websocket, room_id, user_email)
    else:
        await websocket.close(code=SHARE_CLOSE_PROTOCOL, reason="Unknown role")


async def _share_publisher_socket(websocket: WebSocket, room_id: str, user_email: str):
    """Take one member's encoded screen and hand every chunk to the relay."""
    connection_id = websocket.query_params.get("connection", "")
    share = manager.share_of(room_id)
    # Both halves matter. The connection id is public inside the room — it
    # is in the sync payload — so on its own it proves nothing; the verified
    # identity is what makes it the sharer's.
    if share is None:
        await websocket.accept()
        await websocket.close(code=SHARE_CLOSE_NO_SHARE,
                              reason="Nobody is sharing in this room")
        return
    if share["connection_id"] != connection_id or share["email"] != user_email:
        logger.warning(
            f"Refused screen share media from {user_email} in {room_id}: "
            f"{share['email']} holds the share"
        )
        await websocket.accept()
        await websocket.close(code=SHARE_CLOSE_NOT_AUTHORIZED,
                              reason="You are not the member sharing in this room")
        return

    await websocket.accept()
    try:
        relay = share_relay.attach_publisher(room_id, connection_id)
    except RelayRefused as refused:
        logger.info(f"Refused a share relay in {room_id}: {refused.message}")
        await websocket.close(code=refused.code, reason=refused.message)
        return

    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break
            # Every message, of either kind, is checked against *this*
            # socket's relay rather than against the room's. A share that
            # ended while its media socket stayed open — the sharer's room
            # connection dropped, an admin stopped it — leaves this handler
            # parked here, and by then the room may belong to somebody
            # else's share. Addressing the room by name would let those
            # bytes land in it.
            if share_relay.relay_of(room_id) is not relay:
                logger.info(
                    f"Share media from {user_email} in {room_id} outlived its "
                    f"share; closing the connection"
                )
                await websocket.close(code=SHARE_CLOSE_NO_SHARE,
                                      reason="This share is no longer running")
                break

            chunk = message.get("bytes")
            if chunk is not None:
                if len(chunk) > SHARE_CHUNK_MAX_BYTES:
                    logger.warning(
                        f"Oversized share chunk from {user_email} in {room_id}: "
                        f"{len(chunk)} bytes"
                    )
                    await websocket.close(code=SHARE_CLOSE_PROTOCOL,
                                          reason="Media chunk too large")
                    break
                if relay.mime is None:
                    # Without the format there is no SourceBuffer to append
                    # to, so the bytes could only ever be discarded.
                    logger.warning(
                        f"Share media from {user_email} in {room_id} before the "
                        f"format was announced"
                    )
                    await websocket.close(code=SHARE_CLOSE_PROTOCOL,
                                          reason="The format must be announced first")
                    break
                try:
                    share_relay.publish(room_id, chunk)
                except RelayRefused as refused:
                    await websocket.close(code=refused.code, reason=refused.message)
                    break
                continue

            text = message.get("text")
            if not text:
                continue
            if len(text) > SHARE_CONTROL_MAX_BYTES:
                logger.warning(
                    f"Oversized share control from {user_email} in {room_id}: "
                    f"{len(text)} bytes"
                )
                await websocket.close(code=SHARE_CLOSE_PROTOCOL,
                                      reason="Control message too large")
                break
            try:
                control = json.loads(text)
            except json.JSONDecodeError:
                logger.warning(f"Invalid share control from {user_email} in {room_id}")
                continue
            if control.get("type") == SHARE_CONTROL_FORMAT:
                share_relay.set_format(room_id, str(control.get("mime") or ""))

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.error(f"Share publisher error for {user_email} in {room_id}: {exc}")
    finally:
        share_relay.close_publisher(room_id, connection_id)
        # A media socket that dies without a `share_stop` — a laptop lid, a
        # dropped connection — leaves the room's player waiting for a frame
        # that is never coming. Ending the share is what puts the queue back.
        #
        # On its own task, deliberately: this handler is being torn down, and
        # a server that cancels the disconnected connection's task would
        # otherwise take the room's notification down with it. The task
        # touches only room state, which is this worker's own.
        _run_detached(_end_share_after_media_loss(room_id, connection_id, user_email))


# Tasks that have to outlive the connection that started them. Held onto
# because asyncio keeps only a weak reference to a running task.
_detached_tasks: set = set()


def _run_detached(coroutine) -> None:
    task = asyncio.create_task(coroutine)
    _detached_tasks.add(task)
    task.add_done_callback(_detached_tasks.discard)


async def _end_share_after_media_loss(room_id: str, connection_id: str, email: str):
    """Tell the room a share is over because its media connection went."""
    share = manager.share_of(room_id)
    if not share or share["connection_id"] != connection_id:
        return
    manager.live_shares.pop(room_id, None)
    logger.info(f"The media connection for the share in {room_id} closed; ending it")
    await manager.broadcast({
        "type": "share_ended",
        "payload": {"reason": "disconnected", "email": share["email"]},
    }, room_id)
    await publish_room_activity(room_id, "share_ended", actor=email)


async def _share_viewer_socket(websocket: WebSocket, room_id: str, user_email: str):
    """Send one watching browser the header, then the live edge."""
    if not _is_connected_to_room(room_id, user_email):
        logger.info(f"Refused a share viewer for {room_id}: {user_email} is not in it")
        await websocket.accept()
        await websocket.close(code=SHARE_CLOSE_NOT_AUTHORIZED,
                              reason="You are not in this room")
        return

    await websocket.accept()
    try:
        viewer = share_relay.add_viewer(room_id, websocket, user_email)
    except RelayRefused as refused:
        await websocket.close(code=refused.code, reason=refused.message)
        return

    # Sending runs on its own task so that a congested viewer waits on its
    # own transport and nothing else; this coroutine stays on `receive()`,
    # which is how a disconnect is noticed at all.
    pump = asyncio.create_task(share_relay.pump(viewer))
    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break
            # Viewers have nothing to say on this socket. Anything they send
            # is ignored rather than relayed: this is a one-way pipe, and
            # that is what keeps a viewer from injecting frames.
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.info(f"Share viewer {user_email} in {room_id} ended: {exc}")
    finally:
        share_relay.remove_viewer(room_id, viewer)
        pump.cancel()


# ============================================================================
# Entry Point
# ============================================================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
