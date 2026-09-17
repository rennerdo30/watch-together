"""
Room listing API routes.
"""
from fastapi import APIRouter

from connection_manager import manager
from core import config

router = APIRouter(prefix="/api", tags=["rooms"])


@router.get("/rooms")
def list_rooms():
    """Returns list of active rooms."""
    return manager.get_active_rooms()


@router.get("/webrtc/ice")
def ice_servers():
    """How a browser should look for a path to another browser.

    A screen share travels directly between two members; this server only
    relays the handshake. STUN servers tell a browser how it appears from
    the outside, which is enough wherever a direct path exists. A TURN
    relay carries the media itself when none does — it costs bandwidth and
    money, so it is configured per deployment rather than assumed, and
    adding one later is an environment change rather than a code change.
    """
    servers = [{"urls": list(config.WEBRTC_STUN_URLS)}] if config.WEBRTC_STUN_URLS else []
    if config.WEBRTC_TURN_URL:
        servers.append({
            "urls": config.WEBRTC_TURN_URL,
            "username": config.WEBRTC_TURN_USERNAME,
            "credential": config.WEBRTC_TURN_CREDENTIAL,
        })
    return {"iceServers": servers}
