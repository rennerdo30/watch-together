"""
DASH manifest generation for adaptive streams.

yt-dlp returns adaptive video and audio as separate fragmented-MP4 files
with no manifest, which is why the player historically drove a <video>
and an <audio> element side by side and corrected the drift between them
in JavaScript. Two media elements cannot be kept frame-accurate by
design.

Describing the same files in a DASH manifest lets one media element play
both tracks through Media Source Extensions, so the browser muxes them
against a single clock and the drift problem disappears. The byte ranges
each representation needs come from scanning the head of each file.
"""
import asyncio
import logging
import re
import time
from xml.sax.saxutils import escape, quoteattr
from typing import Dict, List, Optional, Sequence, Tuple
from urllib.parse import quote

import httpx

from services.cache import stream_identity, memory_cache, get_segment_cache_key, is_audio_url
from services.gvs_range import rewrite_range
from services import startup_timing, stream_owner
from services.mp4_index import Mp4Index, SegmentTable, parse_index, parse_segment_table, index_span
from services.upstream import open_upstream_stream, UnsafeUpstreamError
from core.config import (
    MANIFEST_PROBE_BYTES,
    MANIFEST_MAX_INDEX_BYTES,
    MANIFEST_INDEX_CACHE_TTL_SECONDS,
    MANIFEST_INDEX_CACHE_MAX_ENTRIES,
    MANIFEST_MIN_BANDWIDTH,
    MANIFEST_MAX_VIDEO_REPRESENTATIONS,
    MANIFEST_MAX_AUDIO_REPRESENTATIONS,
)

logger = logging.getLogger(__name__)

# Cache of probed byte ranges. Keyed by the URL's cache-stable identity
# so re-resolving the same video does not re-probe every representation.
_index_cache: Dict[str, Tuple[Mp4Index, float]] = {}
# The same probe also describes where each subsegment starts in time, which
# is what lets a jump be warmed at the right byte offset. Kept beside the
# index and dropped with it.
_segment_tables: Dict[str, SegmentTable] = {}
_index_lock = asyncio.Lock()
# One probe in flight per representation: a room full of members asking for
# the same manifest at once otherwise probes every rendition once each.
_probe_locks: Dict[str, asyncio.Lock] = {}
_probe_users: Dict[str, int] = {}


_CONTENT_RANGE = re.compile(r"bytes (\d+)-(\d+)/(\d+|\*)")


class ManifestError(Exception):
    """Raised when a manifest cannot be produced."""


async def _prune_index_cache(now: float) -> None:
    """Drop expired entries, then the oldest if still oversized."""
    expired = [
        key for key, (_index, cached_at) in _index_cache.items()
        if now - cached_at > MANIFEST_INDEX_CACHE_TTL_SECONDS
    ]
    for key in expired:
        del _index_cache[key]
        _segment_tables.pop(key, None)

    while len(_index_cache) > MANIFEST_INDEX_CACHE_MAX_ENTRIES:
        oldest = min(_index_cache, key=lambda k: _index_cache[k][1])
        del _index_cache[oldest]
        _segment_tables.pop(oldest, None)


async def probe_index(
    client: httpx.AsyncClient,
    url: str,
    headers: Optional[dict] = None,
    speculative: bool = False,
) -> Optional[Mp4Index]:
    """Find the init and index byte ranges for one representation.

    `speculative` says nobody is waiting for this: the probe is warming a
    video the room has not reached. A rendition that cannot be read is then
    a fact for a debug line, not a warning — a warning per rendition of a
    fetch nobody asked for buries the failures that did affect someone.
    """
    key = stream_identity(url)
    probe_lock = _probe_locks.setdefault(key, asyncio.Lock())
    _probe_users[key] = _probe_users.get(key, 0) + 1
    try:
        async with probe_lock:
            return await _probe_index_locked(client, url, headers, key, speculative)
    finally:
        _probe_users[key] -= 1
        if _probe_users[key] == 0:
            del _probe_users[key]
            _probe_locks.pop(key, None)


