"""
Security utilities for the Watch Together backend.
"""
import os
import logging

from core.config import COOKIES_DIR
from core.access_jwt import (
    ACCESS_JWT_HEADER, ACCESS_EMAIL_HEADER,
    AccessVerificationError, is_configured, verify_access_token,
)

logger = logging.getLogger(__name__)

DEVELOPMENT_MODE = os.environ.get("DEVELOPMENT_MODE", "").lower() in ("true", "1", "yes")


def get_user_cookie_path(user_email: str) -> str:
    """
    Get the cookie file path for a specific user.

    Returns None if:
    - Email is empty/None
    - Email contains directory traversal attempts
    - Resulting path escapes the allowed directory
    """
    if not user_email:
        return None

    # Reject potential directory traversal attempts
    if ".." in user_email or "/" in user_email or "\\" in user_email:
        logger.warning(f"Rejected suspicious email for cookie path: {user_email[:50]}")
        return None

    # Sanitize email to be filesystem-safe
    safe_name = "".join(c if c.isalnum() or c in "._-@" else "_" for c in user_email)

    # Final safety check - ensure resulting path is within COOKIES_DIR
    result_path = os.path.join(COOKIES_DIR, f"{safe_name}.txt")
    if not os.path.abspath(result_path).startswith(os.path.abspath(COOKIES_DIR)):
        logger.warning(f"Cookie path escaped allowed directory: {result_path}")
        return None

    return result_path


def _identity_from_headers(headers, query_params) -> str:
    """Resolve the caller's identity from Access assertions or dev fallbacks.

    The signed assertion is the only trusted source. The plain identity
    header is accepted solely when Access verification is unconfigured,
    because it is forgeable by anyone who can reach the origin directly.
    """
    assertion = headers.get(ACCESS_JWT_HEADER)

    if is_configured():
        if assertion:
            try:
                return verify_access_token(assertion)
            except AccessVerificationError as exc:
                logger.warning(f"Rejected Access assertion: {exc}")
                return None
        # Configured but no assertion: only development may fall back.
        if DEVELOPMENT_MODE:
            return query_params.get("user")
        return None

    # Access is not configured. Trust the identity header as before, and
    # allow the query parameter in development mode.
    user_email = headers.get(ACCESS_EMAIL_HEADER)
    if not user_email and DEVELOPMENT_MODE:
        user_email = query_params.get("user")
    return user_email


def get_user_from_request(request) -> str:
    """Extract the verified user identity from a request.

    Prefers the signed Cloudflare Access assertion. Falls back to the
    plain identity header only when Access verification is unconfigured,
    and to a query parameter only in development mode.
    """
    return _identity_from_headers(request.headers, request.query_params)


def get_user_from_websocket(websocket) -> str:
    """Identity for a WebSocket handshake, using the same rules."""
    return _identity_from_headers(websocket.headers, websocket.query_params)


def log_auth_configuration() -> None:
    """Report the active authentication mode at startup."""
    if is_configured():
        logger.info("Cloudflare Access JWT verification is enabled")
    else:
        logger.warning(
            "Cloudflare Access JWT verification is DISABLED: set "
            "CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD to verify identities. "
            "The identity header is currently trusted as-is and can be "
            "forged by anyone able to reach this origin directly."
        )
    if DEVELOPMENT_MODE:
        logger.warning(
            "DEVELOPMENT_MODE is on: the ?user= query parameter can set any "
            "identity. Never enable this in production."
        )
