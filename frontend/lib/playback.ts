/**
 * Starting playback under the browser's autoplay policy.
 *
 * A page that has had no user gesture may not start audible playback. Chrome,
 * Safari and Firefox all reject `play()` in that case, and the rejection is
 * the only signal — the element simply stays paused. Every call site here used
 * to swallow it into a `console.log`, so a viewer who had not clicked anything
 * yet just sat on a still frame while the rest of the room watched, and had to
 * press play by hand.
 *
 * Muted playback is always permitted, so a blocked start is retried muted:
 * being in sync without sound is much closer to what the viewer wanted than
 * being stopped, and one click restores the audio. If even that is refused,
 * the caller is told so it can ask for the gesture the browser is waiting for.
 */

import { RESUME_END_GUARD_SECONDS, RESUME_MIN_SECONDS } from './constants';

export type PlaybackStart =
    /** Playing, with the sound the viewer had chosen. */
    | 'started'
    /** Playing, but muted against the viewer's wishes to satisfy the policy. */
    | 'muted-to-start'
    /** Refused outright: nothing will play until the viewer interacts. */
    | 'blocked';

export async function startPlayback(video: HTMLMediaElement): Promise<PlaybackStart> {
    try {
        await video.play();
        return 'started';
    } catch {
        // Already muted and still refused: no amount of muting will help.
        if (video.muted) return 'blocked';
    }

    video.muted = true;
    try {
        await video.play();
        return 'muted-to-start';
    } catch {
        // Restore what the viewer had, so the unmute control is not left
        // showing a state that was never theirs.
        video.muted = false;
        return 'blocked';
    }
}

/** The fields of a queue entry that decide where it resumes. */
export interface ResumableEntry {
    is_live?: boolean;
    duration?: number;
    progress?: number;
}

/**
 * Where the room starts a queued video: the position it was left at, or the
 * top. Mirrors the server's `ConnectionManager._resume_position`, because a
 * player preparing the next entry has to prepare the position the server is
 * about to announce — a few seconds in is not worth resuming, and the last
 * stretch of a video is where a replay should start over.
 */
export function resumePosition(entry: ResumableEntry | null | undefined): number {
    if (!entry || entry.is_live) return 0;
    const progress = entry.progress;
    if (typeof progress !== 'number' || !Number.isFinite(progress)) return 0;
    if (progress < RESUME_MIN_SECONDS) return 0;
    const duration = entry.duration;
    if (typeof duration === 'number' && duration > 0 && progress > duration - RESUME_END_GUARD_SECONDS) return 0;
    return progress;
}
