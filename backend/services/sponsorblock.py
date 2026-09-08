"""
SponsorBlock: community-submitted segments to skip, applied room-wide.

Segments come from the SponsorBlock API for the YouTube video a room is
watching. Skipping is done by the server, not by each viewer: the room's
authoritative position is here, so one seek broadcast moves everyone past
the segment together, exactly as if a member had dragged the scrubber.
Per-client skipping would have every viewer seek on their own clock and
the room spend the next heartbeat arguing about where it is.

Lookups use the hash-prefix endpoint, which returns segments for every
video whose id hashes to the same prefix. The server never tells
SponsorBlock which video the room is actually watching.
"""

import asyncio
import hashlib
import json
import logging
import re
import time
from dataclasses import dataclass
from typing import Awaitable, Callable, Dict, List, Optional, Sequence, Tuple
from urllib.parse import parse_qs, urlparse

import httpx

from core.config import (
    SPONSORBLOCK_API_URL,
    SPONSORBLOCK_CACHE_MAX_ENTRIES,
    SPONSORBLOCK_CACHE_TTL_SECONDS,
    SPONSORBLOCK_CATEGORIES,
    SPONSORBLOCK_DEFAULT_CATEGORIES,
    SPONSORBLOCK_DEFAULT_ENABLED,
    SPONSORBLOCK_HASH_PREFIX_LENGTH,
    SPONSORBLOCK_MIN_SEGMENT_SECONDS,
    SPONSORBLOCK_SKIP_TOLERANCE_SECONDS,
    SPONSORBLOCK_TIMEOUT_SECONDS,
    SPONSORBLOCK_USER_AGENT,
)

logger = logging.getLogger(__name__)

# Only segments meant to be jumped over. Mute, chapter and highlight entries
# describe the video rather than tell a player what to skip.
SKIP_ACTION_TYPE = "skip"

# The state keys a room carries for this feature. `sponsorblock` is the
# admin's setting and is persisted; the other two describe the video that is
# playing right now and are rebuilt whenever it changes.
SETTINGS_KEY = "sponsorblock"
SEGMENTS_KEY = "sponsor_segments"
SEGMENTS_VIDEO_KEY = "sponsor_video"

_YOUTUBE_HOSTS = {
    "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
    "youtube-nocookie.com", "www.youtube-nocookie.com",
}
_SHORT_HOSTS = {"youtu.be", "www.youtu.be"}
_PATH_PREFIXES = ("/shorts/", "/embed/", "/live/", "/v/")
_VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")


class SponsorBlockError(Exception):
    """The SponsorBlock API could not be consulted."""


@dataclass(frozen=True)
class Segment:
    start: float
    end: float
    category: str
    uuid: str

    @property
    def duration(self) -> float:
        return self.end - self.start

    def to_payload(self) -> dict:
        return {
            "start": round(self.start, 3),
            "end": round(self.end, 3),
            "category": self.category,
            "uuid": self.uuid,
        }


def youtube_video_id(url: Optional[str]) -> Optional[str]:
    """The 11-character id of a YouTube video URL, or None for anything else."""
    if not isinstance(url, str) or not url:
        return None
    try:
        parsed = urlparse(url.strip())
    except ValueError:
        return None
    host = (parsed.hostname or "").lower()
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
    if candidate and _VIDEO_ID.match(candidate):
        return candidate
    return None


def default_settings() -> dict:
    return {
        "enabled": SPONSORBLOCK_DEFAULT_ENABLED,
        "categories": list(SPONSORBLOCK_DEFAULT_CATEGORIES),
    }


def normalize_settings(raw) -> dict:
    """A well-formed settings dict from whatever a client or database supplied.

    Unknown categories are dropped rather than rejected, so a stale client
    cannot wedge the setting, and the order always follows the canonical list.
    """
    defaults = default_settings()
    if not isinstance(raw, dict):
        return defaults
    enabled = raw.get("enabled", defaults["enabled"])
    categories = raw.get("categories", defaults["categories"])
    if not isinstance(categories, (list, tuple)):
        categories = defaults["categories"]
    wanted = {c for c in categories if isinstance(c, str)}
    return {
        "enabled": bool(enabled),
        "categories": [c for c in SPONSORBLOCK_CATEGORIES if c in wanted],
    }


