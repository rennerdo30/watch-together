"""
Security utilities for the Watch Together backend.
"""
import os
import logging
from core.config import COOKIES_DIR

logger = logging.getLogger(__name__)


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


def get_user_from_request(request) -> str:
    """Extract user identity from Cloudflare header or query param."""
    # Try Cloudflare Access header first
    user_email = request.headers.get("cf-access-authenticated-user-email")
    # Fallback to query param for dev/testing
    if not user_email:
        user_email = request.query_params.get("user")
    return user_email
