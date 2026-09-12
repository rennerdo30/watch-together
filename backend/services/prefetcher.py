"""
Prefetching service for video segments.

Parses HLS playlists and warms DASH byte ranges in the background
to reduce buffering during playback.
"""
import asyncio
import logging
import re
import time
from typing import Dict, Set, Optional, List
from urllib.parse import urljoin, urlparse

import httpx

from services.cache import memory_cache, get_segment_cache_key, is_audio_url, mark_content_active
from services.upstream import open_upstream_stream
from services import stream_owner, user_cookies
from services.gvs_range import rewrite_range
from core.config import (
    PREFETCH_VIDEO_COUNT,
    PREFETCH_AUDIO_COUNT,
    PREFETCH_SESSION_TTL, DEFAULT_USER_AGENT,
)

logger = logging.getLogger(__name__)

# Track active prefetch sessions per URL
_prefetch_sessions: Dict[str, 'PrefetchSession'] = {}
_session_lock = asyncio.Lock()


class PrefetchSession:
    """
    Manages prefetching for a single video stream at a specific quality.

    Each quality URL gets its own session. When User A watches 1080p and
    User B watches 720p, both get prefetching for their respective quality.
    """

    def __init__(self, manifest_url: str, is_audio: bool = False, identity: Optional[str] = None):
        self.manifest_url = manifest_url
        self.is_audio = is_audio
        self.identity = identity
        self.segment_urls: List[str] = []
        self.last_requested_index: int = -1
        self.prefetch_count: int = PREFETCH_AUDIO_COUNT if is_audio else PREFETCH_VIDEO_COUNT
        self.prefetched: Set[str] = set()
        self.last_activity = time.time()
        self._task: Optional[asyncio.Task] = None
        self._client: Optional[httpx.AsyncClient] = None

    async def parse_hls_manifest(self, content: str, base_url: str):
        """Extract segment URLs from HLS manifest."""
        # Variant playlists and byte-range playlists are not standalone
        # segment URLs; warming them as complete media gives unusable bytes.
        if '#EXT-X-STREAM-INF' in content or '#EXT-X-BYTERANGE' in content:
            self.segment_urls = []
            return
        segments = []
        for line in content.split('\n'):
            line = line.strip()
            # Skip empty lines and comments
            if not line or line.startswith('#'):
                continue
            # This is a segment URL
            full_url = line if line.startswith('http') else urljoin(base_url, line)
            segments.append(full_url)

        self.segment_urls = segments
        if segments:
            logger.info(f"Parsed HLS manifest: {len(segments)} segments for {self.manifest_url[:60]}...")

    def notify_segment_requested(self, url: str):
        """
        Called when a segment is requested by a client.
        Triggers prefetch of next segments if applicable.
        """
        self.last_activity = time.time()

        # Try to find this segment in our list
        try:
            idx = self.segment_urls.index(url)
            self.last_requested_index = idx
        except ValueError:
            # URL not in our segment list, might be a different format
            return

        # Trigger prefetch of next segments
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._prefetch_next())

    async def _prefetch_next(self):
        """Prefetch next N segments after the last requested one."""
        start_idx = self.last_requested_index + 1
        end_idx = min(start_idx + self.prefetch_count, len(self.segment_urls))

        if start_idx >= len(self.segment_urls):
            return

        # Create client if needed
        if self._client is None:
            # Redirects are followed by open_upstream_stream so each hop
            # is validated; the client must not follow them itself.
            self._client = httpx.AsyncClient(
                follow_redirects=False,
                timeout=httpx.Timeout(30.0),
                limits=httpx.Limits(max_connections=5)
            )

        async def fetch_segment(url: str) -> None:
            owner = stream_owner.owner_of(url) if stream_owner.is_known(url) else self.identity
            cookie = user_cookies.get_cookie_header(owner, url) if owner else None
            cache_key = get_segment_cache_key(url, 0, None, owner if cookie else None)

            # Check if already in memory cache
            if await memory_cache.get(cache_key):
                self.prefetched.add(url)
                return

            try:
                # Prefetch targets come from manifests, which a user can point
                # anywhere, so they get the same validation as proxied fetches.
                parsed = urlparse(self.manifest_url)
                headers = {"User-Agent": DEFAULT_USER_AGENT,
                           "Referer": f"{parsed.scheme}://{parsed.netloc}/",
                           "Accept-Encoding": "identity"}
                if cookie:
                    headers['Cookie'] = cookie
                async with _prefetch_slots:
                    resp, _pinned = await open_upstream_stream(self._client, url, headers)
                    try:
                        if resp.status_code != 200 or resp.headers.get("content-encoding", "identity") != "identity":
                            return
                        chunks = []
                        size = 0
                        async for chunk in resp.aiter_raw():
                            size += len(chunk)
                            if size > 24 * 1024 * 1024:
                                return
                            chunks.append(chunk)
                        body = b''.join(chunks)
                        if resp.headers.get('content-length') and len(body) != int(resp.headers['content-length']):
                            return
                    finally:
                        await resp.aclose()

                if resp.status_code in (200, 206):
                    content_type = resp.headers.get("content-type", "video/mp4")
                    await memory_cache.put(
                        cache_key,
                        body,
                        content_type,
                        is_audio=self.is_audio,
                        content_range=resp.headers.get("content-range"),
                    )
                    self.prefetched.add(url)

                    # Mark content as active for adaptive TTL
                    url_hash = cache_key.split('_')[1] if '_' in cache_key else None
                    if url_hash:
                        await mark_content_active(url_hash)

            except Exception as e:
                logger.debug(f"Segment prefetch failed: {e}")

        await asyncio.gather(*(fetch_segment(url) for url in self.segment_urls[start_idx:end_idx]))

    async def cleanup(self):
        """Clean up resources."""
        if self._task and not self._task.done():
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
        if self._client:
            await self._client.aclose()
            self._client = None


