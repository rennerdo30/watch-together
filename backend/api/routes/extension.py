"""
Browser extension sync API routes.
"""
import os
import logging
from typing import List, Optional
from fastapi import APIRouter, Request, Response, HTTPException, Header
import pydantic

from core.config import COOKIES_DIR, COOKIE_FILE_MODE
from core.security import get_user_cookie_path
from core.rate_limit import check_rate_limit

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/extension", tags=["extension"])

# Counted separately from browser cookie uploads so a busy extension
# cannot lock a user out of the web UI, or the other way round.
RATE_LIMIT_SCOPE = "extension-sync"
NO_STORE_HEADERS = {"Cache-Control": "private, no-store"}


class CookieSyncRequest(pydantic.BaseModel):
    cookies: str  # Netscape-formatted cookie content
    domains: List[str]  # List of domains the cookies are from
    browser: Optional[str] = None  # Browser name (chrome, firefox, edge, safari)


async def validate_bearer_token(authorization: str) -> str:
    """Validate Bearer token and return user_email."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=401,
            detail="Missing or invalid authorization header",
            headers=NO_STORE_HEADERS,
        )

    token_id = authorization[7:]  # Remove "Bearer " prefix

    from services.database import validate_token
    user_email = await validate_token(token_id)

    if not user_email:
        raise HTTPException(
            status_code=401,
            detail="Invalid or expired token",
            headers=NO_STORE_HEADERS,
        )

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
    check_rate_limit(user_email, scope=RATE_LIMIT_SCOPE)

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
            os.chmod(cookie_path, COOKIE_FILE_MODE)

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
async def get_status(response: Response, authorization: str = Header(None)):
    """
    Check token validity and get sync status.
    Returns token info and last sync time.
    """
    response.headers.update(NO_STORE_HEADERS)
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


@router.delete("/token")
async def revoke_extension_token(
    response: Response,
    authorization: str = Header(None),
):
    """Revoke the exact bearer token held by this extension.

    The web token endpoint revokes every token owned by the current Access
    session. Disconnecting an extension must not depend on that session still
    being the same user, or revoke some other user's credentials after an
    account switch.
    """
    await validate_bearer_token(authorization)
    token_id = authorization[7:]

    from services.database import revoke_token
    revoked = await revoke_token(token_id)
    response.headers.update(NO_STORE_HEADERS)
    return {"status": "ok", "revoked": bool(revoked)}
