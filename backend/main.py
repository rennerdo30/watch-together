import os
import asyncio
from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect, Request
from fastapi.middleware.cors import CORSMiddleware
import yt_dlp
import logging
import json
import http.cookiejar
import pydantic
from connection_manager import manager
import httpx
from starlette.responses import StreamingResponse, Response
from starlette.background import BackgroundTask
from contextlib import asynccontextmanager
import hashlib
import aiofiles
import shutil
import time

# Cache configuration
CACHE_DIR = "data/cache"
COOKIES_DIR = "data/cookies"
MAX_CACHE_SIZE_BYTES = 500 * 1024 * 1024  # 500 MB
CACHE_TTL_SECONDS = 3600  # 1 hour

if not os.path.exists(CACHE_DIR):
    os.makedirs(CACHE_DIR)

if not os.path.exists(COOKIES_DIR):
    os.makedirs(COOKIES_DIR)

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Ensure data directory exists for persistence
if not os.path.exists("data"):
    os.makedirs("data")

# Background task for cleaning up stale rooms
async def cleanup_task():
    while True:
        await asyncio.sleep(60)  # Check every minute
        manager.cleanup_stale_rooms(ttl_seconds=300)  # 5 minute TTL

async def cache_cleanup_task():
    """
    Background task to enforce cache limits (size and TTL).
    """
    while True:
        await asyncio.sleep(300)  # Run every 5 minutes
        try:
            current_time = time.time()
            total_size = 0
            files = []

            # 1. Scan files and remove expired
            if os.path.exists(CACHE_DIR):
                for f in os.listdir(CACHE_DIR):
                    if f.endswith(".tmp"): # Clean up stale temp files
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
                # Sort by mtime (oldest first)
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
                
        except Exception as e:
            logger.error(f"Error in cache cleanup task: {e}")

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: start background cleanup task
    task = asyncio.create_task(cleanup_task())
    cache_task = asyncio.create_task(cache_cleanup_task())
    logger.info("Started room cleanup background task")
    yield
    # Shutdown: cancel cleanup task
    task.cancel()
    cache_task.cancel()

app = FastAPI(title="Watch Together Backend", lifespan=lifespan)

# CORS setup
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global HTTP client for proxying
# We'll initialize it lazily to ensure cookie loading
_proxy_client = None

async def get_proxy_client():
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