async def _probe_index_locked(
    client: httpx.AsyncClient,
    url: str,
    headers: Optional[dict],
    key: str,
    speculative: bool = False,
) -> Optional[Mp4Index]:
    now = time.time()
    report = logger.debug if speculative else logger.warning

    async with _index_lock:
        cached = _index_cache.get(key)
        if cached and (now - cached[1]) <= MANIFEST_INDEX_CACHE_TTL_SECONDS:
            return cached[0]

    async def read_prefix(length: int) -> Optional[bytes]:
        request_headers = dict(headers or {})
        # googlevideo serves a `range=` query at full speed and a Range
        # header through its throttled path (see services/gvs_range); the
        # probe is on the critical path of every start, so it takes the
        # fast one wherever it applies.
        fast = rewrite_range(url, 0, length - 1)
        if not fast:
            request_headers["Range"] = f"bytes=0-{length - 1}"
        try:
            response, _pinned = await open_upstream_stream(
                client, fast.url if fast else url, request_headers)
            try:
                body = await response.aread()
            finally:
                await response.aclose()
        except UnsafeUpstreamError:
            raise
        except Exception as exc:
            report(f"Could not probe {url[:80]}: {exc}")
            return None

        if response.status_code not in (200, 206):
            report(f"Probe of {url[:80]} returned {response.status_code}")
            return None
        content_range = (f"bytes 0-{len(body) - 1}/{fast.total}"
                         if fast and response.status_code == 200 and body
                         else response.headers.get("content-range"))
        await _keep_prefix(url, body, content_range,
                           response.headers.get("content-type", "video/mp4"),
                           request_headers.get("Cookie"))
        return body

    data = await read_prefix(MANIFEST_PROBE_BYTES)
    if data is None:
        return None

    index = parse_index(data)
    if index is None:
        # A `sidx` too large for the first probe is the normal case for a
        # long VOD, not a broken rendition. Its header states the exact
        # size, so ask for precisely that rather than dropping the
        # rendition — dropping every video one leaves an audio-only
        # manifest that a player waits on forever.
        needed = index_span(data)
        if needed and MANIFEST_PROBE_BYTES < needed <= MANIFEST_MAX_INDEX_BYTES:
            logger.info(
                f"Segment index needs {needed} bytes, re-probing {url[:60]}...")
            data = await read_prefix(needed)
            index = parse_index(data) if data is not None else None
        elif needed and needed > MANIFEST_MAX_INDEX_BYTES:
            report(
                f"Segment index of {needed} bytes exceeds the {MANIFEST_MAX_INDEX_BYTES} "
                f"byte ceiling for {url[:60]}...")

    if index is None:
        report(f"No fragmented-MP4 index found in {url[:80]}")
        return None

    table = parse_segment_table(data, index)
    if table is None:
        logger.debug("No subsegment table read from %s...", url[:60])

    async with _index_lock:
        _index_cache[key] = (index, now)
        if table is not None:
            _segment_tables[key] = table
        await _prune_index_cache(now)

    return index


async def _keep_prefix(url: str, body: bytes, content_range: Optional[str],
                       content_type: str, cookie: Optional[str]) -> None:
    """Keep the probed head of a rendition where the player will ask for it.

    The first thing a player fetches from a rendition is its init segment
    and then its index — both inside the bytes this probe just read. Kept in
    the memory cache under the stream's fetch identity, those requests are
    answered without another trip to the CDN.

    Only kept when the probe was made exactly as the proxy would fetch the
    URL: bytes fetched with one member's cookies must never be filed where
    another's request would find them.
    """
    match = _CONTENT_RANGE.fullmatch(content_range or "")
    if not match or int(match[1]) != 0 or int(match[2]) != len(body) - 1:
        return
    fetcher = stream_owner.fetcher_for(url)
    if fetcher.cookie != cookie:
        return
    await memory_cache.put(get_segment_cache_key(url, 0, len(body) - 1, fetcher.cache_identity),
                           body, content_type, is_audio=is_audio_url(url),
                           content_range=content_range)


def clear_index_cache() -> None:
    """Forget every probed range (used by tests)."""
    _index_cache.clear()
    _segment_tables.clear()


def segment_table_for(url: str) -> Optional[SegmentTable]:
    """Where each subsegment of this rendition starts, if it has been probed.

    Returns None for a rendition nobody has built a manifest for yet, and
    for one whose index could not be read. Both mean the same thing to a
    caller: this stream cannot be warmed at a position, only from the
    beginning.
    """
    return _segment_tables.get(stream_identity(url))


def _duration_attr(seconds: float) -> str:
    """Format a duration as an ISO-8601 period, as DASH requires."""
    return f"PT{max(float(seconds), 0.0):.3f}S"


def _proxied(url: str, proxy_base: str) -> str:
    return f"{proxy_base}{quote(url, safe='')}"


def _bandwidth(fmt: dict, fallback: int) -> int:
    """Bits per second for a representation, from whatever field exists."""
    tbr = fmt.get("tbr") or fmt.get("vbr") or fmt.get("abr")
    if tbr:
        return max(int(float(tbr) * 1000), MANIFEST_MIN_BANDWIDTH)
    return fallback


