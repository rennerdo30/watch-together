/**
 * What this browser's connection managed last time.
 *
 * Shaka opens every load on a fixed, cautious bandwidth guess and climbs
 * from there, so a viewer who watched at 1080p yesterday still starts each
 * video at the lowest rendition and waits for the estimate to catch up.
 * The measured estimate is kept in local storage and used as the opening
 * guess next time, discounted a little because a measurement is a moment
 * and a connection is not.
 */

import { BANDWIDTH_MEMORY_MAX_AGE_MS, BANDWIDTH_MEMORY_DISCOUNT, SHAKA_INITIAL_BANDWIDTH_ESTIMATE, SHAKA_MAX_REMEMBERED_BANDWIDTH } from './constants';

export const BANDWIDTH_MEMORY_KEY = 'w2g-bandwidth-estimate';

export interface StoredEstimate {
    /** Bits per second, as Shaka measured it. */
    bps: number;
    /** Epoch milliseconds of the measurement. */
    at: number;
}

export function parseStoredEstimate(raw: string | null, now: number): StoredEstimate | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<StoredEstimate>;
        if (typeof parsed.bps !== 'number' || typeof parsed.at !== 'number') return null;
        if (!Number.isFinite(parsed.bps) || !Number.isFinite(parsed.at)) return null;
        if (parsed.bps <= 0 || parsed.at > now || now - parsed.at > BANDWIDTH_MEMORY_MAX_AGE_MS) return null;
        return { bps: parsed.bps, at: parsed.at };
    } catch {
        return null;
    }
}

/**
 * The bandwidth to open the next load with.
 *
 * Respect measured slow connections as well as fast ones. The fixed default
 * is only for an unknown connection; using it as a floor would overestimate
 * a known slow link. Cap optimistic measurements before the first request.
 */
export function openingEstimate(stored: StoredEstimate | null): number {
    if (!stored) return SHAKA_INITIAL_BANDWIDTH_ESTIMATE;
    const discounted = stored.bps * BANDWIDTH_MEMORY_DISCOUNT;
    return Math.min(SHAKA_MAX_REMEMBERED_BANDWIDTH, Math.max(1, discounted));
}

export function readOpeningEstimate(now = Date.now()): number {
    if (typeof window === 'undefined') return SHAKA_INITIAL_BANDWIDTH_ESTIMATE;
    let raw: string | null = null;
    try {
        raw = window.localStorage.getItem(BANDWIDTH_MEMORY_KEY);
    } catch {
        // Storage can be disabled; the default is fine.
    }
    return openingEstimate(parseStoredEstimate(raw, now));
}

/**
 * The value worth carrying forward from a session so far.
 *
 * What is remembered used to be the *last* estimate seen while playing,
 * which is a single moment: a wifi dip, a competing download, or the first
 * segments of a video the server had not cached yet. Because the memory has
 * no floor by design (above), one such moment discounted itself into the
 * next session's opening guess, which picked a lower rendition, whose
 * smaller segments measured slower still. The best estimate the connection
 * actually reached is the honest answer to "what can this link do", and it
 * stays low for a link that genuinely is.
 */
export function sessionHighWater(best: number | null, sample: number): number | null {
    if (!Number.isFinite(sample) || sample <= 0) return best;
    return best === null ? sample : Math.max(best, sample);
}

export function rememberBandwidth(bps: number, now = Date.now()): void {
    if (typeof window === 'undefined' || !Number.isFinite(bps) || bps <= 0) return;
    try {
        window.localStorage.setItem(BANDWIDTH_MEMORY_KEY, JSON.stringify({ bps: Math.round(bps), at: now }));
    } catch {
        // Nothing to do: next time opens on the default.
    }
}

/** What is remembered right now, for the statistics overlay to show. */
export function readRememberedEstimate(now = Date.now()): StoredEstimate | null {
    if (typeof window === 'undefined') return null;
    try {
        return parseStoredEstimate(window.localStorage.getItem(BANDWIDTH_MEMORY_KEY), now);
    } catch {
        return null;
    }
}

/**
 * Throw the remembered measurement away, so the next load opens on the
 * cautious default and learns again. A viewer whose connection was bad once
 * — a download running in another tab, a server cache that was cold — could
 * otherwise only escape it through developer tools.
 */
export function forgetBandwidth(): void {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.removeItem(BANDWIDTH_MEMORY_KEY);
    } catch {
        // Nothing to do.
    }
}
