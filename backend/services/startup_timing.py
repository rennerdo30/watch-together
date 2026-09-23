"""
How long "paste → playing" takes, broken into the parts that make it up.

Every performance change before this was argued from one measured stall at
a time, because nothing recorded durations: not the yt-dlp extraction, not
the index probes behind a manifest, not the wait between a video being set
and its first frame. Three sources now report here:

* **Resolve** — each `/api/resolve`-shaped extraction, or the cache hit
  that replaced it, timed in the backend.
* **Manifest** — each generated DASH manifest: how long the probes took and
  how many renditions survived them.
* **Startup** — each viewer's player, over the room socket
  (`playback_timing`): the phases from `set_video` to the first frame, and
  how often it stalled in the thirty seconds after.

Like `services/playback_quality.py`, each has two destinations: one INFO
line per event with a fixed, greppable prefix (`deploy/host-status.sh
--startup` reads them from the host), and a bounded ring in memory that the
admin panel summarises. Nothing is persisted and nothing leaves the process
except through the admin-only endpoint.
"""
import logging
import math
import time
from collections import deque
from typing import Deque, Dict, List, Optional

from core.config import STARTUP_TIMING_HISTORY_CAPACITY

logger = logging.getLogger(__name__)

# The prefixes every line starts with. `deploy/host-status.sh --startup`
# greps for them, so they are a contract, not a phrasing.
RESOLVE_PREFIX = "Resolve timing:"
MANIFEST_PREFIX = "Manifest timing:"
STARTUP_PREFIX = "Startup timing:"

RESOLVE_CACHED = "cached"
RESOLVE_EXTRACTED = "extracted"
RESOLVE_FAILED = "failed"

ENGINES = ("mse", "hls", "direct")

# Every phase a player reports, in the order the log line prints them. The
# player reports milliseconds; anything outside the range is dropped rather
# than trusted — a report is untrusted input.
PHASES = (
    "resolve_ms", "set_video_to_manifest_ms", "set_video_to_first_frame_ms",
    "first_frame_to_playing_ms",
)
PHASE_RANGE = (0, 10 * 60 * 1000)
RUNG_RANGE = (0, 10_000)
STALLS_RANGE = (0, 1_000)
URL_MAX_LENGTH = 2048


def _bounded(value, low: int, high: int) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    value = int(round(value))
    return value if low <= value <= high else None


def _percentile(values: List[float], fraction: float) -> Optional[int]:
    if not values:
        return None
    ordered = sorted(values)
    return int(round(ordered[min(len(ordered) - 1, int(fraction * len(ordered)))]))


def _spread(values: List[float]) -> dict:
    return {"count": len(values), "p50": _percentile(values, 0.5), "p90": _percentile(values, 0.9)}


class StartupTimings:
    """The newest events of each kind, oldest first, bounded."""

    def __init__(self, capacity: int = STARTUP_TIMING_HISTORY_CAPACITY):
        self.resolves: Deque[dict] = deque(maxlen=capacity)
        self.manifests: Deque[dict] = deque(maxlen=capacity)
        self.starts: Deque[dict] = deque(maxlen=capacity)

    def reset(self) -> None:
        self.resolves.clear()
        self.manifests.clear()
        self.starts.clear()

    def summary(self) -> dict:
        """Medians and 90th percentiles, the numbers worth watching move."""
        extracted = [e["ms"] for e in self.resolves if e["outcome"] == RESOLVE_EXTRACTED]
        cached = sum(1 for e in self.resolves if e["outcome"] == RESOLVE_CACHED)
        starts = list(self.starts)

        def phase(name: str, preloaded: Optional[bool] = None) -> dict:
            return _spread([s[name] for s in starts
                            if s.get(name) is not None
                            and (preloaded is None or s["preloaded"] == preloaded)])

        return {
            "resolve_extraction_ms": _spread(extracted),
            "resolve_cache_hit_ratio": round(cached / len(self.resolves), 3) if self.resolves else None,
            "resolve_failures": sum(1 for e in self.resolves if e["outcome"] == RESOLVE_FAILED),
            "manifest_ms": _spread([e["ms"] for e in self.manifests]),
            "first_frame_ms": phase("set_video_to_first_frame_ms"),
            "first_frame_ms_preloaded": phase("set_video_to_first_frame_ms", True),
            "first_frame_ms_cold": phase("set_video_to_first_frame_ms", False),
            "stalls_first_30s": _spread([s["stalls_first_30s"] for s in starts
                                         if s.get("stalls_first_30s") is not None]),
        }

    def snapshot(self, limit: int) -> dict:
        def newest(ring: Deque[dict]) -> List[dict]:
            entries = list(ring)
            return entries[-limit:] if limit > 0 else []
        return {
            "summary": self.summary(),
            "resolves": newest(self.resolves),
            "manifests": newest(self.manifests),
            "starts": newest(self.starts),
        }


