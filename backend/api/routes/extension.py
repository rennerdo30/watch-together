"""
Browser extension sync API routes.
"""
import os
import logging
from typing import List, Optional
from fastapi import APIRouter, Request, HTTPException, Header
import pydantic

from core.config import COOKIES_DIR
from core.security import get_user_cookie_path

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/extension", tags=["extension"])


class CookieSyncRequest(pydantic.BaseModel):
    cookies: str  # Netscape-formatted cookie content
    domains: List[str]  # List of domains the cookies are from
    browser: Optional[str] = None  # Browser name (chrome, firefox, edge, safari)


async def validate_bearer_token(authorization: str) -> str:
    """Validate Bearer token and return user_email."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid authorization header")

    token_id = authorization[7:]  # Remove "Bearer " prefix

    from services.database import validate_token
    user_email = await validate_token(token_id)

    if not user_email:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    return user_email


@router.post("/sync")
async def sync_cookies(
    request: Request,
    sync_data: CookieSyncRequest,
    authorization: str = Header(None)
):
    """
    Receive cookies from browser extension.
    Auth: Bearer token
    Body: { cookies: "# Netscape...", domains: [...], browser: "chrome" }
    """
    # Validate token
    user_email = await validate_bearer_token(authorization)

    # Extract token ID for updating sync stats
    token_id = authorization[7:]

    try:
        content = sync_data.cookies
        if not content.strip():
            raise HTTPException(status_code=400, detail="Empty cookie content")

        # Validate size (1MB limit, same as cookie upload)
        if len(content.encode('utf-8')) > 1 * 1024 * 1024:
            raise HTTPException(status_code=400, detail="Cookie content exceeds 1MB limit")

        # Validate Netscape format (all data lines must have 7 tab-separated fields)
        data_lines = [l.strip() for l in content.splitlines() if l.strip() and not l.strip().startswith('#')]
        if not data_lines:
            raise HTTPException(status_code=400, detail="No cookie data lines found")
        for line in data_lines:
            parts = line.split('\t')
            if len(parts) != 7:
                raise HTTPException(
                    status_code=400,
                    detail="Invalid Netscape cookie format. Each data line must have 7 tab-separated fields."
                )

        # 1. Save to Database
        from services.database import save_user_cookies, update_token_sync
        await save_user_cookies(user_email, content)

        # 2. Sync to Filesystem (for yt-dlp usage)
        cookie_path = get_user_cookie_path(user_email)
        if cookie_path:
            os.makedirs(os.path.dirname(cookie_path), exist_ok=True)
            import aiofiles
            async with aiofiles.open(cookie_path, 'w') as f:
                await f.write(content)

        # 3. Update token sync stats
        await update_token_sync(token_id)

        logger.info(
            f"Extension sync: user={user_email}, "
            f"browser={sync_data.browser or 'unknown'}, "
            f"domains={sync_data.domains}"
        )

        return {
            "status": "ok",
            "message": "Cookies synced successfully",
            "domains": sync_data.domains,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Extension sync failed for {user_email}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/status")
async def get_status(authorization: str = Header(None)):
    """
    Check token validity and get sync status.
    Returns token info and last sync time.
    """
    # Validate token
    user_email = await validate_bearer_token(authorization)
    token_id = authorization[7:]

    from services.database import get_token, user_has_cookies
    token = await get_token(token_id)
    has_cookies = await user_has_cookies(user_email)

    return {
        "status": "ok",
        "valid": True,
        "user_email": user_email,
        "last_sync_at": token["last_sync_at"] if token else None,
        "sync_count": token["sync_count"] if token else 0,
        "has_cookies": has_cookies,
    }