def hash_prefix(video_id: str) -> str:
    return hashlib.sha256(video_id.encode("utf-8")).hexdigest()[:SPONSORBLOCK_HASH_PREFIX_LENGTH]


def parse_segments(body, video_id: str) -> List[Segment]:
    """Skippable segments for `video_id` from a hash-prefix response."""
    segments: List[Segment] = []
    if not isinstance(body, list):
        return segments
    for entry in body:
        if not isinstance(entry, dict) or entry.get("videoID") != video_id:
            continue
        for raw in entry.get("segments") or []:
            if not isinstance(raw, dict) or raw.get("actionType") != SKIP_ACTION_TYPE:
                continue
            category = raw.get("category")
            if category not in SPONSORBLOCK_CATEGORIES:
                continue
            bounds = raw.get("segment")
            try:
                start, end = float(bounds[0]), float(bounds[1])
            except (TypeError, ValueError, IndexError):
                continue
            if end - start < SPONSORBLOCK_MIN_SEGMENT_SECONDS:
                continue
            segments.append(Segment(start, end, category, str(raw.get("UUID", ""))))
    segments.sort(key=lambda s: (s.start, s.end))
    return segments


def select_segments(segments: Sequence[Segment], categories: Sequence[str]) -> List[Segment]:
    """The segments of the chosen categories, overlapping ones merged.

    Two segments that overlap or nearly touch are one jump: skipping the
    first alone would land inside the second and trigger a second seek a
    moment later, which viewers experience as a stutter.
    """
    wanted = set(categories)
    chosen = sorted((s for s in segments if s.category in wanted), key=lambda s: (s.start, s.end))
    merged: List[Segment] = []
    for segment in chosen:
        if merged and segment.start <= merged[-1].end + SPONSORBLOCK_SKIP_TOLERANCE_SECONDS:
            last = merged[-1]
            merged[-1] = Segment(last.start, max(last.end, segment.end), last.category, last.uuid)
        else:
            merged.append(segment)
    return merged


def next_skip(segments: Sequence[Segment], position: float) -> Optional[Segment]:
    """The first segment still ahead of, or surrounding, `position`.

    A segment whose end is within the tolerance of the position counts as
    passed: a skip lands exactly on an end, and re-skipping it would loop.
    """
    for segment in segments:
        if segment.end - position > SPONSORBLOCK_SKIP_TOLERANCE_SECONDS:
            return segment
    return None


class SegmentCache:
    """Segments per video id, bounded and time-limited."""

    def __init__(self, ttl_seconds: float = SPONSORBLOCK_CACHE_TTL_SECONDS,
                 max_entries: int = SPONSORBLOCK_CACHE_MAX_ENTRIES,
                 now: Callable[[], float] = time.time):
        self._ttl = ttl_seconds
        self._max = max_entries
        self._now = now
        self._entries: Dict[str, Tuple[float, List[Segment]]] = {}

    def get(self, video_id: str) -> Optional[List[Segment]]:
        entry = self._entries.get(video_id)
        if not entry:
            return None
        expires, segments = entry
        if expires <= self._now():
            del self._entries[video_id]
            return None
        return list(segments)

    def put(self, video_id: str, segments: List[Segment]) -> None:
        if len(self._entries) >= self._max:
            oldest = min(self._entries, key=lambda k: self._entries[k][0])
            del self._entries[oldest]
        self._entries[video_id] = (self._now() + self._ttl, list(segments))

    def clear(self) -> None:
        self._entries.clear()


