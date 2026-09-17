"""
Per-viewer playback quality: what one player made of the stream, and why.

Auto quality is decided in the browser, from inputs that exist only there:
the size the video is drawn at, the pixel ratio, the measured bandwidth,
the frames the decoder dropped. The players report those over the room
socket, which answered "which rung is this viewer on" — but only for
somebody with a browser signed in to Cloudflare Access, and only while the
viewer was still connected. From the host, where an operator actually
stands, the reports were invisible: the admin API refuses an unverified
request (correctly), and nothing was written down.

So a report has two destinations here:

* **The log**, at INFO, one greppable line per *change*. This is the copy
  an operator reads (`deploy/host-status.sh --quality`), the copy that
  survives the viewer's disconnect and the copy that ends up in a log
  bundle. Unchanged 30-second heartbeats go to DEBUG so a steady room
  does not fill the log with the same line.
* **A bounded ring buffer in memory**, for the admin panel, so the panel
  can show a viewer who has already left instead of only the ones
  connected this second.

Identity is part of both. That is a deliberate, bounded decision: the
backend log already names the requester on every resolve, every cookie
lend and every history ping, so this writes an email to a place emails
are already written, and nowhere else. Nothing is persisted to disk by
this module, and nothing leaves the process except through the
admin-only endpoint.

Cost per report is one dict build, one comparison and at most one log
call. There is no lock: this runs in the single worker's event loop and
`deque.append` under a bounded `maxlen` is atomic, so a reader never sees
a half-written buffer.
"""
import logging
import time
from collections import deque
from typing import Deque, List, Optional

from core.config import (
    PLAYBACK_QUALITY_HISTORY_CAPACITY,
    PLAYBACK_QUALITY_ESTIMATE_CHANGE_RATIO,
    PLAYBACK_QUALITY_DROPPED_CHANGE,
    PLAYBACK_QUALITY_DROPPED_TROUBLE,
)

logger = logging.getLogger(__name__)

# What a player may call itself, so a browser cannot write arbitrary text
# into the admin panel or into the log.
QUALITY_MODES = ("balanced", "highest", "saver")
PLAYBACK_ENGINES = ("mse", "hls")

# Bounds for every field a browser sends. A report is untrusted input.
RUNG_RANGE = (0, 10_000)            # picture height in lines
SURFACE_RANGE = (0, 100_000)        # element height in CSS pixels
PIXEL_RATIO_RANGE = (0.0, 16.0)
ESTIMATE_RANGE = (0, 10_000_000_000)  # bits per second
DROPPED_RANGE = (0.0, 1.0)          # fraction of decoded frames
LADDER_RANGE = (0, 100)             # renditions offered

# The fields a report is made of, in the order the log line prints them.
REPORT_FIELDS = (
    "rung", "cap", "surface_px", "pixel_ratio", "estimate_bps",
    "dropped_frames", "ladder_rungs", "mode", "engine",
)

# Which fields make a report *news*. The bandwidth estimate and the dropped
# frame ratio move on every sample, so they are compared by how far they
# moved rather than by equality (see `is_notable`).
DECISION_FIELDS = (
    "rung", "cap", "surface_px", "pixel_ratio", "ladder_rungs", "mode", "engine",
)

# The prefix every log line starts with. `deploy/host-status.sh --quality`
# greps for it, so it is a contract, not a phrasing.
LOG_PREFIX = "Playback quality:"

# Why the player is where it is. First match wins; the order is the order
# in which an operator should care.
VERDICT_NO_RUNG = "no-rung-reported"
VERDICT_DROPPING = "dropping-frames"
VERDICT_SAVER = "saver-mode"
VERDICT_SURFACE_CAPPED = "surface-capped"
VERDICT_SINGLE_RUNG = "single-rung-ladder"
VERDICT_BANDWIDTH = "bandwidth-limited"

# Printed where a browser sent nothing usable for a field.
MISSING = "?"


def _bounded_int(value, low: int, high: int) -> Optional[int]:
    """An integer inside the range, or None for anything else."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value != value or value in (float("inf"), float("-inf")):
        return None
    return int(value) if low <= value <= high else None


def _bounded_float(value, low: float, high: float) -> Optional[float]:
    """A float inside the range, rounded for display, or None."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value != value or value in (float("inf"), float("-inf")):
        return None
    return round(float(value), 4) if low <= value <= high else None


def normalize(report) -> Optional[dict]:
    """Keep only the fields this understands, each bounded, plus a timestamp.

    Returns None when the payload is not a report at all.
    """
    if not isinstance(report, dict):
        return None
    mode = report.get("mode")
    engine = report.get("engine")
    return {
        "rung": _bounded_int(report.get("rung"), *RUNG_RANGE),
        "cap": _bounded_int(report.get("cap"), *RUNG_RANGE),
        "surface_px": _bounded_int(report.get("surface_px"), *SURFACE_RANGE),
        "pixel_ratio": _bounded_float(report.get("pixel_ratio"), *PIXEL_RATIO_RANGE),
        "estimate_bps": _bounded_int(report.get("estimate_bps"), *ESTIMATE_RANGE),
        "dropped_frames": _bounded_float(report.get("dropped_frames"), *DROPPED_RANGE),
        "ladder_rungs": _bounded_int(report.get("ladder_rungs"), *LADDER_RANGE),
        "mode": mode if mode in QUALITY_MODES else None,
        "engine": engine if engine in PLAYBACK_ENGINES else None,
        "at": time.time(),
    }


