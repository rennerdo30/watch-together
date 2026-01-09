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
import http.cookiejar
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
)
from core.security import get_user_cookie_path, get_user_from_request
from services.cache import (
    parse_range_header, get_bucket_for_position, get_bucket_cache_key,
    check_disk_space, get_current_cache_size,
    cache_cleanup_task,
)
from services.database import init_database, cache_format
from services.resolver import refresh_video_url, _extract_stream_url
from api.routes.cookies import router as cookies_router
from api.routes.rooms import router as rooms_router
from connection_manager import manager

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


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
    while True:
        await asyncio.sleep(5)
        try:
            for room_id, state in list(manager.room_states.items()):
                if state.get("is_playing") and manager.active_connections.get(room_id):
                    sync_payload = manager.get_sync_payload(room_id)
                    await manager.broadcast({
                        "type": "heartbeat",
                        "payload": {
                            "timestamp": sync_payload.get("timestamp", 0),
                            "server_time": time.time() * 1000,
                            "is_playing": True
                        }
                    }, room_id)
        except Exception as e:
            logger.warning(f"Heartbeat error: {e}")


# ============================================================================
# Application Lifecycle
# ============================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan - start/stop background tasks."""
    # Initialize database and run migrations
    init_database()
    
    # Load persisted room states
    await manager.initialize()
    logger.info(f"Loaded {len(manager.room_states)} rooms from database")
    
    tasks = [
        asyncio.create_task(cleanup_task()),
        asyncio.create_task(cache_cleanup_task()),
        asyncio.create_task(sync_heartbeat_task()),
    ]
    logger.info("Started background tasks: room cleanup, cache cleanup, sync heartbeat")
    yield
    for task in tasks:
        task.cancel()
    # Clean up HTTP client
    global _proxy_client
    if _proxy_client is not None:
        await _proxy_client.aclose()
        _proxy_client = None
        logger.info("Closed proxy HTTP client")


# ============================================================================
# App Initialization
# ============================================================================

