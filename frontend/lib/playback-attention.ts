/**
 * Getting a viewer's attention when the room starts a video they cannot hear.
 *
 * The room is left open all day in a background tab. When someone queues a
 * video, the browser decides on its own whether this tab may start it with
 * sound, and the answer turns on one thing: whether the viewer has clicked or
 * pressed a key anywhere in this page since it loaded (Chrome and Firefox call
 * it sticky user activation; Chrome can also waive it for sites the viewer
 * watches a lot). Without it the video starts muted or not at all, in a tab
 * nobody is looking at, and nobody notices the room is playing.
 *
 * So the page asks for that one click up front, while nothing is at stake,
 * says where the browser setting is that makes the click unnecessary, and
 * when a start goes wrong anyway it says so where the viewer can see it: the
 * tab title and, if they opted in, a desktop notification.
 */

import type { PlaybackStart } from './playback';

/** The viewer's own opt-in to desktop notifications, per browser. */
export const NOTIFY_STORAGE_KEY = 'w2g-notify-video-start';

/**
 * The tab's title while the room has a video: whether it is playing for this
 * viewer, playing silently, or waiting for them, ahead of the page's own name.
 * A background tab's title is the one thing on screen that says so.
 */
export function attentionTitle(
    base: string,
    video: { title: string; playing: boolean; gate: PlaybackStart } | null,
): string {
    if (!video || !video.playing) return base;
    const name = video.title || 'Video';
    if (video.gate === 'blocked') return `⏸ Click to join · ${name} · ${base}`;
    if (video.gate === 'muted-to-start') return `🔇 Playing muted · ${name} · ${base}`;
    return `▶ ${name} · ${base}`;
}

/** What a desktop notification about this start should say. */
export function attentionNotice(
    title: string,
    gate: PlaybackStart,
    addedBy: string | undefined,
): { title: string; body: string } {
    const name = title || 'A video';
    if (gate === 'blocked') {
        return { title: `${name} is waiting for you`, body: 'Your browser held it back. Click here, then click the video to join.' };
    }
    if (gate === 'muted-to-start') {
        return { title: `${name} is playing muted`, body: 'Your browser started it without sound. Click here, then anywhere in the room to listen.' };
    }
    return { title: `Now playing: ${name}`, body: addedBy ? `Added by ${addedBy}` : 'The room started a new video.' };
}

/** 0.1 s of 8 kHz silence as a WAV blob: audible to the policy, not to anyone. */
function silentWavUrl(): string {
    const samples = 800;
    const bytes = new Uint8Array(44 + samples);
    const view = new DataView(bytes.buffer);
    const ascii = (offset: number, text: string) => {
        for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
    };
    ascii(0, 'RIFF');
    view.setUint32(4, 36 + samples, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, 8000, true);
    view.setUint32(28, 8000, true);
    view.setUint16(32, 1, true);
    view.setUint16(34, 8, true);
    ascii(36, 'data');
    view.setUint32(40, samples, true);
    bytes.fill(128, 44); // 8-bit PCM silence is the midpoint
    return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
}

/**
 * Play 0.1 s of silence, unmuted, and let the browser take its time deciding.
 *
 * Its answer is whether this page may start a video with sound without a
 * click. Playing it also unlocks the tab: Chrome holds back every start, muted
 * or not, in a hidden tab that has not yet played any media, and releases it
 * only when the tab is shown. Once this clip has played, a video someone
 * queues later starts while the tab sits in the background.
 *
 * So a hidden tab's clip is kept waiting, not given up on: the first time the
 * viewer so much as glances at the tab, it plays and the tab stays unlocked.
 * (A clip given up on after a timeout, and unloaded, is exactly the start that
 * would have done it.) Muted silence does not count: Chrome refuses a muted
 * audio element and pauses a muted hidden video before it ever plays.
 *
 * Resolves `true` once it played, `false` if the browser refused it.
 */
export function primeAudiblePlayback(): Promise<boolean> {
    const url = silentWavUrl();
    const audio = new Audio(url);
    const release = () => {
        audio.removeAttribute('src');
        URL.revokeObjectURL(url);
    };
    let started: Promise<void>;
    try {
        started = audio.play();
    } catch {
        release();
        return Promise.resolve(false);
    }
    return started.then(
        () => {
            audio.addEventListener('ended', release, { once: true });
            return true;
        },
        () => {
            release();
            return false;
        },
    );
}

/** Where a viewer turns off the click for this site for good, in their browser. */
export function permanentAutoplayHint(userAgent: string): string {
    if (/Firefox\//.test(userAgent)) {
        return 'click the icon left of the address, then set Autoplay to Allow Audio and Video';
    }
    if (/Edg\//.test(userAgent)) {
        return 'click the icon left of the address, open Permissions for this site, and set Media autoplay to Allow';
    }
    if (/Safari\//.test(userAgent) && !/Chrome\/|Chromium\//.test(userAgent)) {
        return 'open Safari › Settings for This Website and set Auto-Play to Allow All Auto-Play';
    }
    return 'click the icon left of the address, open Site settings, and set Sound to Allow';
}

/** The page has had a click or key press since it loaded, as far as the browser says. */
export function hasBeenActivated(): boolean {
    const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
    return activation?.hasBeenActive ?? false;
}