def _moved(previous, current, absolute: float) -> bool:
    """Whether a measured number moved far enough to be worth a line."""
    if previous is None or current is None:
        return previous is not current
    return abs(current - previous) >= absolute


def _moved_relatively(previous, current, ratio: float) -> bool:
    """Whether an estimate moved by more than `ratio` of the larger value."""
    if previous is None or current is None:
        return previous is not current
    larger = max(abs(previous), abs(current))
    if larger == 0:
        return False
    return abs(current - previous) / larger >= ratio


def is_notable(previous: Optional[dict], current: dict) -> bool:
    """Whether this report says something the last one did not.

    The client already withholds an unchanged report for
    `QUALITY_REPORT_INTERVAL_MS`, but it compares only rung, cap, mode,
    ladder and engine — so every half minute of steady playback still
    arrives here. Those repeats are the ones that must not reach INFO: a
    room of four viewers would otherwise write half a million lines a
    month saying nothing changed.
    """
    if previous is None:
        return True
    if any(previous.get(field) != current.get(field) for field in DECISION_FIELDS):
        return True
    if _moved_relatively(previous.get("estimate_bps"), current.get("estimate_bps"),
                         PLAYBACK_QUALITY_ESTIMATE_CHANGE_RATIO):
        return True
    return _moved(previous.get("dropped_frames"), current.get("dropped_frames"),
                  PLAYBACK_QUALITY_DROPPED_CHANGE)


def verdict(report: dict) -> str:
    """The one input that best explains the rung this viewer is on.

    This is the "why" half of the operator's question. It is a reading of
    the numbers on the same line, not a separate measurement, so it can be
    argued with — the inputs are printed beside it for exactly that.
    """
    rung = report.get("rung")
    if not rung:
        return VERDICT_NO_RUNG
    dropped = report.get("dropped_frames")
    if dropped is not None and dropped >= PLAYBACK_QUALITY_DROPPED_TROUBLE:
        # The decoder cannot keep up, which no amount of bandwidth fixes.
        return VERDICT_DROPPING
    if report.get("mode") == "saver":
        return VERDICT_SAVER
    cap = report.get("cap")
    if cap and rung >= cap:
        # Auto is sitting on its ceiling: the drawing surface decides, and
        # a bigger player (or a real layout) is what raises it.
        return VERDICT_SURFACE_CAPPED
    ladder = report.get("ladder_rungs")
    if ladder is not None and ladder <= 1:
        return VERDICT_SINGLE_RUNG
    # Below the cap, decoder fine, rungs available: the estimate chose this.
    return VERDICT_BANDWIDTH


def _mbps(estimate_bps: Optional[int]) -> str:
    if estimate_bps is None:
        return MISSING
    return f"{estimate_bps / 1_000_000:.2f}Mbps"


def describe(room_id: str, member: str, report: dict) -> str:
    """One line carrying the rung, every input that decided it, and a verdict.

    Fixed `key=value` order, no spaces inside a value: an operator greps
    this and awk splits it.
    """
    rung = report.get("rung")
    cap = report.get("cap")
    surface = report.get("surface_px")
    ratio = report.get("pixel_ratio")
    dropped = report.get("dropped_frames")
    ladder = report.get("ladder_rungs")
    return (
        f"{LOG_PREFIX} member={member} room={room_id} "
        f"rung={f'{rung}p' if rung else MISSING} "
        f"cap={f'{cap}p' if cap else 'none'} "
        f"surface={f'{surface}px' if surface is not None else MISSING} "
        f"dpr={ratio if ratio is not None else MISSING} "
        f"estimate={_mbps(report.get('estimate_bps'))} "
        f"dropped={f'{dropped * 100:.2f}%' if dropped is not None else MISSING} "
        f"ladder={ladder if ladder is not None else MISSING} "
        f"mode={report.get('mode') or MISSING} "
        f"engine={report.get('engine') or MISSING} "
        f"verdict={verdict(report)}"
    )


class PlaybackQualityHistory:
    """The most recent notable reports, oldest first, across every room.

    Bounded like `services/metrics.py`'s sample ring: a diagnostic that
    grows without limit becomes the incident. Only notable reports are
    kept, so one idle viewer cannot push everyone else out of it with
    thirty-second repeats of the same picture.
    """

    def __init__(self, capacity: int = PLAYBACK_QUALITY_HISTORY_CAPACITY):
        self._entries: Deque[dict] = deque(maxlen=capacity)

    def append(self, room_id: str, member: str, report: dict) -> None:
        self._entries.append({"room": room_id, "member": member,
                              "verdict": verdict(report), **report})

    def snapshot(self, limit: int) -> List[dict]:
        """The newest `limit` entries, oldest first.

        Identities are included: the only caller is the admin panel, which
        already lists who is in every room.
        """
        entries = list(self._entries)
        return entries[-limit:] if limit > 0 else []

    def reset(self) -> None:
        self._entries.clear()


history = PlaybackQualityHistory()


def record(room_id: str, member: str, report, previous: Optional[dict]) -> Optional[dict]:
    """Normalize one report, log it if it says anything new, and keep it.

    Returns the normalized report, or None if the payload was not one.
    """
    kept = normalize(report)
    if kept is None:
        return None
    if is_notable(previous, kept):
        logger.info(describe(room_id, member, kept))
        history.append(room_id, member, kept)
    else:
        logger.debug(describe(room_id, member, kept))
    return kept
