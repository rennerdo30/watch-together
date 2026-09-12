"""
YouTube watch history for members who asked for it.

A member who has synced their cookies and switched the setting on gets the
room's viewing recorded on their own YouTube account: the video appears in
their history and "continue watching" remembers the position, exactly as if
they had watched on youtube.com.

It works the way YouTube's own player reports playback. The player response
carries two tracking URLs (`playbackTracking.videostatsPlaybackUrl` and
`videostatsWatchtimeUrl`); the player pings the first once when playback
starts and the second every so often with the range it has just played and
the current position. yt-dlp's `--mark-watched` uses the same URLs to fire a
single "watched it all" ping. Here they are captured during an extraction
made with the member's cookies — the URLs are bound to that session — and
pinged with the room's real position for as long as the video plays.

Everything about this is per member: their cookies, their extraction, their
pings. Nothing is reported for anyone who has not opted in.
"""

import asyncio
import logging
import random
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Dict, Optional, Tuple
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

import httpx
import yt_dlp
from yt_dlp.extractor.youtube import YoutubeIE
from yt_dlp.utils import url_or_none
from yt_dlp.utils.traversal import get_first

from core.config import (
    DEFAULT_USER_AGENT,
    YOUTUBE_HISTORY_CPN_LENGTH,
    YOUTUBE_HISTORY_MIN_RANGE_SECONDS,
    YOUTUBE_HISTORY_PING_INTERVAL_SECONDS,
    YOUTUBE_HISTORY_SEEK_THRESHOLD_SECONDS,
    YOUTUBE_HISTORY_TIMEOUT_SECONDS,
)
from services.resolver import ensure_cookie_file, build_ydl_opts
from services.sponsorblock import youtube_video_id
from services.user_cookies import get_cookie_header
from services.user_settings import load_user_settings

logger = logging.getLogger(__name__)

SETTING_KEY = "youtube_history"

# The yt-dlp param under which the patched mark-watched leaves the tracking
# URLs instead of pinging them. Only set by `capture_tracking_urls`.
CAPTURE_PARAM = "_wt_capture_tracking"
PLAYBACK_URL_KEY = "videostatsPlaybackUrl"
WATCHTIME_URL_KEY = "videostatsWatchtimeUrl"

# The alphabet the web player draws its client playback nonce from.
CPN_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"


@dataclass(frozen=True)
class TrackingUrls:
    playback: str
    watchtime: str


def generate_cpn(rng: random.Random = random) -> str:
    return "".join(rng.choice(CPN_ALPHABET) for _ in range(YOUTUBE_HISTORY_CPN_LENGTH))


def build_ping_url(base_url: str, *, cpn: str, position: float,
                   watched_from: Optional[float] = None, watched_to: Optional[float] = None) -> str:
    """The tracking URL with the parameters the player adds per ping.

    `cmt` is the current media time — what "continue watching" resumes
    from. `st`/`et` bound the range just watched; only the watch-time URL
    takes them, and yt-dlp notes they are what actually lands in history.
    """
    parsed = urlparse(base_url)
    params = parse_qs(parsed.query, keep_blank_values=True)
    params.update({
        "ver": ["2"],
        "cpn": [cpn],
        "cmt": [f"{position:.3f}"],
        "el": ["detailpage"],  # otherwise the ping counts as a Short
    })
    if watched_from is not None and watched_to is not None:
        params["st"] = [f"{watched_from:.3f}"]
        params["et"] = [f"{watched_to:.3f}"]
    return urlunparse(parsed._replace(query=urlencode(params, doseq=True)))


# ----- capturing the tracking URLs from yt-dlp ------------------------------

_original_mark_watched = YoutubeIE._mark_watched


def _capturing_mark_watched(self, video_id, player_responses):
    """yt-dlp's mark-watched, redirected into a sink when one is configured.

    Without the sink this is the stock behaviour, so a plain resolve with
    `mark_watched` set would still work as yt-dlp intends.
    """
    sink = self.get_param(CAPTURE_PARAM)
    if sink is None:
        return _original_mark_watched(self, video_id, player_responses)
    for key in (PLAYBACK_URL_KEY, WATCHTIME_URL_KEY):
        url = get_first(player_responses, ("playbackTracking", key, "baseUrl"), expected_type=url_or_none)
        if url:
            sink[key] = url


