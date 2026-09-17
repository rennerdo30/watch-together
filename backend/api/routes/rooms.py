"""
Room listing API routes.
"""
import logging

from fastapi import APIRouter

from connection_manager import manager
from core import config

logger = logging.getLogger(__name__)

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
        if config.WEBRTC_TURN_USERNAME and config.WEBRTC_TURN_CREDENTIAL:
            servers.append({
                "urls": config.WEBRTC_TURN_URL,
                "username": config.WEBRTC_TURN_USERNAME,
                "credential": config.WEBRTC_TURN_CREDENTIAL,
            })
        else:
            # A TURN entry with a blank username or credential is not a relay
            # that will not work — it makes `new RTCPeerConnection(...)` throw
            # outright, so screen sharing stops entirely, including the direct
            # paths that never needed a relay. Half-configured TURN must
            # therefore be dropped rather than passed on.
            logger.warning(
                "WEBRTC_TURN_URL is set without WEBRTC_TURN_USERNAME and "
                "WEBRTC_TURN_CREDENTIAL; the relay is being ignored. A TURN "
                "entry with blank credentials makes browsers refuse to build "
                "a peer connection at all."
            )
    return {"iceServers": servers}
