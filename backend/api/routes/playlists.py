"""Preview a YouTube playlist, then explicitly import selected videos."""

import asyncio

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from connection_manager import manager
from core.security import get_user_from_request
from services import playlists
from services.video_identity import queue_video_identity


router = APIRouter(prefix="/api/rooms/{room_id}/playlist", tags=["playlists"])


class PreviewRequest(BaseModel):
    url: str


class ConfirmRequest(BaseModel):
    preview_id: str
    selected_ids: list[str] = Field(min_length=1, max_length=playlists.MAX_PLAYLIST_VIDEOS)


def _authorized(room_id: str, request: Request) -> str:
    user = get_user_from_request(request)
    if not user:
        raise HTTPException(status_code=401, detail="User identity required")
    state = manager.room_states.get(room_id)
    if state is None:
        raise HTTPException(status_code=404, detail="Room not found")
    if state.get("roles", {}).get(user) not in ("admin", "moderator"):
        raise HTTPException(status_code=403, detail="Room admin or moderator required")
    return user


@router.post("/preview")
async def preview_playlist(room_id: str, body: PreviewRequest, request: Request) -> dict:
    user = _authorized(room_id, request)
    try:
        found = await playlists.discover(body.url, user, request.headers.get("user-agent"))
    except playlists.PlaylistError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    _authorized(room_id, request)  # An extraction can outlive a role change.
    queue = manager.room_states[room_id].get("queue", [])
    queued = {queue_video_identity(entry["original_url"]) for entry in queue
              if isinstance(entry.get("original_url"), str)}
    return playlists.create_preview(room_id, user, found["title"], found["entries"], queued)


async def _resolve_batch(room_id: str, requester: str, entries: list[dict],
                         user_agent: str | None) -> None:
    import main

    limit = asyncio.Semaphore(4)

    async def one(entry: dict) -> None:
        async with limit:
            await main._resolve_queued(room_id, entry["original_url"], requester,
                                       user_agent=user_agent)

    await asyncio.gather(*(one(entry) for entry in entries))


@router.post("/confirm")
async def confirm_playlist(room_id: str, body: ConfirmRequest, request: Request) -> dict:
    user = _authorized(room_id, request)
    try:
        preview = playlists.get_preview(body.preview_id, room_id, user)
    except playlists.PlaylistError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    async with preview.lock:
        _authorized(room_id, request)
        selected = tuple(body.selected_ids)
        if len(selected) != len(set(selected)):
            raise HTTPException(status_code=422, detail="Duplicate playlist selection")
        if preview.result is not None:
            if preview.selected_ids != selected:
                raise HTTPException(status_code=409, detail="Preview already confirmed")
            return preview.result
        ids = {entry["id"]: entry for entry in preview.entries}
        if any(entry_id not in ids or not ids[entry_id]["available"] for entry_id in selected):
            raise HTTPException(status_code=422, detail="Invalid playlist selection")
        selected_set = set(selected)
        urls = [entry["url"] for entry in preview.entries if entry["id"] in selected_set]
        try:
            added, skipped, queue, playing_index = await manager.queue_playlist_urls(
                room_id, user, urls)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Room not found") from exc
        except PermissionError as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc
        result = {"added": len(added), "skipped": skipped}
        preview.selected_ids = selected
        preview.result = result
        if added:
            await manager.broadcast({"type": "queue_update", "payload": {
                "queue": queue, "playing_index": playing_index}}, room_id)
            import main
            main._run_detached(_resolve_batch(room_id, user, added,
                                              request.headers.get("user-agent")))
        return result
