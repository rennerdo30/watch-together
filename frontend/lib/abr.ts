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
 * does the same by default ("dead time" removal). Only subtract latency
 * when the remaining transfer interval is measurable: otherwise an origin
 * that delivers a buffered body with its headers looks arbitrarily fast.
 */

import { ABR_CACHE_LOAD_THRESHOLD_MS, SHAKA_ABR_MIN_SAMPLE_BYTES, SHAKA_ABR_MIN_TOTAL_BYTES } from './constants';

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
 * a cache hit. If the body arrived with its headers, retain the original
 * elapsed time: a synthetic minimum would fabricate a fast transfer.
 */
export function sampleTimeMs(deltaTimeMs: number, request: SampledRequest | undefined): number {
    if (!Number.isFinite(deltaTimeMs) || deltaTimeMs < ABR_CACHE_LOAD_THRESHOLD_MS) return deltaTimeMs;
    const timeToFirstByte = request?.timeToFirstByte;
    if (timeToFirstByte == null || !Number.isFinite(timeToFirstByte) || timeToFirstByte <= 0) {
        return deltaTimeMs;
    }
    const packetNumber = request?.packetNumber;
    if (packetNumber != null && packetNumber > 1) return deltaTimeMs;
    const transferTimeMs = deltaTimeMs - timeToFirstByte;
    return transferTimeMs >= ABR_CACHE_LOAD_THRESHOLD_MS ? transferTimeMs : deltaTimeMs;
}

/** The methods used to sample and read Shaka's bandwidth estimator. */
export interface AbrManagerLike {
    getBandwidthEstimate(): number;
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
export function latencyAwareAbrFactory(shaka: ShakaAbrModule, onEstimate: (bps: number) => void): () => AbrManagerLike {
    class LatencyAwareAbrManager extends shaka.abr.SimpleAbrManager {
        private measuredBytes = 0;

        segmentDownloaded(
            deltaTimeMs: number,
            numBytes: number,
            allowSwitch: boolean,
            request?: SampledRequest,
            context?: unknown,
        ): void {
            const sampleMs = sampleTimeMs(deltaTimeMs, request);
            super.segmentDownloaded(sampleMs, numBytes, allowSwitch, request, context);
            // Until these thresholds are met, Shaka returns the opening guess.
            // Saving it would repeatedly discount memory without new evidence.
            if (Number.isFinite(sampleMs) && sampleMs >= ABR_CACHE_LOAD_THRESHOLD_MS &&
                Number.isFinite(numBytes) && numBytes >= SHAKA_ABR_MIN_SAMPLE_BYTES) {
                this.measuredBytes += numBytes;
                if (this.measuredBytes >= SHAKA_ABR_MIN_TOTAL_BYTES) {
                    onEstimate(this.getBandwidthEstimate());
                }
            }
        }
    }
    return () => new LatencyAwareAbrManager();
}