history = StartupTimings()


def record_resolve(url: str, ms: float, outcome: str, *, attempts: int = 0,
                   lent_by: Optional[str] = None) -> None:
    """One resolve: served from the cache, extracted, or failed."""
    entry = {"at": time.time(), "url": url[:URL_MAX_LENGTH], "ms": int(round(ms)),
             "outcome": outcome, "attempts": attempts}
    history.resolves.append(entry)
    logger.info("%s outcome=%s ms=%d attempts=%d lent=%s url=%s", RESOLVE_PREFIX, outcome,
                entry["ms"], attempts, "yes" if lent_by else "no", entry["url"][:120])


def record_manifest(url: str, ms: float, *, video: int, video_total: int,
                    audio: int, audio_total: int) -> None:
    """One generated manifest, and how many renditions its probes kept."""
    entry = {"at": time.time(), "url": url[:URL_MAX_LENGTH], "ms": int(round(ms)),
             "video": video, "video_total": video_total, "audio": audio, "audio_total": audio_total}
    history.manifests.append(entry)
    logger.info("%s ms=%d video=%d/%d audio=%d/%d url=%s", MANIFEST_PREFIX, entry["ms"],
                video, video_total, audio, audio_total, entry["url"][:120])


def normalize(report) -> Optional[dict]:
    """A player's report, bounded field by field, or None if it is not one."""
    if not isinstance(report, dict):
        return None
    url = report.get("original_url")
    engine = report.get("engine")
    first_frame = _bounded(report.get("set_video_to_first_frame_ms"), *PHASE_RANGE)
    if not isinstance(url, str) or not url or engine not in ENGINES or first_frame is None:
        return None
    kept: Dict[str, object] = {
        "original_url": url[:URL_MAX_LENGTH],
        "engine": engine,
        "preloaded": report.get("preloaded") is True,
    }
    for name in PHASES:
        kept[name] = _bounded(report.get(name), *PHASE_RANGE)
    kept["rung_height"] = _bounded(report.get("rung_height"), *RUNG_RANGE)
    kept["stalls_first_30s"] = _bounded(report.get("stalls_first_30s"), *STALLS_RANGE)
    return kept


def describe(room_id: str, member: str, report: dict) -> str:
    def show(value) -> str:
        return "?" if value is None else str(value)
    phases = " ".join(f"{name}={show(report.get(name))}" for name in PHASES)
    return (f"{STARTUP_PREFIX} room={room_id} member={member} engine={report['engine']} "
            f"preloaded={'yes' if report['preloaded'] else 'no'} {phases} "
            f"rung={show(report.get('rung_height'))} stalls={show(report.get('stalls_first_30s'))} "
            f"url={str(report['original_url'])[:120]}")


def record_start(room_id: str, member: str, report) -> Optional[dict]:
    """Keep one player's startup report and log it. None if it was not one."""
    kept = normalize(report)
    if kept is None:
        return None
    history.starts.append({"at": time.time(), "room": room_id, "member": member, **kept})
    logger.info(describe(room_id, member, kept))
    return kept