def _codec_family(codec: str) -> str:
    """The interchangeable-codec group a representation belongs to.

    'avc1.640028' and 'avc1.4d401f' are the same decoder; 'av01...' is not.
    """
    return (codec or "").split(".", 1)[0].lower()


def _group_by_codec(reps: List[dict], codec_field: str) -> List[Tuple[str, List[dict]]]:
    """Split representations into one group per codec family.

    A DASH AdaptationSet promises its representations are mutually
    interchangeable, and a player backs one with a single MSE SourceBuffer
    created for a single codec. Mixing H.264 and AV1 in one set makes the
    player append one codec's segments into the other's buffer, which plays
    for a fraction of a second and then freezes on a stale frame.

    Insertion order is preserved so the caller's quality ordering survives.
    """
    groups: Dict[str, List[dict]] = {}
    for rep in reps:
        groups.setdefault(_codec_family(rep.get(codec_field)), []).append(rep)
    return list(groups.items())


def build_mpd(
    duration_seconds: float,
    video_reps: List[dict],
    audio_reps: List[dict],
    proxy_base: str,
) -> str:
    """Render a static DASH manifest for the given representations.

    Each representation dict needs `url`, `index` (an Mp4Index) and the
    codec metadata for its media type.
    """
    if not video_reps and not audio_reps:
        raise ManifestError("No playable representations")

    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" '
        'profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" '
        'type="static" '
        f'mediaPresentationDuration="{_duration_attr(duration_seconds)}" '
        f'minBufferTime="PT2S">',
        f'  <Period duration="{_duration_attr(duration_seconds)}">',
    ]

    for _family, family_reps in _group_by_codec(video_reps, "vcodec"):
        lines.append(
            '    <AdaptationSet contentType="video" mimeType="video/mp4" '
            'segmentAlignment="true" startWithSAP="1" subsegmentAlignment="true" '
            'subsegmentStartsWithSAP="1">'
        )
        for rep in family_reps:
            index: Mp4Index = rep["index"]
            attrs = [
                f'id={quoteattr(str(rep["id"]))}',
                f'bandwidth="{_bandwidth(rep, 500_000)}"',
                f'codecs={quoteattr(rep.get("vcodec") or "avc1.4d401f")}',
            ]
            if rep.get("width"):
                attrs.append(f'width="{int(rep["width"])}"')
            if rep.get("height"):
                attrs.append(f'height="{int(rep["height"])}"')
            if rep.get("fps"):
                attrs.append(f'frameRate="{int(round(float(rep["fps"])))}"')
            lines.append(f'      <Representation {" ".join(attrs)}>')
            lines.append(f'        <BaseURL>{escape(_proxied(rep["url"], proxy_base))}</BaseURL>')
            lines.append(f'        <SegmentBase indexRange="{index.index_range}" indexRangeExact="true">')
            lines.append(f'          <Initialization range="{index.init_range}"/>')
            lines.append('        </SegmentBase>')
            lines.append('      </Representation>')
        lines.append('    </AdaptationSet>')

    for _family, family_reps in _group_by_codec(audio_reps, "acodec"):
        lines.append(
            '    <AdaptationSet contentType="audio" mimeType="audio/mp4" '
            'segmentAlignment="true" startWithSAP="1" subsegmentAlignment="true" '
            'subsegmentStartsWithSAP="1">'
        )
        for rep in family_reps:
            index = rep["index"]
            attrs = [
                f'id={quoteattr(str(rep["id"]))}',
                f'bandwidth="{_bandwidth(rep, 128_000)}"',
                f'codecs={quoteattr(rep.get("acodec") or "mp4a.40.2")}',
                f'audioSamplingRate="{int(rep.get("asr") or 44100)}"',
            ]
            lines.append(f'      <Representation {" ".join(attrs)}>')
            lines.append(
                '        <AudioChannelConfiguration '
                'schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" '
                f'value="{int(rep.get("audio_channels") or 2)}"/>'
            )
            lines.append(f'        <BaseURL>{escape(_proxied(rep["url"], proxy_base))}</BaseURL>')
            lines.append(f'        <SegmentBase indexRange="{index.index_range}" indexRangeExact="true">')
            lines.append(f'          <Initialization range="{index.init_range}"/>')
            lines.append('        </SegmentBase>')
            lines.append('      </Representation>')
        lines.append('    </AdaptationSet>')

    lines.append('  </Period>')
    lines.append('</MPD>')
    return "\n".join(lines)


