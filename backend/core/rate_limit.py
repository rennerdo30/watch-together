"""
Per-user rate limiting.

Lives in core/ so every route that accepts uploads shares one limiter.
It used to be private to the cookie routes, which is why the extension
sync endpoint accepted unlimited uploads while the cookie endpoint next
to it was limited.

The store is per process. That is adequate for the single-worker
deployment this runs in (room state is in memory too), but it does not
coordinate across replicas — see the startup check in main.
"""
import time
import logging
from typing import Dict, Tuple

from fastapi import HTTPException

from core.config import (
    RATE_LIMIT_WINDOW_SECONDS,
    RATE_LIMIT_MAX_REQUESTS,
    RATE_LIMIT_STORE_MAX_KEYS,
)

logger = logging.getLogger(__name__)

# (scope, identity) -> (request_count, window_start)
_store: Dict[Tuple[str, str], Tuple[int, float]] = {}


def _prune(now: float) -> None:
    """Drop entries whose window closed long ago."""
    if len(_store) <= RATE_LIMIT_STORE_MAX_KEYS:
        return
    stale = [
        key for key, (_count, started) in _store.items()
        if now - started > RATE_LIMIT_WINDOW_SECONDS * 2
    ]
    for key in stale:
        del _store[key]


def check_rate_limit(
    identity: str,
    scope: str = "default",
    max_requests: int = RATE_LIMIT_MAX_REQUESTS,
    window_seconds: float = RATE_LIMIT_WINDOW_SECONDS,
) -> None:
    """Count one request against a user's budget.

    Raises HTTPException(429) once the budget for the current window is
    spent. Scopes are counted separately, so a limit on one endpoint
    cannot exhaust another's.
    """
    if not identity:
        return

    now = time.time()
    _prune(now)

    key = (scope, identity)
    entry = _store.get(key)

    if entry and (now - entry[1]) < window_seconds:
        count = entry[0]
        if count >= max_requests:
            logger.warning(f"Rate limit hit for {identity} on {scope}")
            raise HTTPException(
                status_code=429,
                detail="Too many requests. Try again later.",
            )
        _store[key] = (count + 1, entry[1])
    else:
        _store[key] = (1, now)


def reset() -> None:
    """Clear all counters (used by tests)."""
    _store.clear()
