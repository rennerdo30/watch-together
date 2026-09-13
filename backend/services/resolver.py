"""
Video URL resolution service using yt-dlp.
"""
import os
import asyncio
import logging
from typing import Iterable, Optional
from urllib.parse import urlparse, parse_qs
import yt_dlp

from core.config import (
    DEFAULT_USER_AGENT, POT_PROVIDER_EXTRACTOR_ARGS,
    QUALITY_LADDER_SIZE, STORYBOARD_PREFERRED_FRAME_WIDTH, YTDLP_CACHE_DIR,
)
from services.database import cache_format, get_cached_format
from services.stream_owner import RESOLVED_BY_KEY, remember as remember_stream_owner
from services.user_cookies import choose_cookie_source, cookie_file

logger = logging.getLogger(__name__)


def build_ydl_opts(cookie_path: Optional[str], user_agent: Optional[str] = None,
                   cache_dir: str = YTDLP_CACHE_DIR) -> dict:
    """yt-dlp options for a metadata-only extraction.

    Shared by the resolver and the watch-history capture, so both present
    the same browser identity and both reach the PO token provider: without
    it the extractor gets storyboards only.
    """
    opts = {
        'format': 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        'quiet': True,
        'no_warnings': True,
        'nocheckcertificate': True,
        'logger': logger,
        'skip_download': True,
        'noplaylist': True,
        'cache_dir': cache_dir,
        'http_headers': {
            'User-Agent': user_agent or DEFAULT_USER_AGENT,
            'Accept-Language': 'en-US,en;q=0.9',
        },
        'extractor_args': dict(POT_PROVIDER_EXTRACTOR_ARGS),
    }
    if cookie_path:
        opts['cookiefile'] = cookie_path
    return opts


def _select_quality_ladder(video_only_formats, per_codec_limit: int):
    """Build a complete quality ladder for each codec family.

    Two constraints shape this. The list arrives sorted by height
    descending, so slicing off the front keeps only the largest renditions
    and leaves a viewer on a slow link nothing to fall back to. And a player
    commits to a single codec family for the session — mixing them inside one
    adaptation set is not something MSE can switch across — so a budget
    spread across codecs leaves holes in whichever one gets chosen.

    Spreading ten slots over AV1 and H.264 previously gave AV1 only 2160p and
    1440p; a player that picked AV1 then had nothing lower to drop to. Each
    family therefore gets its own ladder, trimmed from the middle outwards so
    the extremes survive.
    """
    families = {}
    for height, fmt in video_only_formats:
        family = (fmt.get('vcodec') or '').split('.', 1)[0].lower()
        rungs = families.setdefault(family, {})
        # One rendition per height; the list is height-ordered so the first
        # seen is the preferred one.
        if height not in rungs:
            rungs[height] = fmt

    selected = []
    for family, rungs in families.items():
        ladder = [(h, rungs[h]) for h in sorted(rungs, reverse=True)]
        if len(ladder) > per_codec_limit:
            kept = [ladder[0], ladder[-1]]
            middle = ladder[1:-1]
            if middle and per_codec_limit > 2:
                step = max(1, round(len(middle) / (per_codec_limit - 2)))
                kept.extend(middle[::step][: per_codec_limit - 2])
            ladder = kept
        selected.extend(ladder)

    return sorted(selected, key=lambda item: item[0] or 0, reverse=True)


# Containers whose segment index the manifest generator cannot read. A DASH
# manifest describes each rendition by a byte range into its `sidx` box, which
# exists only in fragmented MP4 — Matroska (WebM) keys its segments in a Cues
# element this project does not index. Offering such a rendition means probing
# it, failing, and dropping it, so it is excluded before the ladder is built.
#
# Only positively-identified containers are excluded. An unknown container is
# left in: the probe is authoritative, and guessing "not indexable" would drop
# renditions from sources that simply do not label themselves.
_UNINDEXABLE_EXTENSIONS = ("webm", "mkv")
_UNINDEXABLE_MIME = ("video/webm", "audio/webm", "video/x-matroska")


