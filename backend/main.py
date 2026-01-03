import os
import asyncio
from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect, Request
from fastapi.middleware.cors import CORSMiddleware
import yt_dlp
import logging
import json
import http.cookiejar
from connection_manager import manager
import httpx
from starlette.responses import StreamingResponse, Response
from starlette.background import BackgroundTask
from contextlib import asynccontextmanager

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

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: start background cleanup task
    task = asyncio.create_task(cleanup_task())
    logger.info("Started room cleanup background task")
    yield
    # Shutdown: cancel cleanup task
    task.cancel()

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
                manager.update_state(room_id, {"is_playing": True, "timestamp": payload.get("timestamp", 0)})
                await manager.broadcast({"type": "play", "payload": payload}, room_id, exclude=websocket)
                
            elif msg_type == "pause":
                manager.update_state(room_id, {"is_playing": False, "timestamp": payload.get("timestamp", 0)})
                await manager.broadcast({"type": "pause", "payload": payload}, room_id, exclude=websocket)
                
            elif msg_type == "seek":
                manager.update_state(room_id, {"timestamp": payload.get("timestamp", 0)})
                await manager.broadcast({"type": "seek", "payload": payload}, room_id, exclude=websocket)
                
            elif msg_type == "set_video":
                video_data = payload.get("video_data")
                next_v, queue, playing_index = manager.prepend_to_queue(room_id, video_data)
                if next_v:
                    await manager.broadcast({"type": "set_video", "payload": {"video_data": next_v}}, room_id)
                    await manager.broadcast({"type": "queue_update", "payload": {"queue": queue, "playing_index": playing_index}}, room_id)

            elif msg_type == "queue_add":
                video_data = payload.get("video_data")
                queue = manager.add_to_queue(room_id, video_data)
                state = manager.room_states.get(room_id, {})
                await manager.broadcast({"type": "queue_update", "payload": {"queue": queue, "playing_index": state.get("playing_index", -1)}}, room_id)

            elif msg_type == "queue_remove":
                index = payload.get("index")
                queue = manager.remove_from_queue(room_id, index)
                state = manager.room_states.get(room_id, {})
                await manager.broadcast({"type": "queue_update", "payload": {"queue": queue, "playing_index": state.get("playing_index", -1)}}, room_id)

            elif msg_type == "queue_reorder":
                old_i = payload.get("old_index")
                new_i = payload.get("new_index")
                queue = manager.reorder_queue(room_id, old_i, new_i)
                state = manager.room_states.get(room_id, {})
                await manager.broadcast({"type": "queue_update", "payload": {"queue": queue, "playing_index": state.get("playing_index", -1)}}, room_id)

            elif msg_type == "queue_pin":
                index = payload.get("index")
                queue = manager.toggle_pin(room_id, index)
                state = manager.room_states.get(room_id, {})
                await manager.broadcast({"type": "queue_update", "payload": {"queue": queue, "playing_index": state.get("playing_index", -1)}}, room_id)

            elif msg_type == "queue_play":
                index = payload.get("index")
                next_v, queue, playing_index = manager.play_from_queue(room_id, index)
                if next_v:
                    # Refresh the stream URL to prevent expired manifests
                    next_v = await refresh_video_url(next_v)
                    await manager.broadcast({"type": "set_video", "payload": {"video_data": next_v}}, room_id)
                await manager.broadcast({"type": "queue_update", "payload": {"queue": queue, "playing_index": playing_index}}, room_id)

            elif msg_type == "video_ended":
                # Play next video in queue if exists
                next_v, queue, playing_index = manager.next_video(room_id)
                if next_v:
                    # Refresh the stream URL to prevent expired manifests
                    next_v = await refresh_video_url(next_v)
                    await manager.broadcast({"type": "set_video", "payload": {"video_data": next_v}}, room_id)
                await manager.broadcast({"type": "queue_update", "payload": {"queue": queue, "playing_index": playing_index}}, room_id)
                
            elif msg_type == "promote":
                target_email = payload.get("target_email")
                new_role = payload.get("role")
                if target_email and new_role:
                    if manager.promote_user(room_id, user_email, target_email, new_role):
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

@app.get("/api/rooms")
def list_rooms():
    return manager.get_active_rooms()

