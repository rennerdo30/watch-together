/**
 * Capturing a screen, tuned for a game rather than a spreadsheet.
 *
 * What a viewer notices in gameplay is motion: a frame that arrives late
 * hurts more than a frame that is slightly soft. The browser's encoder
 * makes the opposite trade by default — it protects detail and drops the
 * frame rate — so the capture is told otherwise through the track's content
 * hint, and the recorder is given a bitrate rather than left to guess.
 *
 * The sharer encodes once and uploads once; the server sends a copy to each
 * viewer. The bitrate is therefore a deliberate choice about what the
 * *server* will be asked to carry, not only about this uplink.
 */

import {
    SHARE_KEYFRAME_INTERVAL_MS, SHARE_MIME_CANDIDATES, SHARE_QUALITY_PRESETS,
    type ShareQuality,
} from '../constants';

/** Whether this browser can share a screen at all. */
export function canShareScreen(): boolean {
    return typeof navigator !== 'undefined'
        && typeof navigator.mediaDevices?.getDisplayMedia === 'function'
        && typeof window !== 'undefined'
        && typeof window.MediaRecorder === 'function';
}

/** What this browser is missing, phrased for a person rather than a log. */
export function shareUnsupportedReason(): string | null {
    if (typeof navigator === 'undefined') return null;
    if (!window.isSecureContext) {
        return 'Screen sharing needs a secure connection (https).';
    }
    if (!canShareScreen()) {
        return 'This browser cannot share a screen. Chrome, Edge and Firefox can.';
    }
    if (!chooseRecordingMime(true)) {
        return 'This browser cannot record a screen in a format the room can play.';
    }
    return null;
}

/**
 * The container to record in: the first candidate this browser can both
 * produce and, as a viewer, play back.
 *
 * Both halves matter. The recorder's output is appended to a `SourceBuffer`
 * on the other side, so a format this browser can write but no browser can
 * read is worse than useless — it would start a share nobody sees.
 */
export function chooseRecordingMime(withAudio: boolean): string | null {
    if (typeof window === 'undefined' || typeof window.MediaRecorder !== 'function') {
        return null;
    }
    for (const mime of SHARE_MIME_CANDIDATES) {
        // A codec list naming opus is a promise the recorder cannot keep
        // when the capture has no audio track.
        if (!withAudio && mime.includes('opus')) continue;
        if (MediaRecorder.isTypeSupported(mime)
            && typeof MediaSource !== 'undefined'
            && MediaSource.isTypeSupported(mime)) {
            return mime;
        }
    }
    return null;
}

/**
 * How to record one capture: the format, the bitrate, and how often the
 * encoder must produce a frame a viewer can start from.
 */
export function recorderOptions(stream: MediaStream, quality: ShareQuality): MediaRecorderOptions | null {
    const preset = SHARE_QUALITY_PRESETS[quality];
    const mimeType = chooseRecordingMime(stream.getAudioTracks().length > 0);
    if (!mimeType) return null;
    return {
        mimeType,
        videoBitsPerSecond: preset.maxBitrateBps,
        // A viewer that joins late, or is restarted at the live edge after
        // falling behind, has nothing to decode until the next keyframe.
        // Chromium accepts this hint; a browser that ignores it still
        // works, it just makes those viewers wait longer for a picture.
        videoKeyFrameIntervalDuration: SHARE_KEYFRAME_INTERVAL_MS,
    } as MediaRecorderOptions;
}

/**
 * Ask for a screen, window or tab. Rejects when the person cancels the
 * picker, which is an ordinary outcome and not an error to report.
 */
export async function captureScreen(quality: ShareQuality): Promise<MediaStream> {
    const preset = SHARE_QUALITY_PRESETS[quality];
    const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
            frameRate: { ideal: preset.frameRate },
            width: { ideal: preset.width },
            height: { ideal: preset.height },
        },
        // Game audio travels with the picture. Chromium offers the choice
        // in its picker; a browser that cannot will simply hand back a
        // stream with no audio track, which still plays.
        audio: {
            autoGainControl: false,
            echoCancellation: false,
            noiseSuppression: false,
        },
        // Sharing the room's own tab would put the player inside itself.
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
        systemAudio: 'include',
    } as DisplayMediaStreamOptions);

    for (const track of stream.getVideoTracks()) {
        // "Keep the frames coming, soften the picture if you must."
        track.contentHint = 'motion';
    }
    for (const track of stream.getAudioTracks()) {
        track.contentHint = 'music';
    }
    return stream;
}

/** Stop every track, which is what releases the capture and its indicator. */
export function stopStream(stream: MediaStream | null): void {
    stream?.getTracks().forEach((track) => track.stop());
}