class SponsorBlockClient:
    """Fetches skippable segments for a video, with caching."""

    def __init__(self, api_url: str = SPONSORBLOCK_API_URL,
                 transport: Optional[httpx.AsyncBaseTransport] = None):
        self._api_url = api_url.rstrip("/")
        self._transport = transport
        self._client: Optional[httpx.AsyncClient] = None
        self.cache = SegmentCache()

    def configure(self, *, api_url: Optional[str] = None,
                  transport: Optional[httpx.AsyncBaseTransport] = None) -> None:
        """Repoint the client (tests use this to avoid the network)."""
        if api_url is not None:
            self._api_url = api_url.rstrip("/")
        self._transport = transport
        self._client = None
        self.cache.clear()

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=SPONSORBLOCK_TIMEOUT_SECONDS,
                headers={"User-Agent": SPONSORBLOCK_USER_AGENT},
                transport=self._transport,
            )
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def segments_for(self, video_id: str) -> List[Segment]:
        """Every skippable segment of every category, cached per video.

        All categories are fetched at once so that changing the room's
        selection is a filter over what is already known, not another
        request.
        """
        cached = self.cache.get(video_id)
        if cached is not None:
            return cached
        url = f"{self._api_url}/api/skipSegments/{hash_prefix(video_id)}"
        params = {
            "categories": json.dumps(list(SPONSORBLOCK_CATEGORIES)),
            "actionTypes": json.dumps([SKIP_ACTION_TYPE]),
        }
        try:
            response = await self._http().get(url, params=params)
        except httpx.HTTPError as exc:
            raise SponsorBlockError(f"SponsorBlock request failed: {exc}") from exc
        if response.status_code == 404:
            # No segments for any video with this prefix.
            segments: List[Segment] = []
        elif response.status_code != 200:
            raise SponsorBlockError(f"SponsorBlock returned HTTP {response.status_code}")
        else:
            try:
                segments = parse_segments(response.json(), video_id)
            except ValueError as exc:
                raise SponsorBlockError("SponsorBlock returned malformed JSON") from exc
        self.cache.put(video_id, segments)
        logger.debug("SponsorBlock: %d skippable segment(s) for video %s", len(segments), video_id)
        return segments