def install_tracking_capture() -> None:
    """Patch the YouTube extractor once per process."""
    if YoutubeIE._mark_watched is not _capturing_mark_watched:
        YoutubeIE._mark_watched = _capturing_mark_watched


async def capture_tracking_urls(original_url: str, cookie_path: str,
                                user_agent: Optional[str] = None) -> Optional[TrackingUrls]:
    """Extract the video with this member's cookies and keep the tracking URLs.

    yt-dlp only calls mark-watched when cookies were passed, which is also
    the only case in which the URLs are worth anything: they identify the
    signed-in session whose history is to be updated.
    """
    install_tracking_capture()
    sink: Dict[str, str] = {}
    opts = build_ydl_opts(cookie_path, user_agent)
    opts["mark_watched"] = True
    opts[CAPTURE_PARAM] = sink

    def extract() -> None:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.extract_info(original_url, download=False)

    try:
        await asyncio.to_thread(extract)
    except Exception as exc:  # yt-dlp raises its own hierarchy; none of it is fatal here
        # The URLs are captured at the end of extraction proper; format
        # selection, which runs afterwards, can still fail without making
        # them any less valid.
        logger.warning("History: extraction for %s reported: %s", original_url, exc)
    playback, watchtime = sink.get(PLAYBACK_URL_KEY), sink.get(WATCHTIME_URL_KEY)
    if not playback or not watchtime:
        logger.info("History: no tracking URLs in the player response for %s", original_url)
        return None
    return TrackingUrls(playback=playback, watchtime=watchtime)


# ----- reporting ------------------------------------------------------------

@dataclass
class HistorySession:
    """One member's reporting of one video."""
    room_id: str
    user_email: str
    video_key: str
    urls: TrackingUrls
    cpn: str
    # Where the range being watched began, and the position and time of the
    # last look at the room, so a seek can be told apart from playback.
    range_start: float
    last_position: float
    last_seen_at: float
    was_playing_at_last_look: bool = True
    started: bool = False
    task: Optional[asyncio.Task] = field(default=None, repr=False)


CaptureFn = Callable[[str, str], Awaitable[Optional[TrackingUrls]]]