app = FastAPI(title="Watch Together Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include API routers
app.include_router(cookies_router)
app.include_router(rooms_router)


# ============================================================================
# HTTP Client
# ============================================================================

_proxy_client = None

async def get_proxy_client():
    """Get or create the HTTP client for proxying."""
    global _proxy_client
    if _proxy_client is None:
        jar = http.cookiejar.MozillaCookieJar()
        cookie_path = os.path.join("data", "cookies.txt")
        if os.path.exists(cookie_path):
            try:
                jar.load(cookie_path, ignore_discard=True, ignore_expires=True)
                logger.info("Proxy client loaded cookies from data/cookies.txt")
            except Exception as e:
                logger.error(f"Failed to load cookies for proxy: {e}")
        
        _proxy_client = httpx.AsyncClient(
            cookies=jar,
            follow_redirects=True,
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


@app.get("/api/resolve")
def resolve_stream(
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
    }

    # Use mweb client which often bypasses GVS token requirements for HD
    # remote_components enables bgutil to fetch script from GitHub for PO token generation
    ydl_opts = {
        **base_opts,
        'extractor_args': {
            'youtube': {
                'player_client': ['mweb', 'web'],
            }
        },
        'remote_components': {'ejs': 'github'},
        # Configure GetPOT to use the remote bgutil-provider service
        'ytdl_hook': {
            'GetPOT': {
                'provider': 'bgutil',
                'provider_args': {'bgutil': {'url': 'http://bgutil-provider:4416'}}
            }
        },
    }

    if has_cookies:
        logger.info(f"Using cookies for user: {user_email}")
        ydl_opts['cookiefile'] = cookie_path

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False, process=False)
            if info.get('_type') == 'url':
                info = ydl.extract_info(info['url'], download=False, process=False)

            stream_info = _extract_stream_url(info)

            if stream_info and stream_info.get('url'):
                response = {
                    "original_url": url,
                    "stream_url": stream_info['url'],
                    "title": info.get('title', 'Unknown Title'),
                    "is_live": info.get('is_live', False),
                    "thumbnail": info.get('thumbnail'),
                    "backend_engine": "yt-dlp",
                    "quality": f"{stream_info.get('height', '?')}p" if stream_info.get('height') else "auto",
                    "has_audio": stream_info.get('has_audio', True),
                    "stream_type": stream_info.get('type', 'unknown')
                }

                if stream_info.get('type') == 'dash':
                    response["video_url"] = stream_info.get('video_url')
                    response["audio_url"] = stream_info.get('audio_url')
                    response["available_qualities"] = stream_info.get('available_qualities', [])
                    response["audio_options"] = stream_info.get('audio_options', [])

                return response

    except Exception as e:
        error_msg = str(e)
        logger.info(f"Primary method error: {error_msg[:100]}")

    # Fallback: Try with web client and remote components for PO token
    logger.info("Fallback: Trying web client with remote components")
    ydl_opts_fallback = {
        **base_opts,
        'extractor_args': {'youtube': {'player_client': ['web']}},
        'remote_components': 'ejs:github',
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts_fallback) as ydl:
            info = ydl.extract_info(url, download=False, process=False)
            if info.get('_type') == 'url':
                info = ydl.extract_info(info['url'], download=False, process=False)

            stream_info = _extract_stream_url(info)

            if stream_info and stream_info.get('url'):
                response = {
                    "original_url": url,
                    "stream_url": stream_info['url'],
                    "title": info.get('title', 'Unknown Title'),
                    "is_live": info.get('is_live', False),
                    "thumbnail": info.get('thumbnail'),
                    "backend_engine": "yt-dlp",
                    "quality": f"{stream_info.get('height', '?')}p" if stream_info.get('height') else "auto",
                    "has_audio": stream_info.get('has_audio', True),
                    "stream_type": stream_info.get('type', 'unknown')
                }

                if stream_info.get('type') == 'dash':
                    response["video_url"] = stream_info.get('video_url')
                    response["audio_url"] = stream_info.get('audio_url')
                    response["available_qualities"] = stream_info.get('available_qualities', [])
                    response["audio_options"] = stream_info.get('audio_options', [])

                return response

    except Exception as e:
        error_msg = str(e)
        logger.error(f"Fallback error: {error_msg}")
        if "Sign in to confirm your age" in error_msg:
            raise HTTPException(status_code=403, detail="Age-restricted video. Please upload valid YouTube cookies.")

    raise HTTPException(status_code=400, detail="Could not resolve a playable stream URL.")


# ============================================================================
# HLS Proxy
# ============================================================================

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

    referer = "https://www.youtube.com/"
    if "twitch.tv" in url or "ttvnw.net" in url:
        referer = "https://www.twitch.tv/"

    host = request.headers.get("host")
    proto = "https" if request.headers.get("x-forwarded-proto") == "https" else "http"
    proxy_base = f"{proto}://{host}/api/proxy?url="

    url_path = url.split('?')[0]
    is_manifest = url_path.endswith('.m3u8') or url_path.endswith('.m3u')

    outgoing_headers = {
        "User-Agent": request.headers.get("user-agent", "Mozilla/5.0"),
        "Referer": referer,
        "Accept-Language": "en-US,en;q=0.9",
        "Range": request.headers.get("range", ""),
    }
    if not outgoing_headers["Range"]:
        del outgoing_headers["Range"]

    segment_client = await get_proxy_client()

    try:
        if is_manifest:
            logger.info(f"Proxying manifest for {url[:100]}...")
            response = await segment_client.get(url, headers=outgoing_headers)
            if response.status_code >= 400:
                return Response(content=response.text, status_code=response.status_code)

            rewritten = rewrite_hls_manifest(response.text, url, proxy_base)
            return Response(
                content=rewritten,
                media_type="application/vnd.apple.mpegurl",
                headers={
                    "Access-Control-Allow-Origin": "*",
                    "Cache-Control": "no-cache",
                }
            )
        else:
            # Segment proxying with bucket caching
            range_header = outgoing_headers.get("Range", "")
            range_start, range_end = parse_range_header(range_header)
            start_bucket = get_bucket_for_position(range_start)
            _, bucket_cache_path = get_bucket_cache_key(url, start_bucket)
            bucket_meta_path = bucket_cache_path + ".meta"

            # Check bucket cache
            if os.path.exists(bucket_cache_path) and os.path.exists(bucket_meta_path):
                try:
                    async with aiofiles.open(bucket_meta_path, 'r') as f:
                        bucket_meta = json.loads(await f.read())
                    
                    bucket_start = bucket_meta.get("bucket_start", 0)
                    bucket_end = bucket_meta.get("bucket_end", 0)
                    
                    if bucket_start <= range_start < bucket_end:
                        offset = range_start - bucket_start
                        os.utime(bucket_cache_path, None)
                        
                        async def iter_bucket():
                            async with aiofiles.open(bucket_cache_path, 'rb') as f:
                                await f.seek(offset)
                                while True:
                                    chunk = await f.read(64 * 1024)
                                    if not chunk:
                                        break
                                    yield chunk
                        
                        logger.info(f"BUCKET HIT: {start_bucket} for {url[:60]}...")
                        return StreamingResponse(
                            iter_bucket(),
                            status_code=206,
                            headers={
                                "Access-Control-Allow-Origin": "*",
                                "Accept-Ranges": "bytes",
                                "Content-Type": bucket_meta.get("content_type", "application/octet-stream"),
                            }
                        )
                except Exception as e:
                    logger.warning(f"Bucket cache read error: {e}")

            # Fetch from upstream
            req = segment_client.build_request("GET", url, headers=outgoing_headers)
            r = await segment_client.send(req, stream=True)

            response_headers = {
                "Access-Control-Allow-Origin": "*",
                "Accept-Ranges": "bytes",
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

            # Check for late-detected manifest
            ctype = r.headers.get("content-type", "").lower()
            if "mpegurl" in ctype:
                content = await r.read()
                text = content.decode('utf-8', errors='replace')
                rewritten = rewrite_hls_manifest(text, url, proxy_base)
                return Response(content=rewritten, media_type="application/vnd.apple.mpegurl")

            if should_cache:
                _, cache_path = get_bucket_cache_key(url, start_bucket)
                cache_meta_path = cache_path + ".meta"

                async def stream_and_cache():
                    temp_path = cache_path + f".{time.time()}.tmp"
                    total = 0
                    try:
                        async with aiofiles.open(temp_path, 'wb') as f:
                            async for chunk in r.aiter_bytes():
                                await f.write(chunk)
                                total += len(chunk)
                                yield chunk
                        
                        if r.status_code in (200, 206):
                            os.rename(temp_path, cache_path)
                            meta = {
                                "bucket_num": start_bucket,
                                "bucket_start": range_start,
                                "bucket_end": range_start + total,
                                "content_type": r.headers.get("content-type"),
                                "cached_at": time.time(),
                            }
                            async with aiofiles.open(cache_meta_path, 'w') as f:
                                await f.write(json.dumps(meta))
                    except Exception as e:
                        logger.warning(f"Cache error: {e}")
                        if os.path.exists(temp_path):
                            os.remove(temp_path)
                    finally:
                        await r.aclose()

                return StreamingResponse(stream_and_cache(), status_code=r.status_code, headers=response_headers)
            else:
                async def stream_only():
                    try:
                        async for chunk in r.aiter_bytes():
                            yield chunk
                    finally:
                        await r.aclose()

                return StreamingResponse(stream_only(), status_code=r.status_code, headers=response_headers)

    except Exception as e:
        logger.error(f"Proxy error for {url}: {e}")
        raise HTTPException(status_code=500, detail=f"Proxy error: {e}")


# ============================================================================
# WebSocket Handler
# ============================================================================

@app.websocket("/ws/{room_id}")
async def websocket_endpoint(websocket: WebSocket, room_id: str):
    """WebSocket handler for room synchronization."""
    user_email = websocket.headers.get("cf-access-authenticated-user-email")
    if not user_email:
        user_email = websocket.query_params.get("user")
    if not user_email:
        user_email = "Guest"
    
    await manager.connect(websocket, room_id, user_email)
    try:
        while True:
            data = await websocket.receive_text()
            try:
                message = json.loads(data)
            except json.JSONDecodeError:
                logger.warning(f"Invalid JSON received from {user_email} in room {room_id}")
                continue

            msg_type = message.get("type")
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
            
            elif msg_type == "ping":
                await websocket.send_json({
                    "type": "pong",
                    "payload": {"client_time": payload.get("client_time"), "server_time": time.time() * 1000}
                })
                
    except WebSocketDisconnect:
        await manager.disconnect_and_notify(websocket, room_id)


# ============================================================================
# Entry Point
# ============================================================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