@app.websocket("/ws/{room_id}")
async def websocket_endpoint(websocket: WebSocket, room_id: str):
    # Try to get identity from Cloudflare header
    user_email = websocket.headers.get("cf-access-authenticated-user-email")
    
    # Fallback to query param for dev/mocking
    if not user_email:
        user_email = websocket.query_params.get("user")
        
    if not user_email:
        user_email = "Guest"
    
    await manager.connect(websocket, room_id, user_email)
    try:
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)
            
            # Handle different message types
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
                next_v, queue, playing_index = await manager.prepend_to_queue(room_id, video_data)
                if next_v:
                    await manager.broadcast({"type": "set_video", "payload": {"video_data": next_v}}, room_id)
                    await manager.broadcast({"type": "queue_update", "payload": {"queue": queue, "playing_index": playing_index}}, room_id)

            elif msg_type == "queue_add":
                video_data = payload.get("video_data")
                queue = await manager.add_to_queue(room_id, video_data)
                state = manager.room_states.get(room_id, {})
                await manager.broadcast({"type": "queue_update", "payload": {"queue": queue, "playing_index": state.get("playing_index", -1)}}, room_id)

            elif msg_type == "queue_remove":
                index = payload.get("index")
                queue = await manager.remove_from_queue(room_id, index)
                state = manager.room_states.get(room_id, {})
                await manager.broadcast({"type": "queue_update", "payload": {"queue": queue, "playing_index": state.get("playing_index", -1)}}, room_id)

            elif msg_type == "queue_reorder":
                old_i = payload.get("old_index")
                new_i = payload.get("new_index")
                queue = await manager.reorder_queue(room_id, old_i, new_i)
                state = manager.room_states.get(room_id, {})
                await manager.broadcast({"type": "queue_update", "payload": {"queue": queue, "playing_index": state.get("playing_index", -1)}}, room_id)

            elif msg_type == "queue_pin":
                index = payload.get("index")
                queue = await manager.toggle_pin(room_id, index)
                state = manager.room_states.get(room_id, {})
                await manager.broadcast({"type": "queue_update", "payload": {"queue": queue, "playing_index": state.get("playing_index", -1)}}, room_id)

            elif msg_type == "queue_play":
                index = payload.get("index")
                next_v, queue, playing_index = await manager.play_from_queue(room_id, index)
                if next_v:
                    # Refresh the stream URL to prevent expired manifests (use requesting user's cookies)
                    next_v = await refresh_video_url(next_v, user_email=user_email)
                    await manager.broadcast({"type": "set_video", "payload": {"video_data": next_v}}, room_id)
                await manager.broadcast({"type": "queue_update", "payload": {"queue": queue, "playing_index": playing_index}}, room_id)

            elif msg_type == "video_ended":
                # Play next video in queue if exists
                next_v, queue, playing_index = await manager.next_video(room_id)
                if next_v:
                    # Refresh the stream URL to prevent expired manifests (use requesting user's cookies)
                    next_v = await refresh_video_url(next_v, user_email=user_email)
                    await manager.broadcast({"type": "set_video", "payload": {"video_data": next_v}}, room_id)
                await manager.broadcast({"type": "queue_update", "payload": {"queue": queue, "playing_index": playing_index}}, room_id)
                
            elif msg_type == "promote":
                target_email = payload.get("target_email")
                new_role = payload.get("role")
                if target_email and new_role:
                    if await manager.promote_user(room_id, user_email, target_email, new_role):
                        # Broadcast roles update
                        state = manager.room_states.get(room_id, {})
                        await manager.broadcast({
                            "type": "roles_update",
                            "payload": {"roles": state.get("roles", {})}
                        }, room_id)
                
    except WebSocketDisconnect:
        await manager.disconnect_and_notify(websocket, room_id)

@app.get("/")
def read_root():
    return {"status": "ok", "service": "Watch Together Backend"}

class CookieContent(pydantic.BaseModel):
    content: str

def get_user_from_request(request: Request) -> str:
    """Extract user identity from Cloudflare header or query param."""
    # Try Cloudflare Access header first
    user_email = request.headers.get("cf-access-authenticated-user-email")
    # Fallback to query param for dev/testing
    if not user_email:
        user_email = request.query_params.get("user")
    return user_email

def get_user_cookie_path(user_email: str) -> str:
    """Get the cookie file path for a specific user."""
    if not user_email:
        return None
    # Sanitize email to be filesystem-safe
    safe_name = "".join(c if c.isalnum() or c in "._-@" else "_" for c in user_email)
    return os.path.join(COOKIES_DIR, f"{safe_name}.txt")

@app.get("/api/cookies")
async def get_cookies(request: Request):
    """
    Returns the current user's cookies (masked for security).
    """
    user_email = get_user_from_request(request)
    if not user_email:
        raise HTTPException(status_code=401, detail="User identity required")

    cookie_path = get_user_cookie_path(user_email)
    if not cookie_path or not os.path.exists(cookie_path):
        return {"status": "ok", "has_cookies": False, "content": ""}

    try:
        async with aiofiles.open(cookie_path, 'r') as f:
            content = await f.read()
        return {"status": "ok", "has_cookies": True, "content": content}
    except Exception as e:
        logger.error(f"Failed to read cookies for {user_email}: {e}")
        return {"status": "ok", "has_cookies": False, "content": ""}