class HistoryReporter:
    """Keeps YouTube informed of what each opted-in member is watching."""

    def __init__(self, manager, *, capture: CaptureFn = capture_tracking_urls,
                 transport: Optional[httpx.AsyncBaseTransport] = None,
                 now: Callable[[], float] = time.time,
                 sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
                 rng: random.Random = random):
        self._manager = manager
        self._capture = capture
        self._transport = transport
        self._client: Optional[httpx.AsyncClient] = None
        self._now = now
        self._sleep = sleep
        self._rng = rng
        self._sessions: Dict[Tuple[str, str], HistorySession] = {}
        self._starting: Dict[Tuple[str, str], asyncio.Task] = {}

    def configure(self, *, capture: Optional[CaptureFn] = None,
                  transport: Optional[httpx.AsyncBaseTransport] = None) -> None:
        """Swap the network-facing parts (tests)."""
        if capture is not None:
            self._capture = capture
        self._transport = transport
        self._client = None

    # ----- room state helpers ----------------------------------------------

    def _position(self, state: dict) -> float:
        position = float(state.get("timestamp", 0) or 0)
        if state.get("is_playing") and not state.get("startup_pending"):
            position += self._now() - state.get("last_sync_time", self._now())
        return position

    @staticmethod
    def _video_key(state: dict) -> Optional[str]:
        video = state.get("video_data") or {}
        return video.get("original_url") or None

    def _connected_emails(self, room_id: str):
        return {
            getattr(ws, "user_email", None)
            for ws in self._manager.active_connections.get(room_id, [])
        } - {None, "Guest"}

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=YOUTUBE_HISTORY_TIMEOUT_SECONDS,
                headers={"User-Agent": DEFAULT_USER_AGENT},
                transport=self._transport,
            )
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    # ----- public entry points ----------------------------------------------

    def video_changed(self, room_id: str) -> None:
        """A different video: end every session in the room and start afresh."""
        for key in [k for k in self._sessions if k[0] == room_id]:
            self._end(key)
        for key in [k for k in self._starting if k[0] == room_id]:
            self._cancel_start(key)
        for email in self._connected_emails(room_id):
            self.member_joined(room_id, email)

    def member_joined(self, room_id: str, user_email: Optional[str]) -> None:
        """Start reporting for one member if they opted in and a video plays."""
        if not user_email or user_email == "Guest":
            return
        key = (room_id, user_email)
        if key in self._sessions or key in self._starting:
            return
        state = self._manager.room_states.get(room_id)
        if not state or not self._video_key(state):
            return
        self._starting[key] = asyncio.create_task(self._start_session(key))

    def member_left(self, room_id: str, user_email: Optional[str]) -> None:
        if not user_email:
            return
        # Another tab of the same member may still be here.
        if user_email in self._connected_emails(room_id):
            return
        key = (room_id, user_email)
        self._cancel_start(key)
        self._end(key, final_ping=True)

    def rearm(self, room_id: str) -> None:
        """Play, pause or seek: report what was watched so far, then continue."""
        for key, session in list(self._sessions.items()):
            if key[0] != room_id:
                continue
            if session.task is not None and not session.task.done():
                session.task.cancel()
            session.task = asyncio.create_task(self._run(session, after_change=True))

    def settings_changed(self, user_email: str, settings: dict) -> None:
        """The member switched the setting; apply it to every room they are in."""
        enabled = bool(settings.get(SETTING_KEY))
        for room_id in list(self._manager.active_connections):
            if user_email not in self._connected_emails(room_id):
                continue
            key = (room_id, user_email)
            if enabled:
                self.member_joined(room_id, user_email)
            else:
                self._cancel_start(key)
                self._end(key)

    def active_for(self, room_id: str, user_email: str) -> bool:
        return (room_id, user_email) in self._sessions

    async def wait_idle(self) -> None:
        """Let session starts and pending pings finish (tests)."""
        while True:
            pending = [t for t in self._starting.values() if not t.done()]
            pending += [s.task for s in self._sessions.values() if s.task is not None and not s.task.done()]
            if not pending:
                return
            await asyncio.gather(*pending, return_exceptions=True)

    # ----- internals --------------------------------------------------------

    def _cancel_start(self, key: Tuple[str, str]) -> None:
        task = self._starting.pop(key, None)
        if task is not None and not task.done():
            task.cancel()

    def _end(self, key: Tuple[str, str], final_ping: bool = False) -> None:
        session = self._sessions.pop(key, None)
        if session is None:
            return
        if session.task is not None and not session.task.done():
            session.task.cancel()
        if final_ping:
            asyncio.create_task(self._report_range(session, self._current_position_for(session)))

    def _current_position_for(self, session: HistorySession) -> Optional[float]:
        state = self._manager.room_states.get(session.room_id)
        if not state or self._video_key(state) != session.video_key:
            return None
        return self._position(state)

    async def _start_session(self, key: Tuple[str, str]) -> None:
        room_id, user_email = key
        try:
            settings = await load_user_settings(user_email)
            if not settings.get(SETTING_KEY):
                return
            state = self._manager.room_states.get(room_id)
            if not state:
                return
            video = state.get("video_data") or {}
            video_key = self._video_key(state)
            if not video_key or video.get("is_live") or not youtube_video_id(video_key):
                return
            cookie_path = await ensure_cookie_file(user_email)
            if not cookie_path:
                logger.info("History: %s opted in but has no cookies; nothing reported", user_email)
                return
            urls = await self._capture(video_key, cookie_path)
            if urls is None:
                return
            state = self._manager.room_states.get(room_id)
            if not state or self._video_key(state) != video_key:
                return  # The room moved on during the extraction.
            if user_email not in self._connected_emails(room_id):
                return
            position = self._position(state)
            session = HistorySession(
                room_id=room_id, user_email=user_email, video_key=video_key, urls=urls,
                cpn=generate_cpn(self._rng), range_start=position,
                last_position=position, last_seen_at=self._now(),
            )
            self._sessions[key] = session
            session.task = asyncio.create_task(self._run(session, after_change=False))
            logger.info("History: reporting %s for %s in room %s", video_key, user_email, room_id)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("History: could not start reporting for %s in room %s", user_email, room_id)
        finally:
            if self._starting.get(key) is asyncio.current_task():
                del self._starting[key]

    async def _run(self, session: HistorySession, *, after_change: bool) -> None:
        """Ping on start, after every change, and then on the interval while playing."""
        try:
            state = self._manager.room_states.get(session.room_id)
            if not state or self._video_key(state) != session.video_key:
                return
            if not session.started:
                position = self._position(state)
                # Bookkeeping before the await: a re-arm that cancels this
                # task mid-ping must not make the next one start over.
                session.started = True
                session.range_start = session.last_position = position
                session.last_seen_at = self._now()
                await self._ping(session, session.urls.playback, position)
            elif after_change:
                await self._settle_change(session, state)
            while True:
                state = self._manager.room_states.get(session.room_id)
                if not state or self._video_key(state) != session.video_key or not state.get("is_playing") or state.get("startup_pending"):
                    return
                await self._sleep(YOUTUBE_HISTORY_PING_INTERVAL_SECONDS)
                state = self._manager.room_states.get(session.room_id)
                if not state or self._video_key(state) != session.video_key:
                    return
                position = self._position(state)
                await self._report_range(session, position)
                if not state.get("is_playing") or state.get("startup_pending"):
                    return
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("History: reporting failed for %s in room %s", session.user_email, session.room_id)

    async def _settle_change(self, session: HistorySession, state: dict) -> None:
        """Close the range watched before a play/pause/seek and open a new one.

        The room's state has already changed, so where playback *was* is
        reconstructed: the last position seen plus the time since, if it was
        playing then. When the new position is far from that, a seek
        happened, and the old range ends where playback left off rather than
        where it landed.
        """
        expected = session.last_position
        if session.was_playing_at_last_look:
            expected += self._now() - session.last_seen_at
        position = self._position(state)
        if abs(position - expected) > YOUTUBE_HISTORY_SEEK_THRESHOLD_SECONDS:
            await self._report_range(session, expected, then_start_at=position)
        else:
            await self._report_range(session, position)

    async def _report_range(self, session: HistorySession, position: Optional[float],
                            then_start_at: Optional[float] = None) -> None:
        """Send the watch-time ping for [range_start, position] and reset the range."""
        if position is None:
            return
        state = self._manager.room_states.get(session.room_id) or {}
        range_start = session.range_start
        # Bookkeeping before the await, so a cancelled ping is not repeated.
        new_start = position if then_start_at is None else then_start_at
        session.range_start = session.last_position = new_start
        session.last_seen_at = self._now()
        session.was_playing_at_last_look = bool(state.get("is_playing"))
        if position - range_start >= YOUTUBE_HISTORY_MIN_RANGE_SECONDS:
            await self._ping(session, session.urls.watchtime, position,
                             watched_from=range_start, watched_to=position)

    async def _ping(self, session: HistorySession, base_url: str, position: float,
                    watched_from: Optional[float] = None, watched_to: Optional[float] = None) -> None:
        url = build_ping_url(base_url, cpn=session.cpn, position=position,
                             watched_from=watched_from, watched_to=watched_to)
        cookie_header = get_cookie_header(session.user_email, url)
        if not cookie_header:
            logger.info("History: cookies for %s no longer usable; stopping", session.user_email)
            self._sessions.pop((session.room_id, session.user_email), None)
            raise asyncio.CancelledError
        try:
            response = await self._http().get(url, headers={"Cookie": cookie_header})
        except httpx.HTTPError as exc:
            logger.warning("History: ping failed for %s: %s", session.user_email, exc)
            return
        if response.status_code >= 400:
            logger.warning("History: YouTube answered %s for %s; stopping this video",
                           response.status_code, session.user_email)
            self._sessions.pop((session.room_id, session.user_email), None)
            raise asyncio.CancelledError
        logger.debug("History: %s at %.1fs (%s)", session.user_email, position,
                     "watchtime" if watched_from is not None else "playback")


from connection_manager import manager  # noqa: E402  (the singleton lives there)

reporter = HistoryReporter(manager)
