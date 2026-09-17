/**
 * Capturing a screen, tuned for a game rather than a spreadsheet.
 *
 * What a viewer notices in gameplay is motion: a frame that arrives late
 * hurts more than a frame that is slightly soft. The browser's encoder
 * makes the opposite trade by default — it protects detail and drops the
 * frame rate — so both ends of the capture are told otherwise, through the
 * track's content hint and the sender's degradation preference.
 *
 * Every viewer costs the sharer one copy of this stream, which is why the
 * bitrate is a deliberate choice rather than whatever the encoder felt
 * like.
 */

import { SHARE_QUALITY_PRESETS, type ShareQuality } from '../constants';

/** Whether this browser can share a screen at all. */
export function canShareScreen(): boolean {
    return typeof navigator !== 'undefined'
        && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
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
    return null;
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

/**
 * Hold one sender to the chosen bitrate, and tell it what to sacrifice
 * when it cannot keep up.
 *
 * Failures are swallowed on purpose: a browser that does not implement
 * `setParameters` the way this asks still sends a usable picture, and a
 * share that works imperfectly beats one that refuses to start.
 */
export async function applyQuality(sender: RTCRtpSender, quality: ShareQuality): Promise<void> {
    const preset = SHARE_QUALITY_PRESETS[quality];
    if (sender.track?.kind !== 'video') return;
    try {
        const parameters = sender.getParameters();
        parameters.degradationPreference = 'maintain-framerate';
        if (!parameters.encodings?.length) parameters.encodings = [{}];
        parameters.encodings[0].maxBitrate = preset.maxBitrateBps;
        parameters.encodings[0].maxFramerate = preset.frameRate;
        await sender.setParameters(parameters);
    } catch (error) {
        console.warn('[Share] Could not apply the quality preset:', error);
    }
}

/** Stop every track, which is what releases the capture and its indicator. */
export function stopStream(stream: MediaStream | null): void {
    stream?.getTracks().forEach((track) => track.stop());
}
