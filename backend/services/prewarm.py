"""
Warming the bytes the room is about to need.

Playback is only smooth while the next bytes are already somewhere close.
Two moments break that, and both are known in advance:

* A **SponsorBlock skip** moves everyone to a position nobody has buffered.
  The skip is scheduled, so its destination can be fetched while the
  sponsor is still playing.
* The **next queue entry** starts from nothing: its manifest has not been
  built (which means probing every rendition), and no byte of it has been
  fetched. Both can happen while the current video finishes.

What makes the first possible is the subsegment table read from each
rendition's `sidx` during the manifest probe: it turns a playback position
into the byte offset serving it, so a jump is warmed at the right place
rather than at the file's average bitrate.

Everything here is speculative. It is bounded, deduplicated, never awaited
by a request, and failures are logged at debug level and forgotten.
"""
import asyncio
import logging
import time
from collections import OrderedDict
from typing import Awaitable, Callable, Dict, List, Optional, Sequence, Tuple

import httpx

from core.config import (
    ACTIVE_STREAM_LIMIT,
    ACTIVE_STREAM_TTL_SECONDS,
    PREWARM_AUDIO_BYTES,
    PREWARM_MAX_AUDIO_RENDITIONS,
    PREWARM_MAX_TASKS,
    PREWARM_MAX_VIDEO_RENDITIONS,
    PREWARM_VIDEO_BYTES,
)
from services import manifest as manifest_service
from services.cache import is_audio_url
from services.prefetcher import prefetch_bytes, start_initial_prefetch

logger = logging.getLogger(__name__)

#: Probes a queued video's renditions and returns the resolve it used, which
#: may be a fresher one than the queue entry carries.
PrepareVideo = Callable[[dict], Awaitable[Optional[dict]]]

# One task per thing being warmed; a second request for the same thing joins
# nothing and starts nothing.
_tasks: Dict[str, asyncio.Task] = {}

# When each stream URL was last asked for through the proxy. Which rendition
# a viewer is on is their player's decision, made from a ladder the server
# never hears the outcome of — so warming `video_url` from the resolve would
# warm whichever rendition yt-dlp called best, while the room watches
# another. What every viewer does pass through here is their segment
# requests, and that is the answer: warm what is being played.
_active_streams: "OrderedDict[str, float]" = OrderedDict()


def _spawn(key: str, coroutine: Awaitable[None]) -> None:
    """Run a warm in the background, at most one per key and never too many."""
    if key in _tasks:
        coroutine.close()
        return
    if len(_tasks) >= PREWARM_MAX_TASKS:
        logger.debug("Prewarm skipped, %d already in flight: %s", len(_tasks), key)
        coroutine.close()
        return
    task = asyncio.create_task(coroutine)
    _tasks[key] = task
    task.add_done_callback(lambda _: _tasks.pop(key, None))


def note_active_stream(url: str) -> None:
    """Remember that someone just asked for bytes of this stream."""
    if not url:
        return
    _active_streams[url] = time.monotonic()
    _active_streams.move_to_end(url)
    while len(_active_streams) > ACTIVE_STREAM_LIMIT:
        _active_streams.popitem(last=False)


def _is_active(url: str, now: float) -> bool:
    last = _active_streams.get(url)
    return last is not None and now - last <= ACTIVE_STREAM_TTL_SECONDS


def stream_urls(video_data: dict) -> List[str]:
    """The streams worth warming for the video a room is playing.

    Preference goes to renditions someone is actually fetching; the resolve
    response's own choice is the fallback for a video nobody has played yet.
    Bounded, because warming a whole ladder to serve one viewer multiplies
    the cost by the number of rungs.
    """
    now = time.monotonic()
    chosen: List[str] = []

    def take(candidates: Sequence[Optional[str]], limit: int) -> None:
        urls = [url for url in candidates if isinstance(url, str) and url]
        active = [url for url in urls if _is_active(url, now)]
        for url in (active or urls[:1])[:limit]:
            if url not in chosen:
                chosen.append(url)

    take([quality.get("video_url") for quality in (video_data.get("available_qualities") or [])]
         + [video_data.get("video_url")], PREWARM_MAX_VIDEO_RENDITIONS)
    take([option.get("audio_url") for option in (video_data.get("audio_options") or [])]
         + [video_data.get("audio_url")], PREWARM_MAX_AUDIO_RENDITIONS)
    return chosen


def _span_for(url: str) -> int:
    return PREWARM_AUDIO_BYTES if is_audio_url(url) else PREWARM_VIDEO_BYTES


async def _warm_position(client: httpx.AsyncClient, urls: Sequence[str],
                         seconds: float, identity: Optional[str]) -> None:
    warmed = 0
    for url in urls:
        table = manifest_service.segment_table_for(url)
        if table is None:
            # Nothing has built a manifest for this rendition yet, so where
            # its subsegments begin is unknown. Guessing from the average
            # bitrate is worse than not warming: it downloads megabytes of
            # the wrong part of the file.
            continue
        offset = table.offset_at(seconds)
        if offset is None:
            continue
        await prefetch_bytes(client, url, offset, offset + _span_for(url) - 1,
                             is_audio=is_audio_url(url), identity=identity)
        warmed += 1
    if warmed:
        logger.info("Prewarmed %d stream(s) at %.1fs", warmed, seconds)


def warm_position(client: httpx.AsyncClient, video_data: dict, seconds: float,
                  identity: Optional[str] = None) -> None:
    """Warm the bytes serving `seconds` of the video the room is playing."""
    urls = stream_urls(video_data or {})
    if not urls or seconds < 0:
        return
    _spawn(f"position:{urls[0][:120]}:{int(seconds)}",
           _warm_position(client, urls, seconds, identity))


async def _warm_video(client: httpx.AsyncClient, video_data: dict,
                      prepare: Optional[PrepareVideo]) -> None:
    # The indexes first: probing every rendition is what the advance would
    # otherwise wait on, and it is what fills the subsegment tables, so a
    # skip inside the next video can be warmed as well. `prepare` hands back
    # the resolve it probed, which may be fresher than the queue entry —
    # signed stream URLs rotate, and warming an expired one warms nothing.
    source = video_data
    if prepare is not None:
        try:
            prepared = await prepare(video_data)
            if prepared:
                source = prepared
        except Exception as exc:  # Speculation must never raise into a room.
            logger.debug("Prewarm preparation failed: %s", exc)
    if stream_urls(source):
        start_initial_prefetch(source.get("video_url"), source.get("audio_url"), client)
        logger.info("Prewarmed the next video: %s", str(source.get("title") or "")[:60])


def warm_video(client: httpx.AsyncClient, video_data: dict,
               prepare: Optional[PrepareVideo] = None) -> None:
    """Prepare a queued video: probe its renditions, warm its opening bytes."""
    key = video_data.get("original_url") if isinstance(video_data, dict) else None
    if not key:
        return
    _spawn(f"video:{key[:160]}", _warm_video(client, video_data, prepare))


async def drain() -> None:
    """Let in-flight warms finish (tests, and shutdown)."""
    for task in list(_tasks.values()):
        try:
            await task
        except asyncio.CancelledError:
            pass


def forget_active_streams() -> None:
    """Drop what is known about who is playing what (tests)."""
    _active_streams.clear()


async def shutdown() -> None:
    """Cancel speculation before the HTTP client it uses goes away."""
    tasks = list(_tasks.values())
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    _tasks.clear()


def in_flight() -> Tuple[str, ...]:
    """Keys of the warms currently running (diagnostics and tests)."""
    return tuple(_tasks)
