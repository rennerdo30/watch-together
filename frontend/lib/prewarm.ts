/**
 * Asking the server for the next video before the room needs it.
 *
 * Starting a video is not free: it resolves (when the cached resolve has
 * expired), then probes every rendition's segment index to build the
 * manifest, then fetches the first bytes — and a queue advance pays all of
 * it while everyone watches a spinner. None of it depends on the advance
 * having happened.
 *
 * The server prepares the next entry on its own beat, from the position it
 * broadcasts. This asks as well, for the cases that beat does not cover: a
 * room paused near the end of a video, an entry whose duration the server
 * was never told, a viewer whose player is ahead of the room. Both paths
 * land in the same server-side caches, so asking twice costs one lookup.
 *
 * There is deliberately no byte-level prefetch here. Proxied media is sent
 * `no-store` — it is one viewer's authenticated stream, not something to
 * leave in a shared cache — so fetching segment ranges from the browser
 * would warm nothing in it and merely repeat what the server already did.
 */

import { dashManifestUrl } from './api';

/** Videos already asked for, so a tick every second does not re-ask. */
const requested = new Set<string>();

/**
 * Prepare a queued video. Resolves once the server has answered, and
 * swallows failures: this is speculation, and the advance still works
 * without it.
 */
export async function prewarmVideo(
    originalUrl: string | undefined,
    roomId: string,
    streamType?: string,
): Promise<void> {
    // Only the adaptive path has a manifest to build; an HLS or direct
    // source has nothing for this to prepare.
    if (!originalUrl || streamType !== 'dash' || requested.has(originalUrl)) return;
    requested.add(originalUrl);
    try {
        const response = await fetch(dashManifestUrl(originalUrl, roomId));
        // Read the body so the request is not cancelled mid-flight, then
        // drop it: what is wanted is the work the server did to produce it.
        await response.text();
    } catch {
        // A failed warm-up is not a failed playback; the advance re-asks.
        requested.delete(originalUrl);
    }
}

/** Forget what has been asked for (a new room, and tests). */
export function resetPrewarm(): void {
    requested.clear();
}
