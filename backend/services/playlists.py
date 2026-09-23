"""Short-lived, requester-owned YouTube playlist previews."""

import asyncio
import math
import os
import re
import secrets
import time
from dataclasses import dataclass, field
from itertools import islice
from typing import Optional
from urllib.parse import parse_qs, urlencode, urlparse

import yt_dlp

from core.config import YTDLP_CACHE_DIR
from services.resolver import build_ydl_opts
from services.user_cookies import cookie_file, has_cookies_for
from services.video_identity import queue_video_identity, youtube_video_id


MAX_PLAYLIST_VIDEOS = 150
PREVIEW_TTL_SECONDS = 600
MAX_STORED_PREVIEWS = 100
_PLAYLIST_ID = re.compile(r"^[A-Za-z0-9_-]{1,100}$")


class PlaylistError(ValueError):
    def __init__(self, detail: str, status_code: int = 400):
        super().__init__(detail)
        self.status_code = status_code


def canonical_playlist_url(url: str) -> str:
    """Accept only an explicit YouTube playlist, including watch URLs with list=."""
    if not isinstance(url, str) or len(url) > 2048:
        raise PlaylistError("A YouTube playlist URL is required.")
    try:
        parsed = urlparse(url.strip())
        host = (parsed.hostname or "").lower()
    except ValueError as exc:
        raise PlaylistError("A YouTube playlist URL is required.") from exc
    if parsed.scheme not in ("http", "https") or host not in {
        "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
        "youtube-nocookie.com", "www.youtube-nocookie.com",
        "youtu.be", "www.youtu.be",
    }:
        raise PlaylistError("A YouTube playlist URL is required.")
    if host in {"youtu.be", "www.youtu.be"}:
        if not youtube_video_id(url):
            raise PlaylistError("A YouTube playlist URL is required.")
    elif parsed.path not in ("/playlist", "/watch"):
        raise PlaylistError("A YouTube playlist URL is required.")
    playlist_ids = parse_qs(parsed.query).get("list", [])
    if len(playlist_ids) != 1 or not _PLAYLIST_ID.fullmatch(playlist_ids[0]):
        raise PlaylistError("A YouTube playlist URL is required.")
    return "https://www.youtube.com/playlist?" + urlencode({"list": playlist_ids[0]})


def _extract_flat(url: str, options: dict) -> dict:
    with yt_dlp.YoutubeDL(options) as ydl:
        # Processing the playlist applies playlist_items. extract_flat keeps
        # each item as metadata; no video stream is resolved here.
        info = ydl.extract_info(url, download=False, process=True)
        if isinstance(info, dict) and info.get("_type") == "playlist":
            # YouTube may return a lazy, paged entry list. Iterate while the
            # requester's temporary cookie file still exists, in this worker.
            source = info.get("entries")
            info["entries"] = list(islice(source if source is not None else (),
                                           MAX_PLAYLIST_VIDEOS + 1))
        return info


