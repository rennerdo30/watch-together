"""
Cookie status for the signed-in member.

Cookies reach the server only through the browser extension (see
`api/routes/extension.py`) and live in process memory until they expire or
the member drops them. Nothing here ever returns a cookie value, and
nothing accepts one: a form that pastes session cookies into a web page is
the wrong place for credentials worth more than a password.
"""
import logging

from fastapi import APIRouter, HTTPException, Request, Response

from core.security import get_user_from_request
from services import user_cookies

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["cookies"])

NO_STORE_HEADERS = {"Cache-Control": "private, no-store"}


@router.get("/cookies")
async def get_cookie_status(request: Request, response: Response):
    """Whether the server currently holds this member's cookies, and until when."""
    user_email = get_user_from_request(request)
    if not user_email:
        raise HTTPException(status_code=401, detail="User identity required", headers=NO_STORE_HEADERS)

    response.headers.update(NO_STORE_HEADERS)
    return {"status": "ok", **user_cookies.status(user_email)}


@router.delete("/cookies")
async def forget_cookies(request: Request, response: Response):
    """Drop this member's cookies from memory now, ahead of their expiry."""
    user_email = get_user_from_request(request)
    if not user_email:
        raise HTTPException(status_code=401, detail="User identity required", headers=NO_STORE_HEADERS)

    forgotten = user_cookies.forget(user_email)
    logger.info(f"Cookies of {user_email} dropped on request (held: {forgotten})")
    response.headers.update(NO_STORE_HEADERS)
    return {"status": "ok", "forgotten": forgotten}
