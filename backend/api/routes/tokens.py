"""
API Token management routes for browser extension.
"""
import logging
from fastapi import APIRouter, Request, Response, HTTPException

from core.security import get_user_from_request

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["tokens"])
NO_STORE_HEADERS = {"Cache-Control": "private, no-store"}


@router.get("/me")
async def get_current_user(request: Request, response: Response):
    """
    Get the current user's identity.
    Used by the frontend to detect if user is authenticated.
    """
    response.headers.update(NO_STORE_HEADERS)
    user_email = get_user_from_request(request)
    if not user_email:
        return {"authenticated": False, "email": None}

    return {"authenticated": True, "email": user_email}


@router.get("/token")
async def get_token(request: Request, response: Response):
    """
    Get or create an API token for the current user.
    Used by the browser extension to authenticate.

    The owner is returned in the same authenticated response as the token, so
    the extension cannot pair an email from one browser session with a token
    created after the session switched to another user.
    """
    response.headers.update(NO_STORE_HEADERS)
    user_email = get_user_from_request(request)
    if not user_email:
        raise HTTPException(
            status_code=401,
            detail="User identity required",
            headers=NO_STORE_HEADERS,
        )

    from services.database import get_or_create_token
    token = await get_or_create_token(user_email)

    return {
        "status": "ok",
        "user_email": user_email,
        "token": {
            "id": token["id"],
            "created_at": token["created_at"],
            "last_used_at": token["last_used_at"],
            "last_sync_at": token["last_sync_at"],
            "sync_count": token["sync_count"],
        }
    }


@router.post("/token/regenerate")
async def regenerate_token(request: Request, response: Response):
    """
    Revoke current token and create a new one.
    """
    response.headers.update(NO_STORE_HEADERS)
    user_email = get_user_from_request(request)
    if not user_email:
        raise HTTPException(
            status_code=401,
            detail="User identity required",
            headers=NO_STORE_HEADERS,
        )

    from services.database import revoke_user_tokens, create_token

    # Revoke all existing tokens
    revoked = await revoke_user_tokens(user_email)
    logger.info(f"Revoked {revoked} tokens for user: {user_email}")

    # Create new token
    token = await create_token(user_email)

    return {
        "status": "ok",
        "message": f"Token regenerated ({revoked} old token(s) revoked)",
        "user_email": user_email,
        "token": {
            "id": token["id"],
            "created_at": token["created_at"],
            "last_used_at": token["last_used_at"],
            "last_sync_at": token["last_sync_at"],
            "sync_count": token["sync_count"],
        }
    }


@router.delete("/token")
async def revoke_token(request: Request, response: Response):
    """
    Revoke the current user's API token.
    """
    response.headers.update(NO_STORE_HEADERS)
    user_email = get_user_from_request(request)
    if not user_email:
        raise HTTPException(
            status_code=401,
            detail="User identity required",
            headers=NO_STORE_HEADERS,
        )

    from services.database import revoke_user_tokens

    revoked = await revoke_user_tokens(user_email)
    logger.info(f"Revoked {revoked} tokens for user: {user_email}")

    return {
        "status": "ok",
        "message": f"Revoked {revoked} token(s)"
    }
