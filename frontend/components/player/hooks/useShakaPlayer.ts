'use client';

import { useRef, useEffect, useCallback, useState } from 'react';

import { startPlayback, type PlaybackStart } from '@/lib/playback';
import { latencyAwareAbrFactory, autoQualityCap } from '@/lib/abr';
import { readOpeningEstimate, rememberBandwidth, sessionHighWater } from '@/lib/bandwidth-memory';
import { capHeadroom, DEFAULT_QUALITY_MODE, type QualityMode } from '@/lib/quality-mode';
import {
    PLAYER_STATS_REFRESH_MS,
    SHAKA_CACHE_LOAD_THRESHOLD_MS,
    SHAKA_SEGMENT_PREFETCH_LIMIT,
    SHAKA_SWITCH_SAFE_MARGIN_SECONDS,
    SHAKA_BUFFER_GOAL_SECONDS,
    SHAKA_BUFFER_BEHIND_SECONDS,
    SHAKA_REBUFFER_GOAL_SECONDS,
    SHAKA_SWITCH_INTERVAL_SECONDS,
    SHAKA_ABR_FAST_HALF_LIFE,
    SHAKA_ABR_SLOW_HALF_LIFE,
    SHAKA_ABR_MIN_SAMPLE_BYTES,
    SHAKA_ABR_MIN_TOTAL_BYTES,
    BANDWIDTH_MEMORY_SAVE_INTERVAL_MS,
    SHAKA_SEGMENT_RETRIES,
    SHAKA_RETRY_BASE_DELAY_MS,
    SHAKA_REQUEST_TIMEOUT_MS,
    SHAKA_PREFERRED_VIDEO_CODECS,
} from '@/lib/constants';

/**
 * DASH playback through a single media element.
 *
 * The adaptive video and audio tracks are described by a manifest and
 * fed to one <video> element via Media Source Extensions, so the browser
 * muxes them against one clock. That removes the class of problem the
 * two-element approach had to manage by hand: independent media clocks
 * drift apart, and no amount of correction makes them frame-accurate.
 *
 * Shaka is loaded on demand so its bundle only reaches viewers who play
 * an adaptive stream.
 */

export interface ShakaQualityLevel {
    height: number;
    width: number;
    bitrate: number;
    /** Shaka track id; named `index` to match the player controls contract. */
    index: number;
}

export interface ShakaStats {
    /** Declared bitrate of the active variant, in bits per second. */
    bandwidth: number;
    /** Height of the active variant, or 0 before one is chosen. */
    height: number;
    /**
     * The measured bandwidth estimate, in bits per second — what the ABR
     * logic actually decides on. Zero until enough has been measured; until
     * then Shaka cannot switch at all and is still on its opening guess,
     * which is why `estimateIsMeasured` is reported beside it.
     */
    estimateBps: number;
    estimateIsMeasured: boolean;
    /** Tallest rung auto may pick, or null when the mode allows any. */
    autoCap: number | null;
    /** The drawing surface the cap was computed from, in device pixels. */
    surfacePx: number;
    /** Device pixel ratio at that moment; it can change without a resize. */
    pixelRatio: number;
    /** Frames the decoder dropped, as a fraction of those it was given. */
    droppedFrames: number;
    /** Rungs this viewer's manifest actually offered. */
    ladderRungs: number;
    videoCodec: string;
    audioCodec: string;
}

export interface UseShakaPlayerOptions {
    videoRef: React.RefObject<HTMLVideoElement | null>;
    /** Manifest URL. Ignored while `enabled` is false. */
    manifestUrl: string;
    enabled: boolean;
    /** What this viewer wants auto quality to optimise for. */
    qualityMode?: QualityMode;
    autoPlay?: boolean;
    initialTime?: number;
    onError?: (error: string) => void;
    /** The CDN refused the stream URLs (403/410): they need re-resolving. */
    onSourceExpired?: () => Promise<void>;
    onLoadingChange?: (isLoading: boolean) => void;
    onBufferingChange?: (isBuffering: boolean) => void;
    /** How autoplay actually went; see `lib/playback`. */
    onPlaybackStart?: (outcome: PlaybackStart) => void;
}

export interface UseShakaPlayerReturn {
    isLoading: boolean;
    isBuffering: boolean;
    qualities: ShakaQualityLevel[];
    /** Selected track id, or -1 when quality is chosen automatically. */
    currentQuality: number;
    stats: ShakaStats;
    setQuality: (index: number) => void;
    isSupported: boolean;
}

