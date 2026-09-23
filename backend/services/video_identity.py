"""Stable identity for a queueable video address."""

import re
from typing import Optional
from urllib.parse import parse_qs, urlparse


_YOUTUBE_HOSTS = {
    "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
    "youtube-nocookie.com", "www.youtube-nocookie.com",
}
_SHORT_HOSTS = {"youtu.be", "www.youtu.be"}
_PATH_PREFIXES = ("/shorts/", "/embed/", "/live/", "/v/")
_VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")


def youtube_video_id(url: Optional[str]) -> Optional[str]:
    """The 11-character id of a YouTube video URL, or None for anything else."""
    if not isinstance(url, str) or not url:
        return None
    try:
        parsed = urlparse(url.strip())
        host = (parsed.hostname or "").lower()
    except ValueError:
        return None
    candidate = None
    if host in _SHORT_HOSTS:
        candidate = parsed.path.strip("/").split("/", 1)[0]
    elif host in _YOUTUBE_HOSTS:
        if parsed.path == "/watch":
            candidate = parse_qs(parsed.query).get("v", [None])[0]
        else:
            for prefix in _PATH_PREFIXES:
                if parsed.path.startswith(prefix):
                    candidate = parsed.path[len(prefix):].split("/", 1)[0]
                    break
    if candidate and _VIDEO_ID.fullmatch(candidate):
        return candidate
    return None


def queue_video_identity(url: str) -> tuple[str, str]:
    """Only YouTube's known URL shapes share an identity across addresses."""
    video_id = youtube_video_id(url)
    return ("youtube", video_id) if video_id else ("url", url.strip())