async def get_or_create_session(manifest_url: str, is_audio: bool = False, identity: Optional[str] = None) -> PrefetchSession:
    """Get existing or create new prefetch session for a manifest URL."""
    key = get_segment_cache_key(manifest_url, identity=identity)
    async with _session_lock:
        if key not in _prefetch_sessions:
            _prefetch_sessions[key] = PrefetchSession(manifest_url, is_audio, identity)
            logger.info(f"Created prefetch session for: {manifest_url[:60]}...")
        session = _prefetch_sessions[key]
        session.last_activity = time.time()
        return session


async def notify_segment_for_url(segment_url: str, identity: Optional[str] = None):
    """
    Notify all relevant prefetch sessions about a segment request.
    Used when we can't directly identify the manifest URL.
    """
    async with _session_lock:
        for session in _prefetch_sessions.values():
            if session.identity == identity and segment_url in session.segment_urls:
                session.notify_segment_requested(segment_url)
                break


# Speculation is bounded across rooms; demand requests never acquire this slot.
_prefetch_slots = asyncio.Semaphore(3)
_read_ahead_tasks: Dict[str, asyncio.Task] = {}
_initial_tasks: Dict[tuple, asyncio.Task] = {}


async def prefetch_bytes(client: httpx.AsyncClient, url: str, start: int, end: int,
                         is_audio: bool = False, identity: Optional[str] = None) -> None:
    """Warm reusable bytes using the same session and fast range path as demand."""
    owner = stream_owner.owner_of(url) if stream_owner.is_known(url) else identity
    cookie = user_cookies.get_cookie_header(owner, url) if owner else None
    cache_identity = owner if cookie else None
    fast_range = rewrite_range(url, start, end)
    if fast_range:
        start, end = fast_range.start, fast_range.end
    if await memory_cache.get_range(url, start, end, cache_identity):
        return
    headers = {"Accept-Encoding": "identity", "User-Agent": DEFAULT_USER_AGENT,
               "Referer": "https://www.youtube.com/" if fast_range else f"{urlparse(url).scheme}://{urlparse(url).netloc}/"}
    if cookie:
        headers["Cookie"] = cookie
    if not fast_range:
        headers["Range"] = f"bytes={start}-{end}"
    try:
        async with _prefetch_slots:
            resp, _ = await open_upstream_stream(client, fast_range.url if fast_range else url, headers)
            try:
                if resp.status_code not in (200, 206) or resp.headers.get("content-encoding", "identity") != "identity":
                    return
                chunks = []
                size = 0
                async for chunk in resp.aiter_raw():
                    size += len(chunk)
                    if size > end - start + 1:
                        return  # An origin ignoring Range must not download the whole video.
                    chunks.append(chunk)
                body = b''.join(chunks)
            finally:
                await resp.aclose()
        crange = fast_range.content_range if fast_range and resp.status_code == 200 else resp.headers.get("content-range")
        match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+|\*)', crange or '')
        if not match or int(match[1]) != start or len(body) != int(match[2]) - start + 1:
            return
        await memory_cache.put(get_segment_cache_key(url, start, end, cache_identity), body,
                               resp.headers.get('content-type', 'video/mp4'),
                               is_audio=is_audio, content_range=crange)
    except Exception as exc:
        logger.debug("Prefetch failed: %s", exc)