async def discover(url: str, requester: str, user_agent: Optional[str] = None) -> dict:
    """Read at most 151 flat entries with only the requester's own cookies."""
    canonical = canonical_playlist_url(url)
    options = build_ydl_opts(None, user_agent)
    options.update({
        "noplaylist": False,
        "extract_flat": "in_playlist",
        "playlist_items": f"1:{MAX_PLAYLIST_VIDEOS + 1}",
        "ignoreerrors": True,
        "cache_dir": YTDLP_CACHE_DIR,
    })
    os.makedirs(YTDLP_CACHE_DIR, exist_ok=True)
    owner = requester if has_cookies_for(requester, canonical) else None
    async with cookie_file(owner) as cookie_path:
        if cookie_path:
            options["cookiefile"] = cookie_path
        try:
            info = await asyncio.to_thread(_extract_flat, canonical, options)
        except Exception as exc:
            raise PlaylistError("Could not read this playlist.", 400) from exc
    if not isinstance(info, dict) or info.get("_type") != "playlist":
        raise PlaylistError("This URL did not return a playlist.")
    count = info.get("playlist_count") or info.get("entry_count")
    if isinstance(count, int) and count > MAX_PLAYLIST_VIDEOS:
        raise PlaylistError("Playlists may contain at most 150 videos.", 413)
    raw_entries = list(islice(info.get("entries") or [], MAX_PLAYLIST_VIDEOS + 1))
    if len(raw_entries) > MAX_PLAYLIST_VIDEOS:
        raise PlaylistError("Playlists may contain at most 150 videos.", 413)
    if not raw_entries:
        raise PlaylistError("This playlist contains no videos.")
    entries = []
    for index, raw in enumerate(raw_entries, start=1):
        raw = raw if isinstance(raw, dict) else {}
        video_id = raw.get("id")
        if not isinstance(video_id, str) or not youtube_video_id(f"https://youtu.be/{video_id}"):
            video_id = None
        availability = raw.get("availability")
        unavailable_title = str(raw.get("title") or "").strip().lower() in {
            "private video", "deleted video", "[private video]", "[deleted video]",
        }
        available = (bool(video_id) and not unavailable_title
                     and isinstance(availability, (str, type(None)))
                     and availability not in {
                         "private", "needs_auth", "subscriber_only", "premium_only",
                     })
        duration = raw.get("duration")
        if (isinstance(duration, bool) or not isinstance(duration, (int, float))
                or not math.isfinite(duration) or duration < 0):
            duration = None
        thumbnails = raw.get("thumbnails")
        thumbnail = raw.get("thumbnail")
        if not isinstance(thumbnail, str) and isinstance(thumbnails, list):
            thumbnail = next((item["url"] for item in reversed(thumbnails)
                              if isinstance(item, dict) and isinstance(item.get("url"), str)), None)
        entries.append({
            "id": secrets.token_urlsafe(12),
            "index": index,
            "title": str(raw.get("title") or "Unavailable video")[:300],
            "thumbnail": thumbnail if isinstance(thumbnail, str) else None,
            "duration": duration,
            "available": available,
            "reason": None if available else str(availability or "Unavailable video"),
            "url": f"https://www.youtube.com/watch?v={video_id}" if available else None,
        })
    return {"title": str(info.get("title") or "YouTube playlist")[:300], "entries": entries}


@dataclass
class Preview:
    room_id: str
    requester: str
    title: str
    entries: list[dict]
    expires_at: float
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    result: Optional[dict] = None
    selected_ids: Optional[tuple[str, ...]] = None

    def public(self, preview_id: str, queued: set[tuple[str, str]]) -> dict:
        return {
            "preview_id": preview_id,
            "title": self.title,
            "entries": [{key: value for key, value in entry.items() if key != "url"} | {
                "already_queued": bool(entry["url"] and queue_video_identity(entry["url"]) in queued),
            } for entry in self.entries],
            "total": len(self.entries),
            "expires_at": self.expires_at,
        }


_previews: dict[str, Preview] = {}


def create_preview(room_id: str, requester: str, title: str, entries: list[dict],
                   queued: set[tuple[str, str]]) -> dict:
    now = time.time()
    for token, preview in list(_previews.items()):
        if preview.expires_at <= now:
            del _previews[token]
    while len(_previews) >= MAX_STORED_PREVIEWS:
        oldest = min(_previews, key=lambda token: _previews[token].expires_at)
        del _previews[oldest]
    token = secrets.token_urlsafe(24)
    preview = Preview(room_id, requester, title, entries, now + PREVIEW_TTL_SECONDS)
    _previews[token] = preview
    return preview.public(token, queued)


def get_preview(token: str, room_id: str, requester: str) -> Preview:
    preview = _previews.get(token)
    if (preview is None or preview.expires_at <= time.time()
            or preview.room_id != room_id or preview.requester != requester):
        raise PlaylistError("Playlist preview expired or was not found.", 404)
    return preview
