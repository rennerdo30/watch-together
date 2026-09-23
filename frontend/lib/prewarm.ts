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
import { BACKEND_ORIGIN, PREWARM_POSITION_DEDUPE_MS } from './constants';

/** Videos already asked for, so a tick every second does not re-ask. */
const requested = new Set<string>();

/**
 * Prepare a queued video. Resolves once the server has answered, and
 * swallows failures: this is speculation, and the advance still works
 * without it.
 *
 * Only for a room whose current video is not playing through Shaka: when it
 * is, the player preloads the next entry itself (manifest, index, first
 * segments; see `useShakaPlayer`), which asks the server for the same
 * manifest and keeps what it got.
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

/** Positions asked for, by request, with when they were asked. */
const positionsAsked = new Map<string, number>();

/**
 * Ask the server to warm the bytes a player is about to want: the segments
 * covering `seconds` of the tallest rung at or below `height` (of `codec`'s
 * family when given), and the audio beside them.
 *
 * Called on intent — just before a load or a preload, when the pointer
 * rests on the seek bar or on a queue row — so the server has a head start
 * of a round trip or more on the request the player is about to send. The
 * server answers at once and does the work in the background; this never
 * waits for it, and a failure costs nothing but the head start.
 */
export function prewarmPosition(
    originalUrl: string | undefined,
    roomId: string,
    seconds: number,
    height: number,
    codec?: string,
): void {
    if (!originalUrl || !Number.isFinite(seconds) || !Number.isFinite(height) || height <= 0) return;
    const t = Math.max(0, Math.floor(seconds));
    const h = Math.round(height);
    const params = new URLSearchParams({ url: originalUrl, room: roomId, t: String(t), h: String(h) });
    if (codec) params.set('codec', codec);
    // Identity travels as a query parameter in development mode, the same
    // way the other client calls carry it.
    const user = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('user');
    if (user) params.set('user', user);
    const url = `${BACKEND_ORIGIN}/api/prewarm?${params.toString()}`;

    const now = Date.now();
    const askedAt = positionsAsked.get(url);
    if (askedAt !== undefined && now - askedAt < PREWARM_POSITION_DEDUPE_MS) return;
    positionsAsked.set(url, now);
    for (const [key, at] of positionsAsked) {
        if (now - at >= PREWARM_POSITION_DEDUPE_MS) positionsAsked.delete(key);
    }
    void fetch(url, { cache: 'no-store' }).catch(() => {
        // Speculation: the load itself still works without it.
    });
}

/** Forget what has been asked for (a new room, and tests). */
export function resetPrewarm(): void {
    requested.clear();
    positionsAsked.clear();
}