@app.post("/api/cookies")
async def update_cookies(request: Request, cookie_data: CookieContent):
    """
    Updates the user's cookies.txt with provided Netscape-formatted content.
    Each user has their own isolated cookie file.
    """
    user_email = get_user_from_request(request)
    if not user_email:
        raise HTTPException(status_code=401, detail="User identity required. Please log in.")

    try:
        content = cookie_data.content
        # Basic validation: check for Netscape header or common fields
        if not content.strip():
            raise HTTPException(status_code=400, detail="Empty content")

        cookie_path = get_user_cookie_path(user_email)
        if not cookie_path:
            raise HTTPException(status_code=400, detail="Invalid user identity")

        async with aiofiles.open(cookie_path, 'w') as f:
            await f.write(content)

        logger.info(f"Updated cookies for user: {user_email}")

        return {"status": "ok", "message": "Cookies updated successfully"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to update cookies for {user_email}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/api/cookies")
async def delete_cookies(request: Request):
    """
    Deletes the current user's cookies.
    """
    user_email = get_user_from_request(request)
    if not user_email:
        raise HTTPException(status_code=401, detail="User identity required")

    cookie_path = get_user_cookie_path(user_email)
    if cookie_path and os.path.exists(cookie_path):
        os.remove(cookie_path)
        logger.info(f"Deleted cookies for user: {user_email}")

    return {"status": "ok", "message": "Cookies deleted"}

@app.get("/api/rooms")
def list_rooms():
    return manager.get_active_rooms()

async def refresh_video_url(video_data: dict, user_agent: str = None, user_email: str = None) -> dict:
    """
    Re-resolves the stream URL for a video using its original URL.
    This prevents playback failures from expired YouTube manifest URLs.
    Uses the specified user's cookies if available.
    """
    if not video_data or not video_data.get("original_url"):
        return video_data

    original_url = video_data["original_url"]
    logger.info(f"Refreshing stream URL for: {original_url} (User: {user_email or 'anonymous'})")

    # Use user-specific cookies if available
    cookie_path = get_user_cookie_path(user_email) if user_email else None
    has_cookies = cookie_path and os.path.exists(cookie_path)

    # Ensure cache directory exists
    cache_dir = os.path.join("data", "yt_dlp_cache")

    ydl_opts = {
        'quiet': True,
        'no_warnings': True,
        'nocheckcertificate': True,
        'socket_timeout': 30,
        'extractor_args': {'youtube': {'player_client': ['tv_downgraded', 'web_creator']}},
        'http_headers': {
            'User-Agent': user_agent or 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://www.youtube.com/',
        },
        'skip_download': True,
        'ignore_no_formats_error': True,
        'cache_dir': cache_dir,
    }

    if has_cookies:
        ydl_opts['cookiefile'] = cookie_path

    try:
        import asyncio
        loop = asyncio.get_event_loop()

        def do_resolve():
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(original_url, download=False, process=False)

                if info.get('_type') == 'url':
                    info = ydl.extract_info(info['url'], download=False, process=False)

                # Use shared extraction logic
                stream_info = _extract_stream_url(info, logger)
                return stream_info.get('url') if stream_info else None

        new_stream_url = await loop.run_in_executor(None, do_resolve)

        if new_stream_url:
            video_data["stream_url"] = new_stream_url
            logger.info(f"Refreshed stream URL successfully")
        else:
            logger.warning(f"Could not refresh stream URL for {original_url}")

        return video_data
    except Exception as e:
        logger.error(f"Failed to refresh stream URL: {e}")
        return video_data


def _extract_stream_url(info: dict, logger, prefer_dash: bool = True) -> dict:
    """Extract the best stream URL from yt-dlp info dict. Returns dict with stream info.

    If prefer_dash=True and HD video-only formats exist, returns separate video+audio URLs
    for DASH playback. Otherwise returns combined format.
    """
    formats = info.get('formats', [])

    # Debug: Log available formats
    logger.info(f"Video: {info.get('title', 'Unknown')} - Found {len(formats)} formats")

    # Categorize formats
    hls_formats = []
    combined_formats = []  # Has both video and audio
    video_only_formats = []
    audio_only_formats = []

    for f in formats:
        url = f.get('url') or ''
        manifest_url = f.get('manifest_url') or ''
        has_video = f.get('vcodec') not in (None, 'none')
        has_audio = f.get('acodec') not in (None, 'none')
        height = f.get('height') or 0
        abr = f.get('abr') or 0  # Audio bitrate

        if '.m3u8' in manifest_url or '.m3u8' in url:
            if has_video:
                hls_formats.append((height, f))
        elif has_video and has_audio and url:
            combined_formats.append((height, f))
        elif has_video and url:
            video_only_formats.append((height, f))
        elif has_audio and url and not has_video:
            audio_only_formats.append((abr, f))

    # Sort by quality descending
    hls_formats.sort(key=lambda x: x[0], reverse=True)
    combined_formats.sort(key=lambda x: x[0], reverse=True)
    video_only_formats.sort(key=lambda x: x[0], reverse=True)
    audio_only_formats.sort(key=lambda x: x[0], reverse=True)

    logger.info(f"  HLS: {len(hls_formats)}, Combined: {len(combined_formats)}, Video-only: {len(video_only_formats)}, Audio-only: {len(audio_only_formats)}")

    # Log best options
    if combined_formats:
        best = combined_formats[0][1]
        logger.info(f"  Best combined: {best.get('format_id')} @ {best.get('height')}p")
    if video_only_formats:
        best = video_only_formats[0][1]
        logger.info(f"  Best video-only: {best.get('format_id')} @ {best.get('height')}p")
    if audio_only_formats:
        best = audio_only_formats[0][1]
        logger.info(f"  Best audio: {best.get('format_id')} @ {best.get('abr')}kbps")
    if hls_formats:
        best = hls_formats[0][1]
        logger.info(f"  Best HLS: {best.get('format_id')} @ {best.get('height')}p")

    # 1. PREFER DASH for HD quality with manual quality selection
    # DASH gives us explicit control over quality switching
    if prefer_dash and video_only_formats and audio_only_formats:
        best_video = video_only_formats[0][1]
        best_audio = audio_only_formats[0][1]

        # Use DASH whenever we have separate video+audio streams available
        # This gives users explicit quality control
        if best_video.get('height', 0) > 0:
            logger.info(f"Selected DASH: video={best_video.get('format_id')} @ {best_video.get('height')}p + audio={best_audio.get('format_id')} @ {best_audio.get('abr')}kbps")
            return {
                'url': best_video.get('url'),
                'video_url': best_video.get('url'),
                'audio_url': best_audio.get('url'),
                'format_id': f"{best_video.get('format_id')}+{best_audio.get('format_id')}",
                'height': best_video.get('height'),
                'width': best_video.get('width'),
                'vcodec': best_video.get('vcodec'),
                'acodec': best_audio.get('acodec'),
                'has_audio': True,
                'type': 'dash',
                # Include all available qualities for quality switching
                'available_qualities': [
                    {
                        'height': v[1].get('height'),
                        'width': v[1].get('width'),
                        'video_url': v[1].get('url'),
                        'format_id': v[1].get('format_id'),
                        'vcodec': v[1].get('vcodec'),
                        'tbr': v[1].get('tbr'),
                    }
                    for v in video_only_formats[:6]  # Top 6 qualities
                ],
                'audio_options': [
                    {
                        'abr': a[1].get('abr'),
                        'audio_url': a[1].get('url'),
                        'format_id': a[1].get('format_id'),
                        'acodec': a[1].get('acodec'),
                    }
                    for a in audio_only_formats[:3]  # Top 3 audio qualities
                ]
            }

    # 2. HLS manifest (supports adaptive bitrate switching)
    if hls_formats:
        f = hls_formats[0][1]
        stream_url = f.get('manifest_url') or f.get('url')
        logger.info(f"Selected HLS manifest: {f.get('format_id')} @ {f.get('height')}p")
        return {
            'url': stream_url,
            'format_id': f.get('format_id'),
            'height': f.get('height'),
            'has_audio': True,
            'type': 'hls'
        }

    # 3. Fallback: Best combined format (has both video + audio)
    if combined_formats:
        f = combined_formats[0][1]
        stream_url = f.get('url')
        logger.info(f"Selected combined format: {f.get('format_id')} @ {f.get('height')}p")
        return {
            'url': stream_url,
            'format_id': f.get('format_id'),
            'height': f.get('height'),
            'has_audio': True,
            'type': 'combined'
        }

    # 4. Video-only as last resort (won't have audio!)
    if video_only_formats:
        f = video_only_formats[0][1]
        stream_url = f.get('url')
        logger.info(f"WARNING: Selected video-only format (no audio): {f.get('format_id')} @ {f.get('height')}p")
        return {
            'url': stream_url,
            'format_id': f.get('format_id'),
            'height': f.get('height'),
            'has_audio': False,
            'type': 'video_only'
        }

    # 5. Default url
    stream_url = info.get('url')
    if stream_url:
        logger.info("Using default URL from info")
        return {'url': stream_url, 'format_id': 'default', 'height': None, 'has_audio': True, 'type': 'default'}

    return None


@app.get("/api/resolve")
def resolve_stream(
    request: Request,
    url: str = Query(..., description="The URL of the video/stream to resolve"),
    user_agent: str = Query(None, description="User agent from the client browser")
):
    """
    Uses yt-dlp to resolve the input URL to a playable stream URL.
    Two-pass approach: First try without cookies (ios/android work),
    then retry with cookies if age-restricted.
    """
    user_email = get_user_from_request(request)
    logger.info(f"Resolving URL: {url} (UA: {user_agent[:50] if user_agent else 'None'}..., User: {user_email or 'anonymous'})")

    # Use user-specific cookies if available
    cookie_path = get_user_cookie_path(user_email) if user_email else None
    has_cookies = cookie_path and os.path.exists(cookie_path)

    # Ensure cache directory exists
    cache_dir = os.path.join("data", "yt_dlp_cache")
    if not os.path.exists(cache_dir):
        os.makedirs(cache_dir)

    base_opts = {
        'quiet': False,
        'no_warnings': False,
        'nocheckcertificate': True,
        'socket_timeout': 30,
        'http_headers': {
            'User-Agent': user_agent or 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
        },
        'skip_download': True,
        'ignore_no_formats_error': True,
        'cache_dir': cache_dir,
    }

    # Use tv_downgraded and web_creator clients with deno for BotGuard solving
    # These work with cookies and can solve YouTube's challenges
    # getpot_bgutil_script_origin=github tells the provider to fetch BotGuard scripts from GitHub
    # See: https://github.com/yt-dlp/yt-dlp/wiki/EJS
    logger.info("Trying tv_downgraded/web_creator clients with cookies and deno solver")

    ydl_opts = {
        **base_opts,
        'extractor_args': {
            'youtube': {
                'player_client': ['tv_downgraded', 'web_creator'],
                'getpot_bgutil_script_origin': ['github'],
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

            stream_info = _extract_stream_url(info, logger)

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

                # Include DASH-specific fields if available
                if stream_info.get('type') == 'dash':
                    response["video_url"] = stream_info.get('video_url')
                    response["audio_url"] = stream_info.get('audio_url')
                    response["available_qualities"] = stream_info.get('available_qualities', [])
                    response["audio_options"] = stream_info.get('audio_options', [])

                return response

            logger.info("Primary method failed, trying ios/android fallback...")

    except Exception as e:
        error_msg = str(e)
        logger.info(f"Primary method error: {error_msg[:100]}...")

    # FALLBACK: Try ios/android clients (no cookies - they don't support them)
    # These avoid SABR but can't access age-restricted content
    logger.info("Fallback: Trying ios/android clients (no cookies)")
    ydl_opts_fallback = {
        **base_opts,
        'extractor_args': {'youtube': {'player_client': ['ios', 'android']}},
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts_fallback) as ydl:
            info = ydl.extract_info(url, download=False, process=False)
            if info.get('_type') == 'url':
                info = ydl.extract_info(info['url'], download=False, process=False)

            stream_info = _extract_stream_url(info, logger)

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

                # Include DASH-specific fields if available
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
            raise HTTPException(
                status_code=403,
                detail="Age-restricted video. Please upload valid YouTube cookies."
            )

    # If we get here, both passes failed
    raise HTTPException(
        status_code=400,
        detail="Could not resolve a playable stream URL. YouTube may be blocking this request."
    )

def rewrite_hls_manifest(content: str, base_url: str, proxy_base: str) -> str:
    """Rewrite URLs in HLS manifest to go through our proxy."""
    import re
    from urllib.parse import urljoin, quote

    lines = content.split('\n')
    result = []

    for line in lines:
        line = line.strip()
        if not line:
            result.append(line)
            continue

        # Skip comments/tags but check for URI= attributes
        if line.startswith('#'):
            # Handle URI="..." in tags like #EXT-X-MEDIA
            if 'URI="' in line:
                def replace_uri(match):
                    uri = match.group(1)
                    if uri.startswith('http'):
                        full_url = uri
                    else:
                        full_url = urljoin(base_url, uri)
                    return f'URI="{proxy_base}{quote(full_url, safe="")}"'
                line = re.sub(r'URI="([^"]+)"', replace_uri, line)
            result.append(line)
            continue

        # This is a URL line - rewrite it
        if line.startswith('http'):
            full_url = line
        else:
            full_url = urljoin(base_url, line)

        result.append(f"{proxy_base}{quote(full_url, safe='')}")

    return '\n'.join(result)

@app.options("/api/proxy")
async def proxy_options():
    """Handle CORS preflight requests"""
    from starlette.responses import Response
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
    """
    Proxy HLS manifests and segments to bypass CORS/restrictions.
    Manifests are rewritten to point back to this proxy.
    """
    if not url:
        raise HTTPException(status_code=400, detail="Missing URL")

    # Determine referring site for headers
    referer = "https://www.youtube.com/"
    if "twitch.tv" in url or "ttvnw.net" in url:
        referer = "https://www.twitch.tv/"
    elif "googlevideo.com" in url:
        referer = "https://www.youtube.com/"

    host = request.headers.get("host")
    proto = "https" if request.headers.get("x-forwarded-proto") == "https" else "http"
    proxy_base = f"{proto}://{host}/api/proxy?url="

    # Check if this is an HLS manifest vs a segment
    # YouTube URLs can be tricky: segments contain ".m3u8/..." in the path but end with ".ts"
    # So we check if URL ends with manifest extensions, NOT just contains them
    url_path = url.split('?')[0]  # Remove query params for extension check
    is_manifest = url_path.endswith('.m3u8') or url_path.endswith('.m3u')

    outgoing_headers = {
        "User-Agent": request.headers.get("user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36"),
        "Referer": referer,
        "Accept-Language": "en-US,en;q=0.9",
        "Range": request.headers.get("range", ""),
    }
    # Remove empty Range
    if "Range" in outgoing_headers and not outgoing_headers["Range"]: del outgoing_headers["Range"]

# Global client for segments to avoid connection exhaustion
    # Initialize it lazily
    segment_client = await get_proxy_client()

    try:
        if is_manifest:
            response = await segment_client.get(url, headers=outgoing_headers)
            if response.status_code >= 400:
                logger.warning(f"Upstream manifest error {response.status_code} for {url}")
                return Response(content=response.text, status_code=response.status_code, media_type="text/plain")

            content = response.text
            rewritten = rewrite_hls_manifest(content, url, proxy_base)

            return Response(
                content=rewritten,
                media_type="application/vnd.apple.mpegurl",
                headers={
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, OPTIONS",
                    "Access-Control-Allow-Headers": "*",
                    "Cache-Control": "no-cache",
                }
            )
        else:

            # Handle Segment Caching
            cache_key = hashlib.md5(url.encode()).hexdigest()
            cache_path = os.path.join(CACHE_DIR, cache_key)
            meta_path = cache_path + ".meta"
            
            # Check cache hit
            if os.path.exists(cache_path) and os.path.exists(meta_path):
                try:
                    # Serve from cache
                    async with aiofiles.open(meta_path, 'r') as f:
                        meta_json = await f.read()
                        headers = json.loads(meta_json)
                    
                    # Update mtime for LRU
                    os.utime(cache_path, None)
                    
                    async def iter_file():
                        async with aiofiles.open(cache_path, 'rb') as f:
                            while True:
                                chunk = await f.read(64 * 1024)
                                if not chunk:
                                    break
                                yield chunk
                                
                    logger.info(f"Cache HIT for {url}")
                    return StreamingResponse(
                        iter_file(),
                        headers=headers,
                        media_type=headers.get("content-type", "application/octet-stream")
                    )
                except Exception as e:
                    logger.error(f"Cache read error for {url}: {e}")
                    # Fallback to fetch if cache read fails
                    pass

            logger.info(f"Cache MISS for {url}")
            
            # Fetch and Cache
            req = segment_client.build_request("GET", url, headers=outgoing_headers)
            r = await segment_client.send(req, stream=True)
            
            # Late-detection of Manifest via Content-Type
            # This handles cases where URL doesn't end in .m3u8 but returns a playlist
            ctype = r.headers.get("content-type", "").lower()
            if "mpegurl" in ctype or "application/x-mpegurl" in ctype:
                logger.info(f"Late-detected HLS manifest via Content-Type: {ctype} for {url}")
                content = await r.read()
                try:
                    text_content = content.decode('utf-8')
                except UnicodeDecodeError:
                    text_content = content.decode('latin-1')
                
                rewritten = rewrite_hls_manifest(text_content, url, proxy_base)
                return Response(
                    content=rewritten,
                    media_type="application/vnd.apple.mpegurl",
                    headers={
                        "Access-Control-Allow-Origin": "*",
                        "Access-Control-Allow-Methods": "GET, OPTIONS",
                        "Access-Control-Allow-Headers": "*",
                        "Cache-Control": "no-cache",
                    }
                )
            
            # Prepare headers
            response_headers = {}
            for key in ["content-type", "content-length", "content-range", "accept-ranges", "cache-control", "date", "last-modified"]:
                if key in r.headers:
                    response_headers[key] = r.headers[key]
            
            response_headers["Access-Control-Allow-Origin"] = "*"
            response_headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"
            response_headers["Access-Control-Allow-Headers"] = "*"
            
            # Save metadata
            try:
                async with aiofiles.open(meta_path, 'w') as f:
                    await f.write(json.dumps(dict(response_headers)))
            except Exception as e:
                logger.error(f"Failed to write cache meta: {e}")

            # Stream and write to file
            async def stream_and_cache():
                temp_path = cache_path + f".{time.time()}.tmp"
                try:
                    async with aiofiles.open(temp_path, 'wb') as f:
                        async for chunk in r.aiter_bytes():
                            await f.write(chunk)
                            yield chunk
                    
                    # Rename temp to final only if fully downloaded
                    if r.status_code == 200:
                        os.rename(temp_path, cache_path)
                    else:
                        os.remove(temp_path)
                except Exception as e:
                    logger.error(f"Streaming error/interruption: {e}")
                    if os.path.exists(temp_path):
                        os.remove(temp_path)
                    raise e
                finally:
                    await r.aclose()

            return StreamingResponse(
                stream_and_cache(),
                status_code=r.status_code,
                headers=response_headers,
                media_type=r.headers.get("content-type", "application/octet-stream")
            )
    except Exception as e:
        logger.error(f"Proxy error for {url}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Proxy error: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
