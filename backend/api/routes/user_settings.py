"""
Per-user preferences.

Identity comes from the verified request identity, never from the body, so
a user can only ever read or change their own settings.
"""
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
import pydantic

from core.security import get_user_from_request
from services.user_settings import load_user_settings, update_user_settings
from services.watch_history import reporter as history_reporter

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["user-settings"])


class UserSettingsUpdate(pydantic.BaseModel):
    """Every field optional: a client sends only what it changed."""
    model_config = pydantic.ConfigDict(extra="ignore")

    youtube_history: Optional[pydantic.StrictBool] = None


def _identity(request: Request) -> str:
    user_email = get_user_from_request(request)
    if not user_email:
        raise HTTPException(status_code=401, detail="User identity required")
    return user_email


@router.get("/user/settings")
async def get_settings(request: Request):
    user_email = _identity(request)
    return {"settings": await load_user_settings(user_email)}


@router.put("/user/settings")
async def put_settings(request: Request, changes: UserSettingsUpdate):
    user_email = _identity(request)
    applied = await update_user_settings(user_email, changes.model_dump(exclude_none=True))
    # Rooms the user is sitting in start or stop reporting right away, so
    # the switch has a visible effect without leaving and rejoining.
    history_reporter.settings_changed(user_email, applied)
    return {"settings": applied}
