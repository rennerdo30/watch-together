"""
Admin panel API.

Every endpoint requires the request's verified identity to be listed in
the ADMIN_EMAILS environment variable (comma-separated). The default is
empty, which disables the panel entirely: admin access is always an
explicit deployment decision, never a value baked into the repository.

The panel exposes what actually matters when operating the service:
the live rooms (including who is connected), and the state of every
cache tier — the disk segment cache, the in-memory segment cache, the
resolved-format cache and the proxy transfer metrics — plus the
destructive maintenance actions for each.
"""
import time
import logging

from fastapi import APIRouter, HTTPException, Request, Response

from core import config
from core.security import get_user_from_request
from connection_manager import manager
from services import shared_browser
from services.cache import memory_cache, disk_cache_report, clear_disk_cache
from services.database import get_all_cached_formats, clear_format_cache
from services.metrics import proxy_metrics
from services import user_cookies
from services.playback_quality import history as playback_history, verdict as playback_verdict

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/admin", tags=["admin"])

# Process start, for the uptime figure. The module is imported once at
# application startup.
STARTED_AT = time.time()

def require_admin(request: Request) -> str:
    """Resolve the verified identity and demand it is an admin."""
    user = get_user_from_request(request)
    if not user:
        raise HTTPException(status_code=401, detail="User identity required")
    if user.strip().lower() not in config.ADMIN_EMAILS:
        # Logged: repeated probes against admin endpoints are worth seeing.
        logger.info(f"Admin access refused for {user}")
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


@router.get("/overview")
async def admin_overview(request: Request, response: Response):
    """Rooms, viewers and the members whose cookies are currently held."""
    user = require_admin(request)
    response.headers["Cache-Control"] = "private, no-store"

    rooms = []
    for rid, state in manager.room_states.items():
        connections = manager.active_connections.get(rid, [])
        video_data = state.get("video_data") or {}
        rooms.append({
            "id": rid,
            "name": state.get("name", ""),
            "active_users": len(connections),
            "members": sorted({getattr(ws, "user_email", config.GUEST_IDENTITY) for ws in connections}),
            # What each viewer's player says about its own picture, which is
            # the only place the inputs to an auto-quality decision exist.
            "playback": [
                {
                    "member": getattr(ws, "user_email", config.GUEST_IDENTITY),
                    "verdict": playback_verdict(ws.playback_quality),
                    **ws.playback_quality,
                }
                for ws in connections
                if getattr(ws, "playback_quality", None)
            ],
            "current_video": video_data.get("title"),
            "is_live": bool(video_data.get("is_live")),
            "is_playing": bool(state.get("is_playing")),
            "queue_size": len(state.get("queue", [])),
            "permanent": bool(state.get("permanent")),
        })

    cookie_users = user_cookies.holders()

    # Where an admin actually looks when the room says the shared browser is
    # off. The switch is deployment configuration rather than a panel
    # control, so this reports the state and names what is missing.
    browser = {
        "available": shared_browser.is_available(),
        "reason": shared_browser.unavailable_reason(),
        "transport": shared_browser.media_transport(),
        "missing": shared_browser.setup_checklist(),
        "rooms": sorted(manager.browser_sessions),
    }

    logger.debug(f"Admin overview served to {user}")
    return {
        "requested_by": user,
        "uptime_seconds": round(time.time() - STARTED_AT, 1),
        "totals": {
            "rooms": len(rooms),
            "viewers": sum(r["active_users"] for r in rooms),
        },
        "rooms": rooms,
        "cookie_users": cookie_users,
        "shared_browser": browser,
        # Every recent *change* of picture, including viewers who have since
        # left — `rooms[].playback` only knows who is connected right now.
        # The same lines are in the backend log; this is the browser's copy.
        "playback_history": playback_history.snapshot(
            limit=config.ADMIN_PLAYBACK_HISTORY_LIMIT),
    }


@router.get("/cache")
async def admin_cache(request: Request, response: Response):
    """Every cache tier, inspectable in one response."""
    user = require_admin(request)
    response.headers["Cache-Control"] = "private, no-store"
    logger.debug(f"Admin cache inspection served to {user}")
    return {
        "segments": disk_cache_report(max_entries=config.ADMIN_SEGMENT_LIST_LIMIT),
        "memory": memory_cache.get_stats(),
        "formats": await get_all_cached_formats(),
        "proxy": await proxy_metrics.snapshot(
            sample_limit=config.ADMIN_PROXY_SAMPLE_LIMIT, include_identity=True),
    }


@router.delete("/cache/segments")
async def admin_clear_segments(request: Request):
    """Delete every cached segment from disk."""
    user = require_admin(request)
    result = clear_disk_cache()
    logger.info(
        f"Admin {user} cleared the segment cache: "
        f"{result['removed']} files, {result['freed_bytes']} bytes"
    )
    return result


@router.delete("/cache/formats")
async def admin_clear_formats(request: Request):
    """Drop every cached format resolution."""
    user = require_admin(request)
    removed = await clear_format_cache()
    logger.info(f"Admin {user} cleared the format cache: {removed} entries")
    return {"removed": removed}


@router.delete("/cache/memory")
async def admin_clear_memory(request: Request):
    """Drop the in-memory segment cache."""
    user = require_admin(request)
    before = memory_cache.get_stats()
    await memory_cache.clear()
    logger.info(
        f"Admin {user} cleared the memory cache: "
        f"{before['items']} items, {before['size_mb']} MB"
    )
    return {"removed_items": before["items"], "freed_mb": before["size_mb"]}


@router.delete("/rooms/{room_id}")
async def admin_close_room(room_id: str, request: Request):
    """Force-close a room: disconnect everyone and delete its state."""
    user = require_admin(request)
    closed = await manager.close_room(room_id)
    if not closed:
        raise HTTPException(status_code=404, detail="No such room")
    logger.info(f"Admin {user} closed room {room_id}")
    return {"closed": room_id}
