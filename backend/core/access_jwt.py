"""
Cloudflare Access JWT verification.

Cloudflare Access forwards two things to the origin: a plain
`Cf-Access-Authenticated-User-Email` header and a signed
`Cf-Access-Jwt-Assertion` token. Only the second one proves the request
came through Access — the header alone is trivially forged by anyone who
can reach the origin directly.

This module verifies the assertion against the team's public keys and
returns the email from the verified claims. Keys are fetched from the
team JWKS endpoint and cached; verification fails closed.
"""
import time
import logging
import threading
from typing import Optional

import jwt
from jwt import PyJWKClient

from core.config import (
    CF_ACCESS_TEAM_DOMAIN,
    CF_ACCESS_AUD,
    CF_ACCESS_JWKS_CACHE_SECONDS,
    CF_ACCESS_JWKS_TIMEOUT_SECONDS,
    CF_ACCESS_ALGORITHMS,
)

logger = logging.getLogger(__name__)

# Header Cloudflare Access sets on every authenticated request.
ACCESS_JWT_HEADER = "cf-access-jwt-assertion"
# Legacy identity header. Trusted only when JWT verification is disabled.
ACCESS_EMAIL_HEADER = "cf-access-authenticated-user-email"

# Claim carrying the authenticated identity.
_EMAIL_CLAIM = "email"

_jwks_client: Optional[PyJWKClient] = None
_jwks_client_created_at: float = 0.0
_jwks_lock = threading.Lock()


class AccessVerificationError(Exception):
    """Raised when an Access assertion cannot be verified."""


def is_configured() -> bool:
    """True when Access JWT verification has been configured."""
    return bool(CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD)


def _certs_url() -> str:
    domain = CF_ACCESS_TEAM_DOMAIN.strip().rstrip("/")
    if not domain.startswith("http"):
        domain = f"https://{domain}"
    return f"{domain}/cdn-cgi/access/certs"


def _issuer() -> str:
    domain = CF_ACCESS_TEAM_DOMAIN.strip().rstrip("/")
    if not domain.startswith("http"):
        domain = f"https://{domain}"
    return domain


def _get_jwks_client() -> PyJWKClient:
    """Return a cached JWKS client, refreshing it periodically.

    PyJWKClient caches individual keys; recreating it on an interval also
    picks up key rotations that add new key ids.
    """
    global _jwks_client, _jwks_client_created_at

    with _jwks_lock:
        expired = (time.time() - _jwks_client_created_at) > CF_ACCESS_JWKS_CACHE_SECONDS
        if _jwks_client is None or expired:
            _jwks_client = PyJWKClient(
                _certs_url(),
                cache_keys=True,
                timeout=CF_ACCESS_JWKS_TIMEOUT_SECONDS,
            )
            _jwks_client_created_at = time.time()
            logger.debug("Created Access JWKS client for %s", _certs_url())
        return _jwks_client


def reset_jwks_cache() -> None:
    """Drop the cached JWKS client (used by tests and after config changes)."""
    global _jwks_client, _jwks_client_created_at
    with _jwks_lock:
        _jwks_client = None
        _jwks_client_created_at = 0.0


def verify_access_token(token: str) -> str:
    """Verify an Access assertion and return the authenticated email.

    Raises AccessVerificationError when the token is missing, malformed,
    expired, signed by an unknown key, or issued for another application.
    """
    if not token:
        raise AccessVerificationError("missing assertion")
    if not is_configured():
        raise AccessVerificationError("Access verification is not configured")

    try:
        signing_key = _get_jwks_client().get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=list(CF_ACCESS_ALGORITHMS),
            audience=CF_ACCESS_AUD,
            issuer=_issuer(),
            options={"require": ["exp", "iat", "aud", "iss"]},
        )
    except jwt.PyJWTError as exc:
        raise AccessVerificationError(f"invalid assertion: {exc}") from exc
    except Exception as exc:  # network failures reaching the JWKS endpoint
        raise AccessVerificationError(f"could not verify assertion: {exc}") from exc

    email = claims.get(_EMAIL_CLAIM)
    if not email:
        raise AccessVerificationError("assertion has no email claim")

    return email
