/**
 * Where to sit behind the edge of a live HLS stream.
 *
 * The number hls.js needs is seconds of latency, and the only honest source
 * for it is the playlist: how long its segments really are, and how much
 * media it keeps. See the constants for why the rule is shaped this way.
 */

import {
    LIVE_SYNC_MAX_WINDOW_FRACTION,
    LIVE_SYNC_MIN_SECONDS,
    LIVE_SYNC_SEGMENT_COUNT,
} from './constants';

export interface LivePlaylistShape {
    /** Duration of every segment the playlist currently lists, in seconds. */
    segmentDurations: number[];
    /** `#EXT-X-TARGETDURATION` — a declared upper bound, not a measurement. */
    targetDuration: number;
    /** Everything the playlist holds: the sliding window, in seconds. */
    windowDuration: number;
}

const positiveOrNull = (value: number): number | null =>
    Number.isFinite(value) && value > 0 ? value : null;

/**
 * The typical segment length, in seconds, or null if the playlist lists none.
 *
 * The median rather than the mean: a live playlist routinely ends in a short
 * partial segment, and one of those must not drag the whole estimate down.
 */
function medianSegmentDuration(durations: number[]): number | null {
    const usable = durations.filter((d) => positiveOrNull(d) !== null).sort((a, b) => a - b);
    if (usable.length === 0) return null;
    return usable[Math.floor((usable.length - 1) / 2)];
}

/**
 * Seconds behind the live edge to play, derived from what the playlist
 * actually contains.
 *
 * Three real segments, never under `LIVE_SYNC_MIN_SECONDS`, and never past
 * `LIVE_SYNC_MAX_WINDOW_FRACTION` of the sliding window — the ceiling wins,
 * because a target beyond the window is the bug this replaces: it is the one
 * that drops the playhead off the back and makes hls.js seek.
 */
export function liveSyncTargetSeconds({
    segmentDurations,
    targetDuration,
    windowDuration,
}: LivePlaylistShape): number {
    // Only if the playlist lists no usable segment does the declared target
    // duration get a say, and it is the last thing left to go on.
    const segment = medianSegmentDuration(segmentDurations) ?? positiveOrNull(targetDuration);
    const fromSegments = segment === null
        ? LIVE_SYNC_MIN_SECONDS
        : Math.max(segment * LIVE_SYNC_SEGMENT_COUNT, LIVE_SYNC_MIN_SECONDS);

    const window = positiveOrNull(windowDuration);
    if (window === null) return fromSegments;
    return Math.min(fromSegments, window * LIVE_SYNC_MAX_WINDOW_FRACTION);
}
