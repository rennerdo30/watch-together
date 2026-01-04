"""
Cookie management API routes.
"""
import os
import logging
import aiofiles
from fastapi import APIRouter, Request, HTTPException
import pydantic

from core.config import COOKIES_DIR
from core.security import get_user_cookie_path, get_user_from_request

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["cookies"])


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

    try:
        content = cookie_data.content
        if not content.strip():
            raise HTTPException(status_code=400, detail="Empty content")

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