def extract_storyboard(info: dict) -> Optional[dict]:
    """The preview-thumbnail storyboard nearest the preferred frame width.

    yt-dlp describes each storyboard as a format with `rows`, `columns`, a
    frame size, and one fragment per sheet (`url` + `duration`). All sheets
    of one storyboard share the frame duration, so a single number is kept.
    """
    candidates = []
    for fmt in info.get('formats') or []:
        if fmt.get('format_note') != 'storyboard':
            continue
        fragments = fmt.get('fragments') or []
        width, height = fmt.get('width'), fmt.get('height')
        rows, columns = fmt.get('rows'), fmt.get('columns')
        if not (fragments and width and height and rows and columns):
            continue
        frames = rows * columns
        first = fragments[0]
        frame_duration = (first.get('duration') or 0) / frames
        if frame_duration <= 0:
            continue
        candidates.append((abs(width - STORYBOARD_PREFERRED_FRAME_WIDTH), {
            'width': int(width),
            'height': int(height),
            'rows': int(rows),
            'columns': int(columns),
            'frame_duration': round(frame_duration, 4),
            'sheets': [f['url'] for f in fragments if f.get('url')],
        }))
    if not candidates:
        return None
    candidates.sort(key=lambda c: c[0])
    return candidates[0][1]


def _is_indexable(fmt: dict) -> bool:
    """Whether a SegmentBase manifest could describe this rendition."""
    extension = (fmt.get("ext") or "").lower()
    if extension:
        return extension not in _UNINDEXABLE_EXTENSIONS

    # No extension recorded; googlevideo states the container in the URL.
    mime = parse_qs(urlparse(fmt.get("url") or "").query).get("mime")
    if mime:
        return mime[0].lower() not in _UNINDEXABLE_MIME
    return True


