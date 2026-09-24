/**
 * The destination of a jump the room is about to make, already in the page.
 *
 * A SponsorBlock skip is decided by the server, which warms the far side of
 * it in its own cache and announces it to the room (`skip_upcoming`) about
 * twenty seconds ahead. A warm server cache still leaves every viewer one
 * round trip to the server after the jump — from Japan to Germany, most of
 * the stall — because the player's buffer ends where the sponsor began.
 *
 * So each player fetches the destination itself, ahead of time: the server
 * describes the exact requests the player will make there
 * (`/api/segment-spans`, the manifest's own URIs and byte ranges), they are
 * fetched into this bounded cache, and a Shaka networking plugin answers a
 * matching segment request from it instead of the network. Proxied media is
 * `no-store`, so the browser's HTTP cache cannot do this.
 */

import { segmentSpansUrl } from './api';
import { JUMP_CACHE_MAX_BYTES, JUMP_CACHE_TTL_MS } from './constants';

interface CachedSpan {
    data: ArrayBuffer;
    headers: Record<string, string>;
    storedAt: number;
}

/** One request the player will make: its URI and inclusive byte range. */
export interface JumpSpan {
    uri: string;
    start: number;
    end: number;
}

const spans = new Map<string, CachedSpan>();
let storedBytes = 0;

const keyOf = (uri: string, start: number, end: number) => `${start}-${end} ${uri}`;

function forget(key: string): void {
    const entry = spans.get(key);
    if (!entry) return;
    storedBytes -= entry.data.byteLength;
    spans.delete(key);
}

function prune(now: number): void {
    for (const [key, entry] of spans) {
        if (now - entry.storedAt > JUMP_CACHE_TTL_MS) forget(key);
    }
    // Oldest first: a Map iterates in insertion order.
    for (const key of spans.keys()) {
        if (storedBytes <= JUMP_CACHE_MAX_BYTES) break;
        forget(key);
    }
}

/** Keep one fetched span. Oversized or stale entries make room first. */
export function storeSpan(uri: string, start: number, end: number, data: ArrayBuffer,
    headers: Record<string, string>, now = Date.now()): void {
    if (data.byteLength !== end - start + 1 || data.byteLength > JUMP_CACHE_MAX_BYTES) return;
    const key = keyOf(uri, start, end);
    forget(key);
    spans.set(key, { data, headers, storedAt: now });
    storedBytes += data.byteLength;
    prune(now);
}

/**
 * The cached answer to a request for exactly this span, taken out of the
 * cache (a jump's bytes are wanted once; the player's own buffer keeps them
 * after that). Null for anything else, which goes to the network as usual.
 */
export function takeSpan(uri: string, rangeHeader: string | undefined,
    now = Date.now()): CachedSpan | null {
    const range = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader ?? '');
    if (!range) return null;
    const key = keyOf(uri, Number(range[1]), Number(range[2]));
    const entry = spans.get(key);
    if (!entry) return null;
    forget(key);
    return now - entry.storedAt > JUMP_CACHE_TTL_MS ? null : entry;
}

/** Drop everything (a new video, and tests). */
export function clearJumpCache(): void {
    spans.clear();
    storedBytes = 0;
}

export function jumpCacheSize(): { entries: number; bytes: number } {
    return { entries: spans.size, bytes: storedBytes };
}

/** Requests already fetched or on their way, so an announcement is acted on once. */
const inFlight = new Set<string>();

/**
 * Fetch the destination of an announced jump into the cache. Speculation:
 * every failure is swallowed, and the jump simply fetches as it always did.
 */
export async function fetchJumpDestination(originalUrl: string, seconds: number,
    height: number, codec: string | undefined): Promise<number> {
    let described: JumpSpan[] = [];
    try {
        const response = await fetch(segmentSpansUrl(originalUrl, seconds, height, codec), { cache: 'no-store' });
        if (!response.ok) return 0;
        described = ((await response.json()) as { spans?: JumpSpan[] }).spans ?? [];
    } catch {
        return 0;
    }
    const fetched = await Promise.all(described.map(async ({ uri, start, end }) => {
        const key = keyOf(uri, start, end);
        if (spans.has(key) || inFlight.has(key)) return false;
        inFlight.add(key);
        try {
            const response = await fetch(uri, { headers: { Range: `bytes=${start}-${end}` }, cache: 'no-store' });
            if (response.status !== 206) return false;
            const headers: Record<string, string> = {};
            response.headers.forEach((value, name) => { headers[name] = value; });
            storeSpan(uri, start, end, await response.arrayBuffer(), headers);
            return true;
        } catch {
            return false;
        } finally {
            inFlight.delete(key);
        }
    }));
    return fetched.filter(Boolean).length;
}

/** The slice of Shaka's networking API the plugin needs. */
interface ShakaNetworking {
    net: {
        NetworkingEngine: {
            registerScheme(scheme: string, plugin: unknown, priority?: number, progressSupport?: boolean): void;
            RequestType: { SEGMENT: number };
            PluginPriority: { APPLICATION: number };
        };
        HttpFetchPlugin: {
            parse(uri: string, request: ShakaRequest, requestType: number, progressUpdated: unknown,
                headersReceived: unknown, config: unknown): unknown;
        };
    };
    util: { AbortableOperation: { completed(value: unknown): unknown } };
}

interface ShakaRequest {
    headers: Record<string, string>;
}

let installed = false;

/**
 * Answer segment requests from the cache before the network. Installed once
 * per page; every request it does not hold goes to Shaka's own fetch plugin
 * unchanged. `fromCache` keeps the instant answer out of the bandwidth
 * estimate — it says nothing about the link.
 */
export function installJumpCache(shaka: ShakaNetworking): void {
    if (installed) return;
    installed = true;
    const { NetworkingEngine, HttpFetchPlugin } = shaka.net;
    const plugin = (uri: string, request: ShakaRequest, requestType: number, progressUpdated: unknown,
        headersReceived: unknown, config: unknown) => {
        if (requestType === NetworkingEngine.RequestType.SEGMENT) {
            const hit = takeSpan(uri, request.headers.Range ?? request.headers.range);
            if (hit) {
                return shaka.util.AbortableOperation.completed({
                    uri, originalUri: uri, originalRequest: request, data: hit.data,
                    headers: hit.headers, status: 206, fromCache: true,
                });
            }
        }
        return HttpFetchPlugin.parse(uri, request, requestType, progressUpdated, headersReceived, config);
    };
    for (const scheme of ['http', 'https']) {
        NetworkingEngine.registerScheme(scheme, plugin, NetworkingEngine.PluginPriority.APPLICATION, true);
    }
}
