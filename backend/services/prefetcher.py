"""
Prefetching service for video segments.

Parses HLS/DASH manifests and prefetches upcoming segments in the background
to reduce buffering during playback.
"""
import asyncio
import logging
import re
import time
from typing import Dict, Set, Optional, List
from urllib.parse import urljoin

import httpx

from services.cache import memory_cache, get_segment_cache_key, is_audio_url, mark_content_active
from core.config import (
    PREFETCH_VIDEO_COUNT,
    PREFETCH_AUDIO_COUNT,
    PREFETCH_SESSION_TTL,
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

    def __init__(self, manifest_url: str, is_audio: bool = False):
        self.manifest_url = manifest_url
        self.is_audio = is_audio
        self.segment_urls: List[str] = []
        self.last_requested_index: int = -1
        self.prefetch_count: int = PREFETCH_AUDIO_COUNT if is_audio else PREFETCH_VIDEO_COUNT
        self.prefetched: Set[str] = set()
        self.last_activity = time.time()
        self._task: Optional[asyncio.Task] = None
        self._client: Optional[httpx.AsyncClient] = None

    async def parse_hls_manifest(self, content: str, base_url: str):
        """Extract segment URLs from HLS manifest."""
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

    async def parse_dash_segments(self, base_url: str, template: str, start_num: int, count: int):
        """
        Generate segment URLs from DASH SegmentTemplate.

        Args:
            base_url: Base URL for resolving relative paths
            template: Template string with $Number$ placeholder
            start_num: Starting segment number
            count: Number of segments to generate
        """
        segments = []
        for i in range(start_num, start_num + count):
            # Replace $Number$ with actual number (may be zero-padded)
            url = re.sub(r'\$Number\$', str(i), template)
            # Also handle $Number%0Nd$ format for zero-padding
            url = re.sub(r'\$Number%0(\d+)d\$', lambda m: str(i).zfill(int(m.group(1))), url)
            full_url = url if url.startswith('http') else urljoin(base_url, url)
            segments.append(full_url)

        self.segment_urls = segments
        if segments:
            logger.info(f"Generated DASH segments: {len(segments)} URLs from template")

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
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(30.0),
                limits=httpx.Limits(max_connections=5)
            )

        for idx in range(start_idx, end_idx):
            url = self.segment_urls[idx]
            if url in self.prefetched:
                continue

            cache_key = get_segment_cache_key(url, 0)

            # Check if already in memory cache
            if await memory_cache.get(cache_key):
                self.prefetched.add(url)
                continue

            try:
                logger.info(f"PREFETCH: segment {idx} - {url[:60]}...")
                resp = await self._client.get(url, headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    "Referer": "https://www.youtube.com/"
                })

                if resp.status_code in (200, 206):
                    content_type = resp.headers.get("content-type", "video/mp4")
                    await memory_cache.put(
                        cache_key,
                        resp.content,
                        content_type,
                        is_audio=self.is_audio
                    )
                    self.prefetched.add(url)
                    logger.info(f"PREFETCH OK: segment {idx} ({len(resp.content)} bytes)")

                    # Mark content as active for adaptive TTL
                    url_hash = cache_key.split('_')[1] if '_' in cache_key else None
                    if url_hash:
                        await mark_content_active(url_hash)

            except Exception as e:
                logger.warning(f"Prefetch failed for segment {idx}: {e}")

    async def cleanup(self):
        """Clean up resources."""
        if self._client:
            await self._client.aclose()
            self._client = None
        if self._task and not self._task.done():
            self._task.cancel()


async def get_or_create_session(manifest_url: str, is_audio: bool = False) -> PrefetchSession:
    """Get existing or create new prefetch session for a manifest URL."""
    async with _session_lock:
        if manifest_url not in _prefetch_sessions:
            _prefetch_sessions[manifest_url] = PrefetchSession(manifest_url, is_audio)
            logger.info(f"Created prefetch session for: {manifest_url[:60]}...")
        session = _prefetch_sessions[manifest_url]
        session.last_activity = time.time()
        return session


async def notify_segment_for_url(segment_url: str):
    """
    Notify all relevant prefetch sessions about a segment request.
    Used when we can't directly identify the manifest URL.
    """
    async with _session_lock:
        for session in _prefetch_sessions.values():
            if segment_url in session.segment_urls:
                session.notify_segment_requested(segment_url)
                break


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
        """Prefetch a specific byte range into cache."""
        try:
            resp = await client.get(url, headers={
                "Range": f"bytes={start}-{start + length - 1}",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Referer": "https://www.youtube.com/"
            })
            if resp.status_code in (200, 206):
                cache_key = get_segment_cache_key(url, start)
                content_type = resp.headers.get("content-type", "video/mp4")
                await memory_cache.put(cache_key, resp.content, content_type, is_audio=is_audio)
                logger.info(f"Initial prefetch OK: {len(resp.content)} bytes from {url[:60]}...")

                # Mark content as active
                url_hash = cache_key.split('_')[1] if '_' in cache_key else None
                if url_hash:
                    await mark_content_active(url_hash)
        except Exception as e:
            logger.warning(f"Initial prefetch failed: {e}")

    # For direct URLs (not manifests), prefetch initial bytes
    if video_url and not video_url.endswith(('.m3u8', '.mpd')):
        # Prefetch first 3MB of video
        tasks.append(prefetch_range(video_url, 0, 3 * 1024 * 1024, is_audio=False))

    if audio_url and not audio_url.endswith(('.m3u8', '.mpd')):
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
            await session.cleanup()
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