def manifest_formats(cached: dict) -> Tuple[List[dict], List[dict]]:
    """Turn a resolve response into the representations a manifest describes.

    One reading of the resolve shape, used both when a player asks for the
    manifest and when a queued video is prepared ahead of time — so the
    ladder prepared is the ladder served.
    """
    video_formats = [
        {
            "id": quality.get("format_id") or f"v{position}",
            "url": quality.get("video_url"),
            "width": quality.get("width"),
            "height": quality.get("height"),
            "vcodec": quality.get("vcodec"),
            "tbr": quality.get("tbr"),
            "fps": quality.get("fps"),
        }
        for position, quality in enumerate(
            (cached.get("available_qualities") or [])[:MANIFEST_MAX_VIDEO_REPRESENTATIONS]
        )
    ]
    audio_formats = [
        {
            "id": option.get("format_id") or f"a{position}",
            "url": option.get("audio_url"),
            "acodec": option.get("acodec"),
            "abr": option.get("abr"),
            "asr": option.get("asr"),
            "audio_channels": option.get("audio_channels"),
        }
        for position, option in enumerate(
            (cached.get("audio_options") or [])[:MANIFEST_MAX_AUDIO_REPRESENTATIONS]
        )
    ]
    return video_formats, audio_formats


async def probe_formats(
    client: httpx.AsyncClient,
    formats: Sequence[dict],
    headers: Optional[dict] = None,
) -> int:
    """Probe representations without rendering anything, and say how many held.

    Building the manifest for a video the room has not reached yet is
    pointless — the XML would be thrown away — but the probes behind it are
    not: they are what the advance would otherwise wait on, and they fill
    the subsegment tables a later skip is warmed from.

    Nobody is waiting on any of it, so every probe here is speculative and
    reports what it could not read at debug level.
    """
    results = await asyncio.gather(*[
        probe_index(client, fmt["url"], headers, speculative=True)
        for fmt in formats if fmt.get("url")
    ], return_exceptions=True)
    return sum(1 for result in results if isinstance(result, Mp4Index))


async def build_manifest_for_formats(
    client: httpx.AsyncClient,
    duration_seconds: float,
    video_formats: List[dict],
    audio_formats: List[dict],
    proxy_base: str,
    headers: Optional[dict] = None,
    source_url: str = "",
) -> str:
    """Probe every candidate representation and render the manifest.

    Representations that cannot be probed are dropped rather than
    failing the whole manifest, so one bad rendition does not break
    playback. `source_url` names the video in the timing record.
    """
    started = time.monotonic()
    async def prepare(fmt: dict, kind: str) -> Optional[dict]:
        url = fmt.get("url")
        if not url:
            return None
        index = await probe_index(client, url, headers)
        if index is None:
            logger.info(f"Skipping {kind} representation {fmt.get('id')}: no index")
            return None
        return {**fmt, "index": index}

    video_results, audio_results = await asyncio.gather(
        asyncio.gather(*[prepare(f, "video") for f in video_formats]),
        asyncio.gather(*[prepare(f, "audio") for f in audio_formats]),
    )

    video_reps = [r for r in video_results if r]
    audio_reps = [r for r in audio_results if r]
    startup_timing.record_manifest(
        source_url, (time.monotonic() - started) * 1000,
        video=len(video_reps), video_total=len(video_formats),
        audio=len(audio_reps), audio_total=len(audio_formats))
    lost = (len(video_formats) - len(video_reps)) + (len(audio_formats) - len(audio_reps))
    if lost:
        # Visible as "quality selection does nothing": the ladder shrank.
        logger.warning(
            f"Manifest built with {len(video_reps)}/{len(video_formats)} video and "
            f"{len(audio_reps)}/{len(audio_formats)} audio representations; "
            f"{lost} could not be probed")

    # Losing every representation of one kind is a failure, not a manifest.
    # Audio segments are longer than video ones, so a long VOD's audio index
    # is about half the size of its video index — for roughly 8 to 15 hours of
    # content the audio probe succeeded while every video probe failed, and
    # the result was an audio-only manifest that a player buffers on forever
    # waiting for a video track nobody declared.
    if video_formats and not video_reps:
        raise ManifestError("No video representation could be probed")
    if audio_formats and not audio_reps:
        raise ManifestError("No audio representation could be probed")
    if not video_reps and not audio_reps:
        raise ManifestError("No representation could be probed")

    return build_mpd(duration_seconds, video_reps, audio_reps, proxy_base)