def _extract_stream_url(info: dict, prefer_dash: bool = True) -> dict:
    """
    Extract the best stream URL from yt-dlp info dict.

    If prefer_dash=True and HD video-only formats exist, returns separate video+audio URLs
    for DASH playback. Otherwise returns combined format.
    """
    formats = info.get('formats', [])

    logger.info(f"Video: {info.get('title', 'Unknown')} - Found {len(formats)} formats")
    
    # Log all formats for debugging
    for i, f in enumerate(formats):
        logger.info(f"Format [{i}]: id={f.get('format_id')} res={f.get('height')}p note={f.get('format_note')} ext={f.get('ext')} vcodec={f.get('vcodec')} acodec={f.get('acodec')}")


    # Categorize formats
    hls_formats = []
    combined_formats = []  # Has both video and audio
    video_only_formats = []
    audio_only_formats = []

    for f in formats:
        url = f.get('url') or ''
        manifest_url = f.get('manifest_url') or ''
        has_video = f.get('vcodec') not in (None, 'none')
        has_audio = f.get('acodec') not in (None, 'none')
        height = f.get('height') or 0
        abr = f.get('abr') or 0

        if '.m3u8' in manifest_url or '.m3u8' in url:
            if has_video:
                hls_formats.append((height, f))
        elif has_video and has_audio and url:
            combined_formats.append((height, f))
        elif has_video and url:
            # Only fragmented MP4 can carry a SegmentBase index, and these
            # two lists feed the DASH manifest.
            if _is_indexable(f):
                video_only_formats.append((height, f))
        elif has_audio and url and not has_video:
            if _is_indexable(f):
                audio_only_formats.append((abr, f))

    # Sort by quality descending
    hls_formats.sort(key=lambda x: x[0], reverse=True)
    combined_formats.sort(key=lambda x: x[0], reverse=True)
    video_only_formats.sort(key=lambda x: x[0], reverse=True)
    audio_only_formats.sort(key=lambda x: x[0], reverse=True)

    logger.info(f"  HLS: {len(hls_formats)}, Combined: {len(combined_formats)}, Video-only: {len(video_only_formats)}, Audio-only: {len(audio_only_formats)}")

    # 1. PREFER DASH for HD quality with manual quality selection
    if prefer_dash and video_only_formats and audio_only_formats:
        best_video = video_only_formats[0][1]
        best_audio = audio_only_formats[0][1]

        if best_video.get('height', 0) > 0:
            logger.info(f"Selected DASH: video={best_video.get('format_id')} @ {best_video.get('height')}p + audio={best_audio.get('format_id')} @ {best_audio.get('abr')}kbps")
            return {
                'url': best_video.get('url'),
                'video_url': best_video.get('url'),
                'audio_url': best_audio.get('url'),
                'format_id': f"{best_video.get('format_id')}+{best_audio.get('format_id')}",
                'height': best_video.get('height'),
                'width': best_video.get('width'),
                'vcodec': best_video.get('vcodec'),
                'acodec': best_audio.get('acodec'),
                'has_audio': True,
                'type': 'dash',
                'available_qualities': [
                    {
                        'height': v[1].get('height'),
                        'width': v[1].get('width'),
                        'video_url': v[1].get('url'),
                        'format_id': v[1].get('format_id'),
                        'vcodec': v[1].get('vcodec'),
                        'tbr': v[1].get('tbr'),
                    }
                    for v in _select_quality_ladder(
                        video_only_formats, QUALITY_LADDER_SIZE)
                ],
                'audio_options': [
                    {
                        'abr': a[1].get('abr'),
                        'audio_url': a[1].get('url'),
                        'format_id': a[1].get('format_id'),
                        'acodec': a[1].get('acodec'),
                    }
                    for a in audio_only_formats[:3]
                ]
            }

    # 2. HLS manifest
    if hls_formats:
        f = hls_formats[0][1]
        stream_url = f.get('manifest_url') or f.get('url')
        logger.info(f"Selected HLS manifest: {f.get('format_id')} @ {f.get('height')}p")
        return {
            'url': stream_url,
            'format_id': f.get('format_id'),
            'height': f.get('height'),
            'has_audio': True,
            'type': 'hls'
        }

    # 3. Fallback: Best combined format
    if combined_formats:
        f = combined_formats[0][1]
        stream_url = f.get('url')
        logger.info(f"Selected combined format: {f.get('format_id')} @ {f.get('height')}p")
        return {
            'url': stream_url,
            'format_id': f.get('format_id'),
            'height': f.get('height'),
            'has_audio': True,
            'type': 'combined'
        }

    # 4. Video-only as last resort
    if video_only_formats:
        f = video_only_formats[0][1]
        stream_url = f.get('url')
        logger.info(f"WARNING: Selected video-only format (no audio): {f.get('format_id')} @ {f.get('height')}p")
        return {
            'url': stream_url,
            'format_id': f.get('format_id'),
            'height': f.get('height'),
            'has_audio': False,
            'type': 'video_only'
        }

    # 5. Default url
    stream_url = info.get('url')
    if stream_url:
        logger.info("Using default URL from info")
        return {'url': stream_url, 'format_id': 'default', 'height': None, 'has_audio': True, 'type': 'default'}

    return None


def _build_resolve_response(url: str, info: dict, stream_info: dict) -> dict:
    """Shape a resolved video for the client."""
    response = {
        "original_url": url,
        "webpage_url": info.get("webpage_url"),
        "extractor_key": info.get("extractor_key"),
        "stream_url": stream_info["url"],
        "title": info.get("title", "Unknown Title"),
        "is_live": info.get("is_live", False),
        "thumbnail": info.get("thumbnail"),
        "backend_engine": "yt-dlp",
        "duration": info.get("duration"),
        "quality": f"{stream_info.get('height', '?')}p" if stream_info.get("height") else "auto",
        "has_audio": stream_info.get("has_audio", True),
        "stream_type": stream_info.get("type", "unknown"),
    }
    storyboard = extract_storyboard(info)
    if storyboard:
        response["storyboard"] = storyboard

    if stream_info.get("type") == "dash":
        response["video_url"] = stream_info.get("video_url")
        response["audio_url"] = stream_info.get("audio_url")
        response["available_qualities"] = stream_info.get("available_qualities", [])
        response["audio_options"] = stream_info.get("audio_options", [])

    return response


