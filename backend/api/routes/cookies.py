"""
Cookie management API routes.
"""
import os
import time
import logging
import aiofiles
from typing import Dict, Tuple
from fastapi import APIRouter, Request, HTTPException
import pydantic

from core.config import COOKIES_DIR
from core.security import get_user_cookie_path, get_user_from_request

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["cookies"])


MAX_COOKIE_SIZE = 1 * 1024 * 1024  # 1MB limit

# Simple in-memory rate limiter: user_email -> (request_count, window_start)
_rate_limit_store: Dict[str, Tuple[int, float]] = {}
_RATE_LIMIT_WINDOW = 60.0  # 1 minute
_RATE_LIMIT_MAX_REQUESTS = 10  # Max uploads per window


def _check_rate_limit(user_email: str) -> None:
    """Check and enforce per-user rate limit. Raises HTTPException if exceeded."""
    now = time.time()

    # Periodic cleanup of stale entries to prevent unbounded growth
    if len(_rate_limit_store) > 1000:
        stale_keys = [k for k, (_, ts) in _rate_limit_store.items() if now - ts > _RATE_LIMIT_WINDOW * 2]
        for k in stale_keys:
            del _rate_limit_store[k]

    entry = _rate_limit_store.get(user_email)
    if entry:
        count, window_start = entry
        if now - window_start < _RATE_LIMIT_WINDOW:
            if count >= _RATE_LIMIT_MAX_REQUESTS:
                raise HTTPException(status_code=429, detail="Too many cookie upload requests. Try again later.")
            _rate_limit_store[user_email] = (count + 1, window_start)
        else:
            _rate_limit_store[user_email] = (1, now)
    else:
        _rate_limit_store[user_email] = (1, now)


class CookieContent(pydantic.BaseModel):
    content: str


@router.get("/cookies")
async def get_cookies(request: Request):
    """
    Returns the current user's cookies (masked for security).
    """
    user_email = get_user_from_request(request)
    if not user_email:
        raise HTTPException(status_code=401, detail="User identity required")

    try:
        from services.database import get_user_cookies
        content = await get_user_cookies(user_email)
        
        if not content:
            return {"status": "ok", "has_cookies": False, "content": ""}
            
        return {"status": "ok", "has_cookies": True, "content": content}
    except Exception as e:
        logger.error(f"Failed to read cookies for {user_email}: {e}")
        return {"status": "ok", "has_cookies": False, "content": ""}


@router.post("/cookies")
async def update_cookies(request: Request, cookie_data: CookieContent):
    """
    Updates the user's cookies.txt with provided Netscape-formatted content.
    Stores in DB and syncs to filesystem for yt-dlp usage.
    """
    user_email = get_user_from_request(request)
    if not user_email:
        raise HTTPException(status_code=401, detail="User identity required. Please log in.")

    _check_rate_limit(user_email)

    try:
        content = cookie_data.content
        if not content.strip():
            raise HTTPException(status_code=400, detail="Empty content")

        # Validate size
        if len(content.encode('utf-8')) > MAX_COOKIE_SIZE:
            raise HTTPException(status_code=400, detail="Cookie content exceeds 1MB limit")

        # Validate basic Netscape format (all data lines)
        lines = [l.strip() for l in content.splitlines() if l.strip() and not l.strip().startswith('#')]
        if not lines:
            raise HTTPException(status_code=400, detail="No cookie data lines found")
        for line in lines:
            parts = line.split('\t')
            if len(parts) != 7:
                raise HTTPException(
                    status_code=400,
                    detail="Invalid Netscape cookie format. Each data line must have 7 tab-separated fields."
                )

        # 1. Save to Database
        from services.database import save_user_cookies
        await save_user_cookies(user_email, content)

        # 2. Sync to Filesystem (for yt-dlp usage)
        cookie_path = get_user_cookie_path(user_email)
        if cookie_path:
            # Ensure directory
            os.makedirs(os.path.dirname(cookie_path), exist_ok=True)
            async with aiofiles.open(cookie_path, 'w') as f:
                await f.write(content)

        logger.info(f"Updated cookies for user: {user_email}")
        return {"status": "ok", "message": "Cookies updated successfully"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to update cookies for {user_email}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/cookies")
async def delete_cookies(request: Request):
    """
    Deletes the current user's cookies.
    """
    user_email = get_user_from_request(request)
    if not user_email:
        raise HTTPException(status_code=401, detail="User identity required")

    # 1. Delete from Database
    from services.database import delete_user_cookies
    await delete_user_cookies(user_email)

    # 2. Delete from Filesystem
    cookie_path = get_user_cookie_path(user_email)
    if cookie_path and os.path.exists(cookie_path):
        os.remove(cookie_path)
    
    logger.info(f"Deleted cookies for user: {user_email}")
    return {"status": "ok", "message": "Cookies deleted"}