const EMPTY_STATS: ShakaStats = {
    bandwidth: 0,
    height: 0,
    estimateBps: 0,
    estimateIsMeasured: false,
    autoCap: null,
    surfacePx: 0,
    pixelRatio: 0,
    droppedFrames: 0,
    ladderRungs: 0,
    videoCodec: '',
    audioCodec: '',
};

export const AUTO_QUALITY = -1;

/**
 * The slice of Shaka's API this hook uses.
 *
 * Shaka ships its own types, but they are only resolvable once the
 * library is dynamically imported. Describing the handful of members
 * used here keeps the hook type-checked without loading the library at
 * build time.
 */
interface ShakaVariantTrack {
    id: number;
    active: boolean;
    // Shaka reports absent values as null rather than undefined.
    height?: number | null;
    width?: number | null;
    bandwidth?: number | null;
    videoCodec?: string | null;
    audioCodec?: string | null;
}

interface ShakaBufferingEvent {
    buffering: boolean;
}

interface ShakaErrorDetail {
    code?: number;
    category?: number;
    severity?: number;
    data?: unknown[];
}

interface ShakaErrorEvent {
    detail?: ShakaErrorDetail;
    code?: number;
}

/**
 * Shaka errors carry their meaning in numeric code/category/data fields.
 * The object itself stringifies to something useless once minified, so
 * those fields are read out explicitly — otherwise a production report
 * says only "Could not load manifest eA".
 */
function describeShakaError(error: unknown): string {
    const detail = error as ShakaErrorDetail | undefined;
    const parts = [
        `code=${detail?.code ?? 'unknown'}`,
        `category=${detail?.category ?? 'unknown'}`,
    ];
    if (Array.isArray(detail?.data) && detail.data.length > 0) {
        // data usually holds the offending URL and HTTP status.
        parts.push(`data=${detail.data.map((d) => String(d)).join(' | ').slice(0, 300)}`);
    }
    return parts.join(' ');
}

/** Shaka's BAD_HTTP_STATUS error, with the status in `data[1]`. */
const SHAKA_BAD_HTTP_STATUS = 1001;
const EXPIRED_SOURCE_STATUSES = new Set([403, 410]);

function isExpiredSourceError(detail: ShakaErrorDetail | undefined): boolean {
    if (!detail || detail.code !== SHAKA_BAD_HTTP_STATUS || !Array.isArray(detail.data)) return false;
    return EXPIRED_SOURCE_STATUSES.has(Number(detail.data[1]));
}

interface ShakaPlayerInstance {
    attach(video: HTMLMediaElement): Promise<void>;
    load(manifestUri: string, startTime?: number): Promise<void>;
    destroy(): Promise<void>;
    configure(config: Record<string, unknown>): void;
    getVariantTracks(): ShakaVariantTrack[];
    selectVariantTrack(track: ShakaVariantTrack, clearBuffer?: boolean): void;
    addEventListener(type: string, listener: (event: Event) => void): void;
    removeEventListener(type: string, listener: (event: Event) => void): void;
}

