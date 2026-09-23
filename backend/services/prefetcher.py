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
from services import inflight, stream_owner
from services.gvs_range import rewrite_range
from services.manifest import segment_table_for
from core.config import (
    PREFETCH_VIDEO_COUNT,
    PREFETCH_AUDIO_COUNT,
    PREFETCH_SESSION_TTL, DEFAULT_USER_AGENT,
    PREFETCH_AHEAD_VIDEO_SUBSEGMENTS, PREFETCH_AHEAD_AUDIO_SUBSEGMENTS,
    PREFETCH_READ_AHEAD_CONCURRENCY, PREWARM_CONCURRENCY, PREFETCH_MAX_PENDING_SPANS,
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
            fetcher = stream_owner.fetcher_for(url, self.identity)
            cookie = fetcher.cookie
            cache_key = get_segment_cache_key(url, 0, None, fetcher.cache_identity)

            # Check if already in memory cache (not counted: this is not a viewer)
            if memory_cache.contains(cache_key):
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
                async with _read_ahead_slots:
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


# Speculation is bounded; demand requests never wait for a slot. Warming a
# room's jump and reading ahead of a viewer draw from separate pools, so one
# room's read-ahead cannot hold back another room's opening bytes.
_read_ahead_slots = asyncio.Semaphore(PREFETCH_READ_AHEAD_CONCURRENCY)
_warm_slots = asyncio.Semaphore(PREWARM_CONCURRENCY)
# One task per exact span being warmed.
_span_tasks: Dict[str, asyncio.Task] = {}


async def prefetch_bytes(client: httpx.AsyncClient, url: str, start: int, end: int,
                         is_audio: bool = False, identity: Optional[str] = None,
                         read_ahead: bool = False) -> None:
    """Fetch one exact span into the memory cache, as a viewer's request would.

    The span is cached under the key the proxy looks up for a request of
    precisely these bytes, fetched as the same identity, through the same
    fast googlevideo range path. Nothing is fetched that is already cached
    or already being fetched by anyone.
    """
    fetcher = stream_owner.fetcher_for(url, identity)
    fast_range = rewrite_range(url, start, end)
    if fast_range:
        start, end = fast_range.start, fast_range.end
    key = get_segment_cache_key(url, start, end, fetcher.cache_identity)

    def already_there() -> bool:
        return (memory_cache.contains(key)
                or inflight.is_fetching(url, start, end, fetcher.cache_identity))

    if already_there():
        return
    headers = {"Accept-Encoding": "identity", "User-Agent": DEFAULT_USER_AGENT,
               "Referer": "https://www.youtube.com/" if fast_range else f"{urlparse(url).scheme}://{urlparse(url).netloc}/"}
    if fetcher.cookie:
        headers["Cookie"] = fetcher.cookie
    if not fast_range:
        headers["Range"] = f"bytes={start}-{end}"
    try:
        async with (_read_ahead_slots if read_ahead else _warm_slots):
            # The wait for a slot can be long enough for a viewer to have
            # fetched these bytes themselves.
            if already_there():
                return
            with inflight.fetching(url, start, end, fetcher.cache_identity):
                resp, _ = await open_upstream_stream(client, fast_range.url if fast_range else url, headers)
                try:
                    if resp.status_code not in (200, 206) or resp.headers.get("content-encoding", "identity") != "identity":
                        logger.debug("Prefetch of %s answered %s", url[:60], resp.status_code)
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
                await memory_cache.put(key, body, resp.headers.get('content-type', 'video/mp4'),
                                       is_audio=is_audio, content_range=crange)
    except Exception as exc:
        logger.debug("Prefetch failed: %s", exc)


def warm_span(client: httpx.AsyncClient, url: str, start: int, end: int,
              identity: Optional[str] = None, read_ahead: bool = False) -> None:
    """Warm one exact span in the background; one task per span, bounded."""
    key = get_segment_cache_key(url, start, end, identity)
    if key in _span_tasks:
        return
    if len(_span_tasks) >= PREFETCH_MAX_PENDING_SPANS:
        logger.debug("Span warm skipped, %d pending", len(_span_tasks))
        return
    task = asyncio.create_task(prefetch_bytes(client, url, start, end, is_audio=is_audio_url(url),
                                              identity=identity, read_ahead=read_ahead))
    _span_tasks[key] = task
    task.add_done_callback(lambda _: _span_tasks.pop(key, None))


def prefetch_ahead(client: httpx.AsyncClient, url: str, start: int,
                   identity: Optional[str] = None) -> None:
    """Warm the subsegments after the one a viewer just asked for.

    The spans come from the rendition's own index, so each warm is exactly
    the request the player makes next and is answered from memory verbatim.
    A rendition whose index nobody has read is left alone rather than
    guessed at: a guessed block rarely contains a whole subsegment, and one
    that does not answers nothing.
    """
    table = segment_table_for(url)
    if table is None:
        return
    position = table.index_of_offset(start)
    if position is None:
        # Init segment or index: a probe, not a playback position.
        return
    ahead = PREFETCH_AHEAD_AUDIO_SUBSEGMENTS if is_audio_url(url) else PREFETCH_AHEAD_VIDEO_SUBSEGMENTS
    for following in range(position + 1, position + 1 + ahead):
        span = table.span(following)
        if span is None:
            break
        warm_span(client, url, span[0], span[1], identity, read_ahead=True)


async def shutdown_prefetch() -> None:
    """Drain speculative fetches before closing their HTTP client."""
    tasks = list(_span_tasks.values())
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    for session in list(_prefetch_sessions.values()):
        await session.cleanup()
    _prefetch_sessions.clear()


async def drain_span_warms() -> None:
    """Let in-flight span warms finish (tests)."""
    while _span_tasks:
        await asyncio.gather(*list(_span_tasks.values()), return_exceptions=True)


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
