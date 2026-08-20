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
import time
from xml.sax.saxutils import escape, quoteattr
from typing import Dict, List, Optional, Tuple
from urllib.parse import quote, urlparse, parse_qs

import httpx

from services.mp4_index import Mp4Index, parse_index
from services.upstream import open_upstream_stream, UnsafeUpstreamError
from core.config import (
    MANIFEST_PROBE_BYTES,
    MANIFEST_INDEX_CACHE_TTL_SECONDS,
    MANIFEST_INDEX_CACHE_MAX_ENTRIES,
    MANIFEST_MIN_BANDWIDTH,
)

logger = logging.getLogger(__name__)

# Cache of probed byte ranges. Keyed by the URL's cache-stable identity
# so re-resolving the same video does not re-probe every representation.
_index_cache: Dict[str, Tuple[Mp4Index, float]] = {}
_index_lock = asyncio.Lock()


class ManifestError(Exception):
    """Raised when a manifest cannot be produced."""


# Query parameters that identify *which* rendition a URL addresses, as
# opposed to the signing parameters that rotate on every resolution.
_STREAM_IDENTITY_PARAMS = ("itag", "clen", "lmt", "mime")


def _cache_key(url: str) -> str:
    """Identity of one rendition, ignoring the parts that rotate.

    Signed CDN URLs carry expiry and token parameters that change between
    resolutions while addressing the same bytes, so they cannot be part of
    the key. The path alone is not enough either: every YouTube rendition
    lives at /videoplayback and is told apart only by its query, so keying
    on the path made every representation of a video — including the audio
    one — share a single entry. Each then inherited the first one's byte
    ranges, and the player found no sidx box where the manifest promised
    one.

    The host is deliberately excluded: the same rendition served from a
    different edge is byte-identical, so its ranges still apply.
    """
    parsed = urlparse(url)
    params = parse_qs(parsed.query)
    identity = [
        f"{name}={params[name][0]}"
        for name in _STREAM_IDENTITY_PARAMS
        if params.get(name)
    ]
    if not identity:
        # Nothing stable to key on. Correctness beats cache hits.
        return url
    return f"{parsed.path}?{'&'.join(identity)}"


async def _prune_index_cache(now: float) -> None:
    """Drop expired entries, then the oldest if still oversized."""
    expired = [
        key for key, (_index, cached_at) in _index_cache.items()
        if now - cached_at > MANIFEST_INDEX_CACHE_TTL_SECONDS
    ]
    for key in expired:
        del _index_cache[key]

    while len(_index_cache) > MANIFEST_INDEX_CACHE_MAX_ENTRIES:
        oldest = min(_index_cache, key=lambda k: _index_cache[k][1])
        del _index_cache[oldest]


async def probe_index(
    client: httpx.AsyncClient,
    url: str,
    headers: Optional[dict] = None,
) -> Optional[Mp4Index]:
    """Find the init and index byte ranges for one representation."""
    key = _cache_key(url)
    now = time.time()

    async with _index_lock:
        cached = _index_cache.get(key)
        if cached and (now - cached[1]) <= MANIFEST_INDEX_CACHE_TTL_SECONDS:
            return cached[0]

    request_headers = dict(headers or {})
    request_headers["Range"] = f"bytes=0-{MANIFEST_PROBE_BYTES - 1}"

    try:
        response, _pinned = await open_upstream_stream(client, url, request_headers)
        try:
            data = await response.aread()
        finally:
            await response.aclose()
    except UnsafeUpstreamError:
        raise
    except Exception as exc:
        logger.warning(f"Could not probe {url[:80]}: {exc}")
        return None

    if response.status_code not in (200, 206):
        logger.warning(f"Probe of {url[:80]} returned {response.status_code}")
        return None

    index = parse_index(data)
    if index is None:
        logger.warning(f"No fragmented-MP4 index found in {url[:80]}")
        return None

    async with _index_lock:
        _index_cache[key] = (index, now)
        await _prune_index_cache(now)

    return index


def clear_index_cache() -> None:
    """Forget every probed range (used by tests)."""
    _index_cache.clear()


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

    if video_reps:
        lines.append(
            '    <AdaptationSet contentType="video" mimeType="video/mp4" '
            'segmentAlignment="true" startWithSAP="1" subsegmentAlignment="true" '
            'subsegmentStartsWithSAP="1">'
        )
        for rep in video_reps:
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

    if audio_reps:
        lines.append(
            '    <AdaptationSet contentType="audio" mimeType="audio/mp4" '
            'segmentAlignment="true" startWithSAP="1" subsegmentAlignment="true" '
            'subsegmentStartsWithSAP="1">'
        )
        for rep in audio_reps:
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


async def build_manifest_for_formats(
    client: httpx.AsyncClient,
    duration_seconds: float,
    video_formats: List[dict],
    audio_formats: List[dict],
    proxy_base: str,
    headers: Optional[dict] = None,
) -> str:
    """Probe every candidate representation and render the manifest.

    Representations that cannot be probed are dropped rather than
    failing the whole manifest, so one bad rendition does not break
    playback.
    """
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

    if not video_reps and not audio_reps:
        raise ManifestError("No representation could be probed")

    return build_mpd(duration_seconds, video_reps, audio_reps, proxy_base)