export function useShakaPlayer(options: UseShakaPlayerOptions): UseShakaPlayerReturn {
    const { videoRef, manifestUrl, enabled, qualityMode = DEFAULT_QUALITY_MODE } = options;

    const playerRef = useRef<ShakaPlayerInstance | null>(null);
    // The mode changes while a video plays; reading it through a ref keeps it
    // out of the effect's dependencies, which tear the player down.
    const qualityModeRef = useRef(qualityMode);
    // Set once the player is loaded, so a mode change can re-apply the cap
    // without reloading anything.
    const applyQualityCapRef = useRef<(() => void) | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [isBuffering, setIsBuffering] = useState(false);
    const [qualities, setQualities] = useState<ShakaQualityLevel[]>([]);
    const [currentQuality, setCurrentQuality] = useState(AUTO_QUALITY);
    const [stats, setStats] = useState<ShakaStats>(EMPTY_STATS);
    const [isSupported, setIsSupported] = useState(true);

    // Callbacks live in a ref so changing them never tears down playback.
    const callbackRefs = useRef(options);
    useEffect(() => {
        callbackRefs.current = options;
    });

    useEffect(() => {
        if (!enabled || !manifestUrl) return;
        const video = videoRef.current;
        if (!video) return;

        let cancelled = false;
        let player: ShakaPlayerInstance | null = null;
        let onProgress: (() => void) | undefined;
        let resizeObserver: ResizeObserver | null = null;
        let pixelRatioQuery: MediaQueryList | null = null;
        let onPixelRatioChange: () => void = () => { };
        // The best estimate this session reached, which is what gets
        // remembered; see `sessionHighWater`.
        let bestBandwidth: number | null = null;
        let lastEstimate = 0;

        const setLoading = (loading: boolean) => {
            if (cancelled) return;
            setIsLoading(loading);
            callbackRefs.current.onLoadingChange?.(loading);
        };

        const onBuffering = (event: Event) => {
            if (cancelled) return;
            const buffering = !!(event as Event & ShakaBufferingEvent).buffering;
            setIsBuffering(buffering);
            callbackRefs.current.onBufferingChange?.(buffering);
        };

        let expiryReported = false;
        const onErrorEvent = (event: Event) => {
            const shakaEvent = event as Event & ShakaErrorEvent;
            const detail = shakaEvent.detail ?? shakaEvent;
            console.error('[ShakaPlayer] Playback error:', describeShakaError(detail));
            if (cancelled) return;
            // A signed stream URL the CDN now refuses is not a playback
            // failure to show; it is a stale source to replace. One report
            // per load: the re-resolve swaps the manifest and remounts.
            if (isExpiredSourceError(detail) && callbackRefs.current.onSourceExpired && !expiryReported) {
                expiryReported = true;
                void callbackRefs.current.onSourceExpired().catch((error: unknown) => {
                    if (cancelled) return;
                    setLoading(false);
                    setIsBuffering(false);
                    callbackRefs.current.onBufferingChange?.(false);
                    callbackRefs.current.onError?.(error instanceof Error ? error.message : 'Could not refresh the stream.');
                });
                return;
            }
            setLoading(false);
            callbackRefs.current.onError?.(
                `Playback failed (${describeShakaError(detail)})`
            );
        };

        const onTracksChanged = () => {
            if (cancelled || !player) return;
            const variants = player.getVariantTracks();
            const seen = new Map<number, ShakaQualityLevel>();
            for (const track of variants) {
                if (!track.height) continue;
                const existing = seen.get(track.height);
                const bandwidth = track.bandwidth ?? 0;
                if (!existing || bandwidth > existing.bitrate) {
                    seen.set(track.height, {
                        height: track.height,
                        width: track.width ?? 0,
                        bitrate: bandwidth,
                        index: track.id,
                    });
                }
            }
            const levels = Array.from(seen.values()).sort((a, b) => b.height - a.height);
            setQualities(levels);

            const active = variants.find((track) => track.active);
            setStats((previous) => ({
                ...previous,
                bandwidth: active?.bandwidth ?? 0,
                height: active?.height ?? 0,
                ladderRungs: levels.length,
                videoCodec: active?.videoCodec ?? '',
                audioCodec: active?.audioCodec ?? '',
            }));
        };

        const setup = async () => {
            const shaka = (await import('shaka-player/dist/shaka-player.compiled.js')).default;
            if (cancelled) return;

            shaka.polyfill.installAll();
            if (!shaka.Player.isBrowserSupported()) {
                console.warn('[ShakaPlayer] Browser does not support MSE playback');
                setIsSupported(false);
                callbackRefs.current.onError?.('This browser cannot play adaptive streams');
                return;
            }

            // Held in a local const so it stays non-null across awaits.
            const instance: ShakaPlayerInstance = new shaka.Player();
            player = instance;
            playerRef.current = instance;
            await instance.attach(video);
            if (cancelled) return;

            instance.configure({
                streaming: {
                    bufferingGoal: SHAKA_BUFFER_GOAL_SECONDS,
                    rebufferingGoal: SHAKA_REBUFFER_GOAL_SECONDS,
                    bufferBehind: SHAKA_BUFFER_BEHIND_SECONDS,
                    // A minute of buffered media is a minute before a better
                    // rendition is seen; clear what is beyond the margin so a
                    // switch takes effect while the viewer is still wondering
                    // about it.
                    clearBufferSwitch: true,
                    safeMarginSwitch: SHAKA_SWITCH_SAFE_MARGIN_SECONDS,
                    // Keep the next fetches in flight instead of leaving the
                    // link idle for a round trip between segments.
                    segmentPrefetchLimit: SHAKA_SEGMENT_PREFETCH_LIMIT,
                    // Every segment crosses the viewer -> tunnel -> origin ->
                    // CDN path, so a request can legitimately take a while and
                    // an occasional failure is worth retrying rather than
                    // surfacing as a stall.
                    retryParameters: {
                        maxAttempts: SHAKA_SEGMENT_RETRIES,
                        baseDelay: SHAKA_RETRY_BASE_DELAY_MS,
                        backoffFactor: 2,
                        timeout: SHAKA_REQUEST_TIMEOUT_MS,
                    },
                },
                // Stock variant selection fed with samples that exclude the
                // wait for each response's headers; see lib/abr.ts.
                abrFactory: latencyAwareAbrFactory(shaka, bps => {
                    lastEstimate = bps;
                    bestBandwidth = sessionHighWater(bestBandwidth, bps);
                }),
                abr: {
                    // Open on what this connection managed last time, or a
                    // conservative guess, and let measurements take over.
                    // Shaka's own default opens on the highest rendition,
                    // which stalls immediately on a long-haul link.
                    defaultBandwidthEstimate: readOpeningEstimate(),
                    // Chrome's navigator.connection.downlink is a coarse guess
                    // capped at 10 Mbps. With this on, Shaka takes it over the
                    // estimate above and throws away every measurement each
                    // time the guess changes, which it does constantly.
                    useNetworkInformation: false,
                    // Auto quality is capped to the drawing surface plus a
                    // rung of bitrate headroom; see applyQualityCap below.
                    // Shaka's own restrictToElementSize allows no headroom.
                    switchInterval: SHAKA_SWITCH_INTERVAL_SECONDS,
                    cacheLoadThreshold: SHAKA_CACHE_LOAD_THRESHOLD_MS,
                    advanced: {
                        fastHalfLife: SHAKA_ABR_FAST_HALF_LIFE,
                        slowHalfLife: SHAKA_ABR_SLOW_HALF_LIFE,
                        minBytes: SHAKA_ABR_MIN_SAMPLE_BYTES,
                        minTotalBytes: SHAKA_ABR_MIN_TOTAL_BYTES,
                    },
                },
                // The player adapts within one codec family, so prefer the
                // one that carries the same picture in the fewest bits.
                preferredVideoCodecs: [...SHAKA_PREFERRED_VIDEO_CODECS],
            });

            instance.addEventListener('error', onErrorEvent);
            instance.addEventListener('buffering', onBuffering);
            instance.addEventListener('trackschanged', onTracksChanged);
            instance.addEventListener('adaptation', onTracksChanged);
            // Persist only fresh measurements, never Shaka's opening guess.
            let lastSavedAt = 0;
            let lastStatsAt = 0;
            onProgress = () => {
                if (cancelled) return;
                const now = Date.now();
                if (now - lastStatsAt >= PLAYER_STATS_REFRESH_MS) {
                    lastStatsAt = now;
                    const quality = video.getVideoPlaybackQuality?.();
                    const total = quality?.totalVideoFrames ?? 0;
                    setStats((previous) => ({
                        ...previous,
                        estimateBps: lastEstimate,
                        estimateIsMeasured: lastEstimate > 0,
                        droppedFrames: total > 0 ? (quality?.droppedVideoFrames ?? 0) / total : 0,
                    }));
                }
                if (video.paused || bestBandwidth === null) return;
                if (now - lastSavedAt < BANDWIDTH_MEMORY_SAVE_INTERVAL_MS) return;
                rememberBandwidth(bestBandwidth, now);
                lastSavedAt = now;
            };
            video.addEventListener('timeupdate', onProgress);

            setLoading(true);
            try {
                // Read at load time rather than as dependencies: these
                // describe where to *start*, and re-running this effect
                // means destroying the player and refetching the manifest.
                const startAt = callbackRefs.current.initialTime ?? 0;
                const shouldAutoPlay = callbackRefs.current.autoPlay ?? false;
                await instance.load(manifestUrl, startAt > 0 ? startAt : undefined);
                if (cancelled) return;
                onTracksChanged();
                // Cap auto quality to the surface plus the headroom this
                // viewer's mode allows, and follow the surface as the player
                // is resized or goes fullscreen. Manual picks are not
                // restricted.
                const applyQualityCap = () => {
                    if (cancelled) return;
                    const pixelRatio = window.devicePixelRatio || 1;
                    const surface = video.clientHeight * pixelRatio;
                    const headroom = capHeadroom(qualityModeRef.current);
                    const cap = headroom === null
                        ? null
                        : autoQualityCap(instance.getVariantTracks().map((track) => track.height ?? 0), surface, headroom);
                    if (headroom === null) {
                        // Not "leave it alone": a cap applied under another
                        // mode would otherwise outlive the switch to this one.
                        instance.configure({ abr: { restrictions: { maxHeight: Infinity } } });
                    } else if (cap !== null) {
                        instance.configure({ abr: { restrictions: { maxHeight: cap } } });
                    } else {
                        // Nothing measurable to cap against yet. The observer
                        // below fires when the element is finally laid out.
                        return;
                    }
                    setStats((previous) => ({ ...previous, autoCap: cap, surfacePx: surface, pixelRatio }));
                };
                applyQualityCapRef.current = applyQualityCap;
                applyQualityCap();
                resizeObserver = new ResizeObserver(applyQualityCap);
                resizeObserver.observe(video);
                // The pixel ratio can change with no CSS resize at all — a
                // window dragged to a monitor with different scaling keeps
                // its size in CSS pixels while every one of them is worth
                // more or fewer device pixels. The ResizeObserver never fires
                // for that, so the cap would stay computed for the old
                // screen. Each query only reports leaving its own ratio, so a
                // new one is armed after every change.
                const watchPixelRatio = () => {
                    pixelRatioQuery?.removeEventListener('change', onPixelRatioChange);
                    pixelRatioQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
                    pixelRatioQuery.addEventListener('change', onPixelRatioChange);
                };
                onPixelRatioChange = () => {
                    applyQualityCap();
                    watchPixelRatio();
                };
                watchPixelRatio();
                setLoading(false);

                if (shouldAutoPlay) {
                    video.muted = localStorage.getItem('w2g-player-muted') === 'true';
                    // The outcome is reported rather than logged: a viewer
                    // whose browser refuses to autoplay is left behind by the
                    // rest of the room, and only the UI can ask them for the
                    // gesture the browser is waiting for.
                    const outcome = await startPlayback(video);
                    if (!cancelled) callbackRefs.current.onPlaybackStart?.(outcome);
                }
            } catch (error: unknown) {
                if (cancelled) return;
                const described = describeShakaError(error);
                console.error('[ShakaPlayer] Could not load manifest:', described);
                setLoading(false);
                callbackRefs.current.onError?.(`The video could not be loaded (${described})`);
            }
        };

        setup();

        return () => {
            cancelled = true;
            if (onProgress) video.removeEventListener('timeupdate', onProgress);
            resizeObserver?.disconnect();
            pixelRatioQuery?.removeEventListener('change', onPixelRatioChange);
            applyQualityCapRef.current = null;
            const active = playerRef.current;
            playerRef.current = null;
            if (active) {
                active.removeEventListener('error', onErrorEvent);
                active.removeEventListener('buffering', onBuffering);
                active.removeEventListener('trackschanged', onTracksChanged);
                active.removeEventListener('adaptation', onTracksChanged);
                active.destroy().catch(() => {
                    // Destroying an already-torn-down player is not an error.
                });
            }
        };
        // Deliberately keyed on the stream alone. `autoPlay` follows the
        // room's play/pause state and `initialTime` follows the sync
        // position, so including either tore the player down and reloaded
        // the manifest on every pause, resume and seek — which both
        // rebuffered from zero and let a reload resume a paused room.
    }, [enabled, manifestUrl, videoRef]);

    // A mode change re-caps the running player; it never reloads anything.
    useEffect(() => {
        qualityModeRef.current = qualityMode;
        applyQualityCapRef.current?.();
    }, [qualityMode]);

    const setQuality = useCallback((index: number) => {
        const player = playerRef.current;
        if (!player) return;

        if (index === AUTO_QUALITY) {
            player.configure({ abr: { enabled: true } });
            setCurrentQuality(AUTO_QUALITY);
            return;
        }

        const track = player.getVariantTracks().find((t) => t.id === index);
        if (!track) return;

        player.configure({ abr: { enabled: false } });
        player.selectVariantTrack(track, /* clearBuffer */ true);
        setCurrentQuality(index);
    }, []);

    return {
        isLoading,
        isBuffering,
        qualities,
        currentQuality,
        stats,
        setQuality,
        isSupported,
    };
}
