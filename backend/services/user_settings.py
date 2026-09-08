"""
Per-user preferences: a small JSON object per identity, normalised on both
sides of the database so a stale or hostile client can never store a key the
server does not know.
"""

import logging
from typing import Any, Dict, Optional

from core.config import USER_SETTINGS_DEFAULTS
from services.database import get_user_settings, save_user_settings

logger = logging.getLogger(__name__)

# Settings are read on every room event that could start history reporting,
# so the last answer per user is kept until that user changes something.
_cache: Dict[str, Dict[str, Any]] = {}


def normalize_user_settings(raw: Any) -> Dict[str, Any]:
    """Known keys only, each coerced to the type of its default."""
    settings = dict(USER_SETTINGS_DEFAULTS)
    if not isinstance(raw, dict):
        return settings
    for key, default in USER_SETTINGS_DEFAULTS.items():
        if key not in raw:
            continue
        value = raw[key]
        if isinstance(default, bool):
            settings[key] = bool(value)
        else:
            settings[key] = value
    return settings


async def load_user_settings(user_email: Optional[str]) -> Dict[str, Any]:
    if not user_email:
        return dict(USER_SETTINGS_DEFAULTS)
    cached = _cache.get(user_email)
    if cached is not None:
        return dict(cached)
    settings = normalize_user_settings(await get_user_settings(user_email))
    _cache[user_email] = settings
    return dict(settings)


async def update_user_settings(user_email: str, changes: Any) -> Dict[str, Any]:
    """Apply the known keys of `changes` on top of what is stored."""
    current = await load_user_settings(user_email)
    if isinstance(changes, dict):
        for key in USER_SETTINGS_DEFAULTS:
            if key in changes:
                current[key] = changes[key]
    settings = normalize_user_settings(current)
    await save_user_settings(user_email, settings)
    _cache[user_email] = settings
    logger.info("User settings for %s: %s", user_email, settings)
    return dict(settings)


def clear_cache() -> None:
    _cache.clear()
