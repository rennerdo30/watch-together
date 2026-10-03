/**
 * A live playhead that has caught up with the playlist waits for it.
 *
 * When a live playlist stops advancing for longer than the cushion behind the
 * edge — a streamer's upload hiccups, a refresh arrives late — the playhead
 * plays through everything buffered and stops at the end. That end sits a few
 * milliseconds past the playlist's own edge: segment durations are declared
 * in the playlist, measured in the media, and the two never agree exactly.
 * hls.js's `synchronizeToLiveEdge` reads "past the edge" as "outside the
 * sliding window" and seeks back to the sync position. On Twitch that is 6s
 * back, so the viewer watches the same six seconds again, stalls at the same
 * spot, and is sent back again for as long as the playlist stays late.
 *
 * The playhead is not lost; it is early. The right thing is to wait for the
 * next segment, which is what this controller does.
 */

import Hls, { type LevelDetails, type StreamController } from 'hls.js';

/** How close to the end of buffered media the playhead counts as standing at it. */
const BUFFER_TOLERANCE_SECONDS = 0.1;
/** How far the end of the media may fall short of the playlist's edge. */
const EDGE_TOLERANCE_SECONDS = 0.5;

export interface LiveEdgePosition {
    /** The media element's current time. */
    position: number;
    /** The end of the newest segment the playlist lists. */
    edge: number;
    /** `#EXT-X-TARGETDURATION`: how far past the edge counts as "just past". */
    targetDuration: number;
    /** The element's buffered ranges, as [start, end] pairs. */
    buffered: Array<[number, number]>;
}

/**
 * True when the playhead has played everything up to the playlist's edge and
 * is waiting for more: it stands at the end of buffered media, that end is
 * the edge (give or take the declared-versus-measured slack), and it is less
 * than a target duration past it. Anything else — a timeline that jumped, a
 * playhead in an unbuffered hole, one stalled well short of the edge — is
 * left to hls.js.
 */
export function isWaitingAtLiveEdge({ position, edge, targetDuration, buffered }: LiveEdgePosition): boolean {
    if (position < edge - EDGE_TOLERANCE_SECONDS || position - edge > targetDuration) return false;
    return buffered.some(([start, end]) =>
        start - BUFFER_TOLERANCE_SECONDS <= position && Math.abs(end - position) <= BUFFER_TOLERANCE_SECONDS);
}

/** `isWaitingAtLiveEdge` for a media element and the playlist it plays. */
export function mediaIsWaitingAtLiveEdge(media: HTMLMediaElement, details: LevelDetails | null): boolean {
    if (!details?.live) return false;
    const buffered: Array<[number, number]> = [];
    for (let i = 0; i < media.buffered.length; i++) {
        buffered.push([media.buffered.start(i), media.buffered.end(i)]);
    }
    return isWaitingAtLiveEdge({
        position: media.currentTime,
        edge: details.edge,
        targetDuration: details.targetduration,
        buffered,
    });
}

interface SynchronizingController {
    media: HTMLMediaElement | null;
    synchronizeToLiveEdge(details: LevelDetails): void;
}

/**
 * hls.js's stream controller, except that a playhead waiting at the live edge
 * is left to wait. Passed as the `streamController` config option.
 *
 * `synchronizeToLiveEdge` is private to hls.js. `e2e/live-edge-wait.spec.ts`
 * fails when the installed hls.js no longer has it, so an upgrade that
 * renames it is caught before release. Should one reach a browser anyway,
 * the stock controller is used and the console says why: the replay loop
 * comes back, but every other HLS video still plays.
 */
export function edgeWaitingStreamController(): typeof StreamController {
    const Base = Hls.DefaultConfig.streamController;
    const synchronize = (Base.prototype as unknown as Partial<SynchronizingController>).synchronizeToLiveEdge;
    if (typeof synchronize !== 'function') {
        console.warn('[HLS] StreamController has no synchronizeToLiveEdge; a late live playlist may replay its last seconds (lib/live-edge.ts)');
        return Base;
    }

    class EdgeWaitingStreamController extends Base {}
    (EdgeWaitingStreamController.prototype as unknown as SynchronizingController).synchronizeToLiveEdge =
        function (this: SynchronizingController, details: LevelDetails) {
            if (this.media && mediaIsWaitingAtLiveEdge(this.media, details)) return;
            synchronize.call(this, details);
        };
    return EdgeWaitingStreamController;
}