async def refresh_video_url(video_data: dict, user_agent: str = None) -> dict:
    """
    Re-resolves the stream URL for a video using its original URL.
    This prevents playback failures from expired YouTube manifest URLs.
    """
    if not video_data or not video_data.get("original_url"):
        return video_data

    original_url = video_data["original_url"]
    logger.info(f"Refreshing stream URL for: {original_url}")

    ydl_opts = {
        'format': 'best',
        'quiet': True,
        'no_warnings': True,
        'nocheckcertificate': True,
        'socket_timeout': 10,
        'extractor_args': {'youtube': {'player_client': ['ios']}},
        'http_headers': {
            'User-Agent': user_agent or 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://www.youtube.com/',
        }
    }

    cookie_path = os.path.join("data", "cookies.txt")
    if os.path.exists(cookie_path):
        ydl_opts['cookiefile'] = cookie_path

    try:
        import asyncio
        loop = asyncio.get_event_loop()
        
        def do_resolve():
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(original_url, download=False)
                stream_url = None
                
                formats = info.get('formats', [])
                # 1. Try to find HLS manifest
                for f in formats:
                    manifest_url = f.get('manifest_url') or f.get('url', '')
                    if '.m3u8' in manifest_url:
                        stream_url = manifest_url
                        break
                
                # 2. Fallback: find best format with BOTH video and audio
                if not stream_url:
                    for f in reversed(formats):
                        if f.get('vcodec') != 'none' and f.get('acodec') != 'none':
                            stream_url = f.get('url')
                            break
                
                # 3. Last resort: default url (might be audio-only if best was audio-only, unlikely with 'best' format)
                if not stream_url:
                    stream_url = info.get('url')
                
                return stream_url
        
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


@app.get("/api/resolve")
def resolve_stream(
    url: str = Query(..., description="The URL of the video/stream to resolve"),
    user_agent: str = Query(None, description="User agent from the client browser")
):
    """
    Uses yt-dlp to resolve the input URL to a playable stream URL.
    Prefers HLS manifests with multiple qualities for quality selection.
    """
    logger.info(f"Resolving URL: {url} (UA: {user_agent[:50]}...)")

    ydl_opts = {
        'format': 'best',
        'quiet': True,
        'no_warnings': True,
        'nocheckcertificate': True,
        'socket_timeout': 10,
        # Enable generic extractor for unsupported sites
        'default_search': 'auto',
        'extractor_args': {'youtube': {'player_client': ['ios']}},
        'http_headers': {
            'User-Agent': user_agent or 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
        }
    }


    # Add cookie support if cookies.txt exists in data directory
    cookie_path = os.path.join("data", "cookies.txt")
    if os.path.exists(cookie_path):
        logger.info(f"Using cookies from {cookie_path}")
        ydl_opts['cookiefile'] = cookie_path

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)

            stream_url = None
            is_live = info.get('is_live', False)

            # For YouTube, try to get the HLS manifest URL for quality selection
            formats = info.get('formats', [])

            # First, look for HLS manifest with multiple qualities
            # 1. Try to find HLS manifest
            for f in formats:
                manifest_url = f.get('manifest_url') or f.get('url', '')
                if '.m3u8' in manifest_url:
                    stream_url = manifest_url
                    break

            # 2. Fallback: find best format with BOTH video and audio
            if not stream_url:
                for f in reversed(formats):
                    if f.get('vcodec') != 'none' and f.get('acodec') != 'none':
                        stream_url = f.get('url')
                        break

            # 3. Last resort: default url
            if not stream_url:
                stream_url = info.get('url')

            if not stream_url:
                raise HTTPException(status_code=400, detail="Could not resolve a playable stream URL.")

            return {
                "original_url": url,
                "stream_url": stream_url,
                "title": info.get('title', 'Unknown Title'),
                "is_live": is_live,
                "thumbnail": info.get('thumbnail'),
                "backend_engine": "yt-dlp"
            }

    except Exception as e:
        error_msg = str(e)
        logger.error(f"Error resolving URL {url}: {error_msg}")
        
        # Log full traceback for better debugging
        import traceback
        logger.error(traceback.format_exc())
        
        # Provide more specific error messages
        if "Sign in to confirm your age" in error_msg:
            raise HTTPException(
                status_code=403, 
                detail="[W2G-SECURE] YT_AGE_GATE_BYPASS_FAILED: Access denied. Cookies in data/cookies.txt are likely invalid or for the wrong region/browser."
            )
        elif "Incomplete YouTube ID" in error_msg or "Video unavailable" in error_msg:
            raise HTTPException(
                status_code=400,
                detail="The video is unavailable or the URL is invalid."
            )
        
        raise HTTPException(status_code=500, detail=f"Failed to resolve URL: {error_msg}")

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
            # Use the shared client for segments too
            # IMPORTANT: We use the same client pool but different request context
            req = segment_client.build_request("GET", url, headers=outgoing_headers)
            r = await segment_client.send(req, stream=True)
            
            # Filter headers to forward
            response_headers = {}
            # Forward critical headers for playback/seeking
            for key in ["content-type", "content-length", "content-range", "accept-ranges", "cache-control", "date", "last-modified"]:
                if key in r.headers:
                    response_headers[key] = r.headers[key]
            
            # Add CORS headers
            response_headers["Access-Control-Allow-Origin"] = "*"
            response_headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"
            response_headers["Access-Control-Allow-Headers"] = "*"

            return StreamingResponse(
                r.aiter_bytes(),
                status_code=r.status_code,
                headers=response_headers,
                background=BackgroundTask(r.aclose),
                media_type=r.headers.get("content-type", "application/octet-stream")
            )
    except Exception as e:
        logger.error(f"Proxy error for {url}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Proxy error: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