class SponsorSkipper:
    """Schedules the room-wide skip for the video each room is playing.

    One task per room sleeps until the next segment starts, then moves the
    room past it. Any change to what is playing or where — play, pause,
    seek, a new video, a settings change — re-arms the task, so the wait is
    always computed from the current authoritative position.
    """

    def __init__(self, manager, client: Optional[SponsorBlockClient] = None, *,
                 now: Callable[[], float] = time.time,
                 sleep: Callable[[float], Awaitable[None]] = asyncio.sleep):
        self._manager = manager
        self.client = client or SponsorBlockClient()
        self._now = now
        self._sleep = sleep
        self._tasks: Dict[str, asyncio.Task] = {}
        self._loads: Dict[str, asyncio.Task] = {}
        # Called with the room id after every skip. A skip moves the room
        # like a member's seek does, and whatever tracks position (the
        # watch-history reporter) has to learn about it the same way.
        self.on_skip: Optional[Callable[[str], None]] = None

    # ----- position helpers -------------------------------------------------

    def _position(self, state: dict) -> float:
        position = float(state.get("timestamp", 0) or 0)
        if state.get("is_playing"):
            position += self._now() - state.get("last_sync_time", self._now())
        return position

    @staticmethod
    def _video_key(state: dict) -> Optional[str]:
        video = state.get("video_data") or {}
        return video.get("original_url") or None

    # ----- public entry points ----------------------------------------------

    def video_changed(self, room_id: str) -> None:
        """The room plays a different video: load its segments, then arm."""
        state = self._manager.room_states.get(room_id)
        if state is None:
            return
        state[SEGMENTS_KEY] = []
        state[SEGMENTS_VIDEO_KEY] = self._video_key(state)
        self._cancel(self._tasks, room_id)
        self._cancel(self._loads, room_id)
        self._loads[room_id] = asyncio.create_task(self._load_and_arm(room_id))

    def ensure_loaded(self, room_id: str) -> None:
        """Load segments if the room's current video has none yet (e.g. after a restart)."""
        state = self._manager.room_states.get(room_id)
        if state is None:
            return
        if state.get(SEGMENTS_VIDEO_KEY) != self._video_key(state) or SEGMENTS_KEY not in state:
            self.video_changed(room_id)
        elif room_id not in self._tasks or self._tasks[room_id].done():
            self.rearm(room_id)

    def rearm(self, room_id: str) -> None:
        """Recompute the next skip from the room's current state."""
        self._cancel(self._tasks, room_id)
        if room_id not in self._manager.room_states:
            return
        self._tasks[room_id] = asyncio.create_task(self._run(room_id))

    def forget(self, room_id: str) -> None:
        self._cancel(self._tasks, room_id)
        self._cancel(self._loads, room_id)

    async def wait_idle(self) -> None:
        """Let pending loads and skips finish (tests).

        A load re-arms the skip task when it completes, so one round of
        waiting is not enough: keep going until nothing is pending.
        """
        while True:
            pending = [t for t in list(self._loads.values()) + list(self._tasks.values()) if not t.done()]
            if not pending:
                return
            await asyncio.gather(*pending, return_exceptions=True)

    # ----- internals --------------------------------------------------------

    @staticmethod
    def _cancel(tasks: Dict[str, asyncio.Task], room_id: str) -> None:
        task = tasks.pop(room_id, None)
        if task is not None and not task.done():
            task.cancel()

    def _release(self, tasks: Dict[str, asyncio.Task], room_id: str) -> None:
        """Drop this task's own entry once it is done, so the dicts hold only live tasks."""
        if tasks.get(room_id) is asyncio.current_task():
            del tasks[room_id]

    async def _load_and_arm(self, room_id: str) -> None:
        try:
            state = self._manager.room_states.get(room_id)
            if state is None:
                return
            video = state.get("video_data") or {}
            video_key = self._video_key(state)
            video_id = None if video.get("is_live") else youtube_video_id(video.get("original_url"))
            segments: List[Segment] = []
            if video_id:
                try:
                    segments = await self.client.segments_for(video_id)
                except SponsorBlockError as exc:
                    logger.warning("SponsorBlock lookup failed for room %s: %s", room_id, exc)
            state = self._manager.room_states.get(room_id)
            if state is None or self._video_key(state) != video_key:
                return  # The room moved on while we were fetching.
            state[SEGMENTS_KEY] = [s.to_payload() for s in segments]
            state[SEGMENTS_VIDEO_KEY] = video_key
            if segments:
                await self._manager.broadcast({
                    "type": "sponsorblock_segments",
                    "payload": {"video_url": video_key, "segments": state[SEGMENTS_KEY]},
                }, room_id)
            self.rearm(room_id)
        except asyncio.CancelledError:
            raise
        except Exception:  # A task's exception is otherwise reported only at garbage collection.
            logger.exception("SponsorBlock lookup crashed for room %s", room_id)
        finally:
            self._release(self._loads, room_id)

    def _active_segments(self, state: dict) -> List[Segment]:
        settings = normalize_settings(state.get(SETTINGS_KEY))
        if not settings["enabled"] or state.get(SEGMENTS_VIDEO_KEY) != self._video_key(state):
            return []
        known = [
            Segment(s["start"], s["end"], s["category"], s.get("uuid", ""))
            for s in state.get(SEGMENTS_KEY) or []
        ]
        return select_segments(known, settings["categories"])

    async def _run(self, room_id: str) -> None:
        try:
            while True:
                state = self._manager.room_states.get(room_id)
                if not state or not state.get("is_playing"):
                    return
                video = state.get("video_data") or {}
                if not video or video.get("is_live"):
                    return
                segments = self._active_segments(state)
                position = self._position(state)
                segment = next_skip(segments, position)
                if segment is None:
                    return
                wait = segment.start - position
                if wait > 0:
                    await self._sleep(wait)
                    state = self._manager.room_states.get(room_id)
                    if not state or not state.get("is_playing"):
                        return
                    # A member's seek can reach the state a moment before its
                    # re-arm cancels this task. Skipping then would overwrite
                    # the position they just chose, so only skip if the room
                    # really is at this segment now; otherwise start over.
                    position = self._position(state)
                    if not (segment.start - SPONSORBLOCK_SKIP_TOLERANCE_SECONDS <= position < segment.end):
                        continue
                await self._skip(room_id, segment)
        except asyncio.CancelledError:
            raise
        except Exception:  # A skip must never take the room down with it.
            logger.exception("SponsorBlock skip failed for room %s", room_id)
        finally:
            self._release(self._tasks, room_id)

    async def _skip(self, room_id: str, segment: Segment) -> None:
        logger.info("SponsorBlock: room %s skips %s %.1fs-%.1fs",
                    room_id, segment.category, segment.start, segment.end)
        await self._manager.update_state(room_id, {"timestamp": segment.end})
        await self._manager.broadcast({
            "type": "seek",
            "payload": {
                "timestamp": segment.end,
                "skipped": {
                    "category": segment.category,
                    "start": round(segment.start, 3),
                    "end": round(segment.end, 3),
                },
            },
        }, room_id)
        if self.on_skip is not None:
            self.on_skip(room_id)
