/**
 * Latency-aware bandwidth sampling for Shaka's adaptive bitrate logic.
 *
 * Every segment travels viewer -> Cloudflare -> tunnel -> origin -> CDN, so
 * a request waits several hundred milliseconds before its first byte
 * arrives. Shaka hands the ABR manager one sample per progress event, and
 * the first event of each request is timed from the moment the request was
 * sent, so the whole wait is charged against the handful of bytes that
 * event carried. Small segments — exactly what a low rendition produces —
 * are dominated by that wait, so the estimate stays low and the player
 * never learns that a higher rendition would stream comfortably. Manual
 * 1080p playing fine while auto sits at 360p is this trap.
 *
 * The correction subtracts the time to first byte from the first sample of
 * each request, leaving the time the bytes actually took to arrive. dash.js
 * does the same by default ("dead time" removal). Latency is absorbed by
 * the buffer, not by picking a worse rendition.
 */

import { ABR_CACHE_LOAD_THRESHOLD_MS } from './constants';

/** The fields of a Shaka request the sampler reads. */
export interface SampledRequest {
    /** 1-based progress-event counter within one request attempt. */
    packetNumber?: number | null;
    /** Milliseconds from sending the request until its headers arrived. */
    timeToFirstByte?: number | null;
}

/**
 * The time a sample should be charged with, in milliseconds.
 *
 * Only the first progress event of a request includes the wait for headers;
 * later events measure pure transfer and pass through unchanged. A sample
 * already under the cache threshold passes through so Shaka can drop it as
 * a cache hit, and one whose body arrived with its headers is floored at
 * that threshold so it yields a large but finite throughput.
 */
export function sampleTimeMs(deltaTimeMs: number, request: SampledRequest | undefined): number {
    if (!Number.isFinite(deltaTimeMs) || deltaTimeMs < ABR_CACHE_LOAD_THRESHOLD_MS) return deltaTimeMs;
    const timeToFirstByte = request?.timeToFirstByte;
    if (timeToFirstByte == null || !Number.isFinite(timeToFirstByte) || timeToFirstByte <= 0) {
        return deltaTimeMs;
    }
    const packetNumber = request?.packetNumber;
    if (packetNumber != null && packetNumber > 1) return deltaTimeMs;
    return Math.max(deltaTimeMs - timeToFirstByte, ABR_CACHE_LOAD_THRESHOLD_MS);
}

/** The one method of Shaka's ABR manager this module overrides. */
export interface AbrManagerLike {
    segmentDownloaded(
        deltaTimeMs: number,
        numBytes: number,
        allowSwitch: boolean,
        request?: SampledRequest,
        context?: unknown,
    ): void;
}

/** The slice of the Shaka module the factory needs. */
export interface ShakaAbrModule {
    abr: { SimpleAbrManager: new () => AbrManagerLike };
}

/**
 * An `abrFactory` producing Shaka's default manager with latency-aware
 * sampling. Everything else — variant choice, switch timing, restrictions —
 * is the stock implementation.
 */
export function latencyAwareAbrFactory(shaka: ShakaAbrModule): () => AbrManagerLike {
    class LatencyAwareAbrManager extends shaka.abr.SimpleAbrManager {
        segmentDownloaded(
            deltaTimeMs: number,
            numBytes: number,
            allowSwitch: boolean,
            request?: SampledRequest,
            context?: unknown,
        ): void {
            super.segmentDownloaded(sampleTimeMs(deltaTimeMs, request), numBytes, allowSwitch, request, context);
        }
    }
    return () => new LatencyAwareAbrManager();
}