def prefetch_ahead(client: httpx.AsyncClient, url: str, end: Optional[int],
                   identity: Optional[str] = None) -> None:
    """Warm the current and following 3 MB blocks, one task per stream."""
    # Init/index probes are not playback positions. Warming on those starts
    # speculative downloads for every rendition the manifest examines.
    if end is None or end < 64 * 1024:
        return
    block_size = 3 * 1024 * 1024
    start = (end // block_size) * block_size
    span = rewrite_range(url, start, start + block_size - 1)
    if not span:
        return
    key = get_segment_cache_key(url, 0, None, identity)
    if key in _read_ahead_tasks or len(_read_ahead_tasks) >= 12:
        return
    async def warm() -> None:
        # Align speculation to reusable blocks; otherwise every tiny player
        # request downloads an almost identical 3 MB window again.
        await prefetch_bytes(client, url, span.start, span.end,
                             is_audio=is_audio_url(url), identity=identity)
        following = rewrite_range(url, span.end + 1, span.end + block_size)
        if following:
            await prefetch_bytes(client, url, following.start, following.end,
                                 is_audio=is_audio_url(url), identity=identity)

    task = asyncio.create_task(warm())
    _read_ahead_tasks[key] = task
    task.add_done_callback(lambda _: _read_ahead_tasks.pop(key, None))


def start_initial_prefetch(video_url: Optional[str], audio_url: Optional[str],
                           client: httpx.AsyncClient) -> None:
    """Deduplicate and bound queued-video warmups without delaying queue updates."""
    key = (video_url, audio_url)
    if key in _initial_tasks or len(_initial_tasks) >= 8:
        return
    task = asyncio.create_task(prefetch_initial_segments(video_url, audio_url, client))
    _initial_tasks[key] = task
    task.add_done_callback(lambda _: _initial_tasks.pop(key, None))


async def shutdown_prefetch() -> None:
    """Drain speculative fetches before closing their HTTP client."""
    tasks = list(_read_ahead_tasks.values()) + list(_initial_tasks.values())
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    for session in list(_prefetch_sessions.values()):
        await session.cleanup()
    _prefetch_sessions.clear()


async def prefetch_initial_segments(
    video_url: Optional[str],
    audio_url: Optional[str],
    client: httpx.AsyncClient
) -> None:
    """
    Prefetch initial segments of a new video for faster startup.

    Called when a new video is set in a room. Fetches the first few
    segments in parallel to minimize initial buffering.
    """
    tasks = []

    async def prefetch_range(url: str, start: int, length: int, is_audio: bool):
        await prefetch_bytes(client, url, start, start + length - 1, is_audio=is_audio)

    # For direct URLs (not manifests), prefetch initial bytes
    if video_url and not urlparse(video_url).path.endswith(('.m3u8', '.m3u', '.mpd')):
        # Prefetch first 3MB of video
        tasks.append(prefetch_range(video_url, 0, 3 * 1024 * 1024, is_audio=False))

    if audio_url and not urlparse(audio_url).path.endswith(('.m3u8', '.m3u', '.mpd')):
        # Prefetch first 1MB of audio (audio is more critical)
        tasks.append(prefetch_range(audio_url, 0, 1 * 1024 * 1024, is_audio=True))

    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
        logger.info(f"Initial prefetch complete for {len(tasks)} streams")


async def cleanup_stale_sessions():
    """Remove sessions inactive for longer than PREFETCH_SESSION_TTL."""
    async with _session_lock:
        now = time.time()
        stale = [
            url for url, session in _prefetch_sessions.items()
            if now - session.last_activity > PREFETCH_SESSION_TTL
        ]
        for url in stale:
            session = _prefetch_sessions.pop(url)
            try:
                await session.cleanup()
            except Exception as e:
                logger.error(f"Failed to cleanup prefetch session {url[:60]}: {e}")
        if stale:
            logger.info(f"Cleaned up {len(stale)} stale prefetch sessions")


async def prefetch_cleanup_task():
    """Background task to periodically clean up stale prefetch sessions."""
    while True:
        await asyncio.sleep(60)  # Run every minute
        try:
            await cleanup_stale_sessions()
        except Exception as e:
            logger.error(f"Error in prefetch cleanup task: {e}")


def get_prefetch_stats() -> dict:
    """Get statistics about active prefetch sessions."""
    return {
        "active_sessions": len(_prefetch_sessions),
        "sessions": [
            {
                "url": url[:60] + "...",
                "segments": len(session.segment_urls),
                "prefetched": len(session.prefetched),
                "last_index": session.last_requested_index,
                "is_audio": session.is_audio,
            }
            for url, session in _prefetch_sessions.items()
        ]
    }
