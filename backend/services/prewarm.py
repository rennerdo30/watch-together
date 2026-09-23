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
* A **start or jump a viewer is about to make** — a video loading, a pointer
  resting on the seek bar, a queue row about to be clicked — which the
  player announces through `/api/prewarm`.

What makes all of these possible is the subsegment table read from each
rendition's `sidx` during the manifest probe: it turns a playback position
into the exact byte span a player will request for it. A warm fetches those
spans verbatim, so the player's request is answered from memory; a span that
merely overlaps would answer nothing.

Which rendition to warm is the other half. A start is warmed on the rung the
viewer's player will open on (it says, via `h`), and the next video on the
rungs the room is watching now — never on whichever rendition yt-dlp called
best, which the players' quality cap rarely allows.

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
    PREWARM_CODEC_PREFERENCE,
    PREWARM_DEFAULT_HEIGHT,
    PREWARM_FAILURE_LIMIT,
    PREWARM_MAX_AUDIO_RENDITIONS,
    PREWARM_MAX_TASKS,
    PREWARM_MAX_VIDEO_RENDITIONS,
    PREWARM_POSITION_SUBSEGMENTS,
    PREWARM_RETRY_AFTER_SECONDS,
)
from services import manifest as manifest_service
from services.cache import is_audio_url
from services.prefetcher import prefetch_bytes

#: A rung to warm: a picture height, and the codec family it is wanted in
#: (None: whichever family a player would pick, see PREWARM_CODEC_PREFERENCE).
Rung = Tuple[int, Optional[str]]

logger = logging.getLogger(__name__)

#: Probes a queued video's renditions and returns the source to warm: the
#: resolve it probed, which may be a fresher one than the queue entry
#: carries, or that entry as it stands when there is no ladder to probe.
#: None means these URLs do not answer, which ends the warm and backs off.
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

