/**
 * How long a video took to start, from this viewer's side.
 *
 * "It takes ages to start" has several possible culprits — the resolve, the
 * manifest (the server probing every rendition), the first segment crossing
 * the tunnel, the autoplay policy — and only the browser sees the phases
 * apart. Each client measures one start per video and sends it to the
 * server as a `playback_timing` message, which the server logs and
 * aggregates.
 *
 * Every phase is measured with `performance.now()` from the moment this
 * client learnt of the video: the `set_video` message, or the initial sync
 * for a member who joins while it plays.
 *
 * - **manifest**: the engine has the stream description in hand — Shaka's
 *   `manifestparsed`, hls.js's `MANIFEST_PARSED`; for a preloaded video the
 *   moment the load takes over the preload, which already holds it. A
 *   direct file has none.
 * - **first frame**: the media element's first `loadeddata` for the source —
 *   the first frame at the current position is decoded and can be shown.
 *   It is what a viewer perceives as "the picture appeared", whether or not
 *   the autoplay policy then lets it move.
 * - **playing**: the first `playing` event after that.
 * - **stalls**: buffering events in the first `PLAYBACK_TIMING_STALL_WINDOW_MS`
 *   after the first frame. The report is sent when that window closes, or
 *   earlier when the room moves to another video.
 */

import { PLAYBACK_TIMING_STALL_WINDOW_MS } from './constants';

export type PlaybackEngine = 'mse' | 'hls' | 'direct';

/** The `playback_timing` message payload. Field names are the wire format. */
export interface PlaybackTiming {
    original_url: string;
    engine: PlaybackEngine;
    preloaded: boolean;
    /** Only on the client that resolved the video before announcing it. */
    resolve_ms?: number;
    set_video_to_manifest_ms?: number;
    set_video_to_first_frame_ms: number;
    first_frame_to_playing_ms?: number;
    /** Height of the first decoded frame. */
    rung_height?: number;
    stalls_first_30s?: number;
}

const elapsed = (from: number, to: number) => Math.max(0, Math.round(to - from));

export class StartupTimer {
    private manifestAt: number | null = null;
    private preloaded = false;
    private firstFrameAt: number | null = null;
    private playingAt: number | null = null;
    private rungHeight: number | null = null;
    private stalls = 0;
    private reported = false;

    constructor(
        readonly originalUrl: string,
        readonly engine: PlaybackEngine,
        /** `performance.now()` when this client learnt of the video. */
        readonly startedAt: number,
        readonly resolveMs?: number,
    ) { }

    markManifest(at: number, preloaded: boolean): void {
        if (this.manifestAt !== null || this.firstFrameAt !== null) return;
        this.manifestAt = Math.max(at, this.startedAt);
        this.preloaded = preloaded;
    }

    markFirstFrame(at: number, rungHeight?: number): void {
        if (this.firstFrameAt !== null) return;
        this.firstFrameAt = Math.max(at, this.manifestAt ?? this.startedAt);
        if (rungHeight && rungHeight > 0) this.rungHeight = rungHeight;
    }

    markPlaying(at: number): void {
        // Before the first frame of this source, a `playing` can only be the
        // previous video's, still on the element while this one loads.
        if (this.playingAt !== null || this.firstFrameAt === null) return;
        this.playingAt = Math.max(at, this.firstFrameAt);
    }

    markStall(at: number): void {
        if (this.firstFrameAt === null) return;
        if (at - this.firstFrameAt > PLAYBACK_TIMING_STALL_WINDOW_MS) return;
        this.stalls += 1;
    }

    /**
     * The report, once: null before the first frame (a start that never
     * showed anything has no timing to give) and after it was taken.
     */
    takeReport(): PlaybackTiming | null {
        if (this.reported || this.firstFrameAt === null) return null;
        this.reported = true;
        const report: PlaybackTiming = {
            original_url: this.originalUrl,
            engine: this.engine,
            preloaded: this.preloaded,
            set_video_to_first_frame_ms: elapsed(this.startedAt, this.firstFrameAt),
            stalls_first_30s: this.stalls,
        };
        if (this.resolveMs !== undefined) report.resolve_ms = Math.max(0, Math.round(this.resolveMs));
        if (this.manifestAt !== null) report.set_video_to_manifest_ms = elapsed(this.startedAt, this.manifestAt);
        if (this.playingAt !== null) report.first_frame_to_playing_ms = elapsed(this.firstFrameAt, this.playingAt);
        if (this.rungHeight !== null) report.rung_height = this.rungHeight;
        return report;
    }
}
