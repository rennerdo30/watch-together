"""
Browser extension sync API routes.

The extension is the only way cookies reach the server. A synced copy is
held in memory (see `services/user_cookies.py`) and never written anywhere;
it expires unless the extension keeps refreshing it.
"""
import asyncio
import logging
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from fastapi import APIRouter, Request, Response, HTTPException, Header
import pydantic

from core import config
from core.rate_limit import check_rate_limit
from services import extension_package, user_cookies

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/extension", tags=["extension"])

# Counted separately from other per-user endpoints so a busy extension
# cannot lock a user out of the web UI, or the other way round.
RATE_LIMIT_SCOPE = "extension-sync"
NO_STORE_HEADERS = {"Cache-Control": "private, no-store"}

# browser key -> (source fingerprint, archive). Rebuilt only when a source
# file changes, so serving the download costs a stat per packaged file.
_package_cache: Dict[str, Tuple[tuple, bytes]] = {}


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
    response: Response,
    sync_data: CookieSyncRequest,
    authorization: str = Header(None)
):
    """
    Receive cookies from browser extension.
    Auth: Bearer token
    Body: { cookies: "# Netscape...", domains: [...], browser: "chrome" }
    """
    # Validate token
    response.headers.update(NO_STORE_HEADERS)
    user_email = await validate_bearer_token(authorization)
    check_rate_limit(user_email, scope=RATE_LIMIT_SCOPE)

    # Extract token ID for updating sync stats
    token_id = authorization[7:]

    content = sync_data.cookies
    if not content.strip():
        raise HTTPException(status_code=400, detail="Empty cookie content", headers=NO_STORE_HEADERS)

    try:
        entry = user_cookies.store(
            user_email, content, browser=sync_data.browser, domains=sync_data.domains)
    except user_cookies.CookieFormatError as exc:
        raise HTTPException(status_code=400, detail=str(exc), headers=NO_STORE_HEADERS)

    try:
        from services.database import update_token_sync
        await update_token_sync(token_id)
    except Exception as exc:
        # The sync itself succeeded; the counter is bookkeeping.
        logger.warning(f"Could not record sync statistics for {user_email}: {exc}")

    logger.info(
        f"Extension sync: user={user_email}, "
        f"browser={sync_data.browser or 'unknown'}, "
        f"domains={sync_data.domains}, cookies={len(entry.cookies)}"
    )

    return {
        "status": "ok",
        "message": "Cookies synced successfully",
        "domains": sync_data.domains,
        "cookie_count": len(entry.cookies),
        "expires_at": entry.expires_at,
    }


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

    from services.database import get_token
    token = await get_token(token_id)

    return {
        "status": "ok",
        "valid": True,
        "user_email": user_email,
        "last_sync_at": token["last_sync_at"] if token else None,
        "sync_count": token["sync_count"] if token else 0,
        **user_cookies.status(user_email),
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

    The cookies that token delivered go with it: disconnecting is the
    member's way of saying "stop using my session now".
    """
    user_email = await validate_bearer_token(authorization)
    token_id = authorization[7:]

    from services.database import revoke_token
    revoked = await revoke_token(token_id)
    user_cookies.forget(user_email)
    response.headers.update(NO_STORE_HEADERS)
    return {"status": "ok", "revoked": bool(revoked)}


@router.get("/download/{browser}")
async def download_extension(browser: str):
    """A packaged build of the extension, straight from this instance.

    Built from the `extension/` folder the deployment mounts, so members
    get the build matching the backend they talk to rather than hunting
    for a release page.
    """
    build = extension_package.BUILDS.get(browser)
    if build is None:
        raise HTTPException(status_code=404, detail="No packaged build exists for that browser")

    source = Path(config.EXTENSION_SOURCE_DIR)
    try:
        fingerprint = await asyncio.to_thread(extension_package.source_fingerprint, source, build)
        cached = _package_cache.get(browser)
        if cached and cached[0] == fingerprint:
            archive = cached[1]
        else:
            archive = await asyncio.to_thread(extension_package.build_archive, source, build)
            _package_cache[browser] = (fingerprint, archive)
            logger.info(f"Packaged the {build.label} extension from {source} ({len(archive)} bytes)")
    except extension_package.ExtensionSourceMissing as exc:
        logger.error(f"Extension source unavailable at {source}: {exc}")
        raise HTTPException(
            status_code=503,
            detail="The extension source is not available on this server",
        )

    return Response(
        content=archive,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{build.filename}"',
            "Cache-Control": config.EXTENSION_PACKAGE_CACHE_CONTROL,
        },
    )
