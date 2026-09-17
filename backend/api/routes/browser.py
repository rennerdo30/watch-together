"""
The shared browser: what the room may show, and how a tab gets into it.

Two endpoints, and they are deliberately different in kind. The first
answers a question every room asks on load and nobody needs credentials
for — can this instance do it at all, and is anyone using it. The second
mints a session against neko and is the only thing here that touches a
password; it never returns one, it sets a cookie.
"""
import logging

from fastapi import APIRouter, HTTPException, Request, Response

from connection_manager import manager
from core import config
from core.rate_limit import check_rate_limit
from core.security import get_user_from_request
from services import shared_browser

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/browser", tags=["browser"])

# Minting a session is a request to another container, so it is budgeted
# separately from uploads rather than sharing their allowance.
RATE_LIMIT_SCOPE = "browser-session"
RATE_LIMIT_MAX_SESSIONS = 20


@router.get("")
async def browser_status(room: str = ""):
    """Whether the shared browser can be opened, and who has it.

    `reason` is a code, not a sentence: the room wording differs from the
    operator wording, and only one of the two belongs in an API.
    """
    reason = shared_browser.unavailable_reason()
    holder = manager.browser_holder()
    return {
        "enabled": config.BROWSER_ENABLED,
        "available": reason is None,
        "reason": reason,
        "transport": shared_browser.media_transport(),
        "running": await shared_browser.is_running(),
        "path": shared_browser.embed_path(),
        # Which room holds it, so a second room can say so by name rather
        # than showing a button that will be refused.
        "held_by_room": holder,
        "session": manager.browser_of(room) if room else None,
    }


@router.post("/session")
async def create_browser_session(request: Request, response: Response, room: str):
    """Mint a neko session for the caller and set it as a cookie.

    The password stays here. What the browser receives is a token scoped to
    neko's path on this origin, so the member can use the shared browser and
    still has nothing they could log in with anywhere else.
    """
    user_email = get_user_from_request(request)
    if not user_email:
        raise HTTPException(status_code=401, detail="Not authenticated")

    reason = shared_browser.unavailable_reason()
    if reason is not None:
        raise HTTPException(status_code=503, detail=reason)

    session = manager.browser_of(room)
    if not session:
        # Minting is gated on the room having opened the browser, so this is
        # not a way for anyone who can reach the API to get a neko login.
        raise HTTPException(
            status_code=409, detail="This room has no shared browser open")

    check_rate_limit(
        user_email, scope=RATE_LIMIT_SCOPE, max_requests=RATE_LIMIT_MAX_SESSIONS)

    # Only the room's admin drives it. Everyone else watches, which is neko's
    # own distinction between an admin member and a user member.
    roles = manager.room_states.get(room, {}).get("roles", {})
    as_admin = roles.get(user_email) == "admin"

    try:
        token = await shared_browser.mint_session(user_email, as_admin=as_admin)
    except shared_browser.BrowserSessionError as exc:
        logger.warning(f"Shared browser session for {user_email} failed: {exc}")
        raise HTTPException(
            status_code=502, detail="The shared browser could not be reached")

    response.set_cookie(
        key=config.BROWSER_SESSION_COOKIE_NAME,
        value=token,
        max_age=config.BROWSER_SESSION_MAX_AGE_SECONDS,
        # Scoped to neko's prefix: nothing else on this origin has any use
        # for it, and the room page must never be able to read it.
        path=config.BROWSER_PATH_PREFIX,
        httponly=True,
        secure=config.BROWSER_SESSION_COOKIE_SECURE,
        samesite="lax",
    )
    return {"path": shared_browser.embed_path(), "control": as_admin}