async def refresh_video_url(video_data: dict, user_agent: str = None, user_email: str = None,
                            members: Iterable[str] = ()) -> dict:
    """
    Re-resolves the stream URL using a multi-strategy fallback system to beat age restrictions.

    `members` are the room's connected identities: whoever added the video
    is tried first, then any member signed in to the video's site, so a
    queue entry still plays when the person who queued it has left.
    """
    if not video_data or not video_data.get("original_url"):
        return video_data

    original_url = video_data["original_url"]
    added_by = video_data.get("added_by")

    # 1. Check memory cache first
    cached = await get_cached_format(original_url)
    if cached:
        room_fields = {key: video_data[key] for key in ('original_url', 'added_by', 'pinned', 'progress') if key in video_data}
        video_data.clear()
        video_data.update(cached)
        video_data.update(room_fields)
        remember_stream_owner(video_data)
        return video_data

    logger.info(f"Refreshing stream URL for: {original_url} (User: {user_email}, Added by: {added_by})")

    # 2. Resolve Cookies (requester -> adder -> any room member signed in to the site -> anonymous)
    candidates = [added_by] if isinstance(added_by, str) else []
    candidates.extend(members)
    cookie_owner = choose_cookie_source(original_url, user_email, candidates)

    # The cookie file exists only while the strategies run.
    async with cookie_file(cookie_owner) as cookie_path:
        # 3. Define strategies.
        #
        # These vary only the cookie source. They used to pin YouTube player
        # clients (web, mweb, tv_embedded, ios, tv) and try them in turn, but
        # every one of those lists now returns storyboard images and no media:
        # YouTube requires per-client tokens that a pinned list does not carry.
        # yt-dlp keeps its own default client selection current, which resolves
        # the same videos at full quality, so the choice is left to it.
        strategies = [
            {
                "name": "requester_cookies" if cookie_path else "anonymous",
                "desc": "Default clients, with whatever cookies were found",
                "cookiefile": cookie_path,
                "owner": cookie_owner,
            },
        ]

        # Retrying without cookies is worth it: an expired or wrong-account
        # cookie file makes YouTube refuse a video that plays fine anonymously.
        if cookie_path:
            strategies.append({
                "name": "anonymous",
                "desc": "Default clients, no cookies",
                "cookiefile": None,
                "owner": None,
            })

        info = None
        last_error = None
        resolved_by = None

        cache_dir = os.path.join("data", "yt_dlp_cache")

        # 4. Execute Strategies
        for strat in strategies:
            logger.info(f"Attempting resolution strategy: {strat['name']}")
        
            ydl_opts = build_ydl_opts(strat.get("cookiefile"), user_agent, cache_dir=cache_dir)

            try:
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    # Extract info without downloading
                    # Run in thread executor to avoid blocking event loop
                    info = await asyncio.to_thread(ydl.extract_info, original_url, download=False)
                
                    # Validation: Did we actually get formats?
                    if not info.get('formats'):
                        raise ValueError("No formats found")
                
                    # Validation: Avoid storyboard-only results (tiny duration or specific format IDs)
                    formats = info.get('formats', [])
                    valid_video = any(f.get('height') and f.get('height') >= 360 for f in formats)
                
                    if not valid_video:
                        logger.warning(f"Strategy {strat['name']} returned only low-quality/storyboard formats.")
                        # Don't fail yet, maybe it's just a 240p video, but treat as suspicious
                        # But if it's the only one that works, we might have to take it.
                        # For now, let's continue to try better strategies if this one sucks.
                        # Exception: if it's the last strategy, we'll take what we can get.
                        if strat != strategies[-1]:
                             continue
                    else:
                        logger.info(f"Strategy {strat['name']} SUCCESS!")
                        resolved_by = strat["owner"]
                        break  # We got good data, stop trying

            except Exception as e:
                logger.warning(f"Strategy {strat['name']} failed: {str(e)}")
                last_error = e
                continue

    # 5. Process Results
    if not info:
        logger.error(f"All resolution strategies failed. Last error: {last_error}")
        return video_data

    # Extract best URL using your existing logic
    stream_data = _extract_stream_url(info)

    if stream_data:
        room_fields = {key: video_data[key] for key in ('added_by', 'pinned', 'progress') if key in video_data}
        video_data.clear()
        video_data.update(_build_resolve_response(original_url, info, stream_data))
        video_data.update(room_fields)
        video_data[RESOLVED_BY_KEY] = resolved_by
        remember_stream_owner(video_data)
        await cache_format(original_url, video_data)

    return video_data