# When preparing a video last came to nothing, per room and video. The
# heartbeat that asks is five seconds apart and the window it asks in is
# PREWARM_NEXT_VIDEO_SECONDS long, so a video that cannot be prepared —
# stream URLs the CDN no longer serves, an extraction that fails — would
# otherwise be attempted nine times per advance, each attempt a yt-dlp run
# or a full ladder of refusals. One attempt, then silence.
#
# The room is part of the key because it is part of the answer: a re-resolve
# borrows the cookies of a member connected to *that* room, so the same
# video can be unpreparable in one room and perfectly warmable in the next.
_failed_videos: "OrderedDict[Tuple[str, str], float]" = OrderedDict()


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

    Renditions someone is actually fetching; with no such evidence, the ones
    a player would open on. Bounded, because warming a whole ladder to serve
    one viewer multiplies the cost by the number of rungs.
    """
    now = time.monotonic()
    chosen = choose_renditions(video_data, playing_rungs(video_data))
    audio = [option.get("audio_url") for option in (video_data.get("audio_options") or [])
             if isinstance(option.get("audio_url"), str)]
    active_audio = [url for url in audio if _is_active(url, now)][:PREWARM_MAX_AUDIO_RENDITIONS]
    if active_audio:
        chosen = [url for url in chosen if url not in audio] + active_audio
    return chosen


def codec_family(codec: Optional[str]) -> str:
    """'avc1.640028' -> 'avc1': the decoder a rendition needs."""
    return (codec or "").split(".", 1)[0].lower()


def playing_rungs(video_data: dict) -> List[Rung]:
    """The rungs of this video someone is fetching right now."""
    now = time.monotonic()
    rungs: List[Rung] = []
    for quality in video_data.get("available_qualities") or []:
        url = quality.get("video_url")
        height = quality.get("height")
        if isinstance(url, str) and isinstance(height, int) and _is_active(url, now):
            rung = (height, codec_family(quality.get("vcodec")) or None)
            if rung not in rungs:
                rungs.append(rung)
    return rungs[:PREWARM_MAX_VIDEO_RENDITIONS]


def choose_renditions(video_data: dict, rungs: Sequence[Rung]) -> List[str]:
    """The stream URLs a player wanting `rungs` would fetch from this video.

    For each rung: within its codec family (or the family a player prefers,
    among those the ladder offers), the tallest rendition no taller than
    asked for — which is what a height cap leaves a player — or the
    shortest when all are taller. Plus the audio a player opens with.
    """
    qualities = [q for q in (video_data.get("available_qualities") or [])
                 if isinstance(q.get("video_url"), str) and isinstance(q.get("height"), int)]
    chosen: List[str] = []
    families = {codec_family(q.get("vcodec")) for q in qualities}
    preferred = next((family for family in PREWARM_CODEC_PREFERENCE if family in families), None)
    for height, family in (list(rungs) or [(PREWARM_DEFAULT_HEIGHT, None)])[:PREWARM_MAX_VIDEO_RENDITIONS]:
        wanted = family if family in families else preferred
        candidates = [q for q in qualities if wanted is None or codec_family(q.get("vcodec")) == wanted]
        if not candidates:
            continue
        fitting = [q for q in candidates if q["height"] <= height]
        pick = (max(fitting, key=lambda q: (q["height"], q.get("tbr") or 0)) if fitting
                else min(candidates, key=lambda q: q["height"]))
        if pick["video_url"] not in chosen:
            chosen.append(pick["video_url"])
    audio = [o.get("audio_url") for o in (video_data.get("audio_options") or [])
             if isinstance(o.get("audio_url"), str)]
    chosen.extend(audio[:PREWARM_MAX_AUDIO_RENDITIONS])
    return chosen


async def _warm_position(client: httpx.AsyncClient, urls: Sequence[str],
                         seconds: float, identity: Optional[str]) -> None:
    warmed = 0
    for url in urls:
        table = manifest_service.segment_table_for(url)
        if table is None:
            # Nothing has probed this rendition yet, so where its subsegments
            # lie is unknown. Guessing is worse than not warming: a guessed
            # span downloads megabytes and answers no request.
            continue
        first = table.index_at(seconds)
        if first is None:
            continue
        for position in range(first, first + PREWARM_POSITION_SUBSEGMENTS):
            span = table.span(position)
            if span is None:
                break
            await prefetch_bytes(client, url, span[0], span[1],
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


def _recently_failed(key: Tuple[str, str]) -> bool:
    last = _failed_videos.get(key)
    return last is not None and time.monotonic() - last <= PREWARM_RETRY_AFTER_SECONDS


def _note_failure(key: Tuple[str, str]) -> None:
    _failed_videos[key] = time.monotonic()
    _failed_videos.move_to_end(key)
    while len(_failed_videos) > PREWARM_FAILURE_LIMIT:
        _failed_videos.popitem(last=False)


async def _warm_video(client: httpx.AsyncClient, video_data: dict,
                      prepare: Optional[PrepareVideo], key: Tuple[str, str],
                      rungs: Sequence[Rung], seconds: float) -> None:
    # The indexes first: probing every rendition is what building the
    # manifest would otherwise wait on, and it is what yields the subsegment
    # tables the opening bytes are warmed from. `prepare` hands back the
    # source to warm — a fresher resolve than the queue entry carries, or the
    # entry itself when there is no ladder to probe — or nothing at all,
    # meaning these URLs do not answer. Fetching bytes in that case would
    # spend the same doomed requests one layer down, so the warm ends and
    # the video is left alone until the backoff runs out.
    source = video_data
    if prepare is not None:
        try:
            source = await prepare(video_data)
        except Exception as exc:  # Speculation must never raise into a room.
            logger.debug("Prewarm preparation failed: %s", exc)
            source = None
        if not source:
            _note_failure(key)
            return
    urls = choose_renditions(source, rungs)
    if urls:
        await _warm_position(client, urls, seconds, source.get("resolved_by"))
        logger.info("Prewarmed the start of %s", str(source.get("title") or "")[:60])


def warm_video(client: httpx.AsyncClient, video_data: dict,
               prepare: Optional[PrepareVideo] = None, room_id: str = "", *,
               rungs: Sequence[Rung] = (), seconds: float = 0.0) -> None:
    """Prepare a video and warm the bytes its start will ask for.

    `rungs` are the renditions whose start is warmed (see
    `choose_renditions`); `seconds` is where the video starts, which for a
    queue entry being resumed is not the beginning.

    `room_id` scopes the backoff, because whether this video can be prepared
    is a fact about the room and not about the video: a re-resolve borrows
    the cookies of a member connected *there*. One room with nobody signed
    in must not silence the warm for every other room.
    """
    url = video_data.get("original_url") if isinstance(video_data, dict) else None
    if not url:
        return
    key = (room_id, url)
    if _recently_failed(key):
        logger.debug("Not preparing %s for %s again yet: the last attempt came to nothing",
                     url, room_id or "no room")
        return
    rung_key = ",".join(f"{h}{f or ''}" for h, f in rungs)
    _spawn(f"video:{room_id}:{url[:160]}:{rung_key}:{int(seconds)}",
           _warm_video(client, video_data, prepare, key, rungs, seconds))


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


def forget_failures() -> None:
    """Drop the backoff on videos that could not be prepared (tests)."""
    _failed_videos.clear()


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
