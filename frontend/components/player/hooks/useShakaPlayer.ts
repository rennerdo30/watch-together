'use client';

import { useRef, useEffect, useCallback, useState } from 'react';

import { startPlayback, type PlaybackStart } from '@/lib/playback';
import {
    autoQualityCap,
    latencyAwareAbrFactory,
    openingPlan,
    type CodecFamily,
    type LadderRung,
} from '@/lib/abr';
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
    DASH_MIME_TYPE,
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

export interface ShakaAudioTrack {
    index: number;
    language: string;
    label: string;
    isOriginal: boolean;
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

/**
 * The video the room is expected to play next, for the player to preload:
 * manifest, segment index, initialisation segment and the first media
 * segments at `startTime`, so that the advance starts from bytes already in
 * the page instead of a round trip to Germany for each of them.
 */
export interface ShakaPreloadTarget {
    /** The page the video came from, to name it to the server. */
    originalUrl: string;
    manifestUrl: string;
    /** Where the room will start it: its resume position, or 0. */
    startTime: number;
    /** Its rungs, from the resolve, to cap the preload's opening rung. */
    ladder: readonly LadderRung[];
}

/** What a load or preload is about to fetch, announced just before it does. */
export interface ShakaLoadPlan {
    kind: 'load' | 'preload';
    /** The page the video came from, as the server knows it. */
    originalUrl?: string;
    manifestUrl: string;
    startTime: number;
    /** The rung it is expected to open on; see `openingPlan`. */
    height: number;
    codec?: CodecFamily;
}

export interface UseShakaPlayerOptions {
    videoRef: React.RefObject<HTMLVideoElement | null>;
    /** Manifest URL. Ignored while `enabled` is false. */
    manifestUrl: string;
    /** The page the video at `manifestUrl` came from. */
    originalUrl?: string;
    enabled: boolean;
    /**
     * The rungs of the video at `manifestUrl`, from its resolve. The opening
     * rung is chosen before the manifest has even been parsed, so the cap
     * has to come from here rather than from the player's tracks.
     */
    ladder?: readonly LadderRung[];
    /** The video expected next, or null when there is nothing to prepare. */
    preload?: ShakaPreloadTarget | null;
    /** What auto quality should optimise for. */
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
    /** Called right before a load or preload starts fetching. */
    onLoadPlan?: (plan: ShakaLoadPlan) => void;
    /** The current load has its manifest; `preloaded` when it came from a preload. */
    onManifestReady?: (preloaded: boolean) => void;
}

export interface UseShakaPlayerReturn {
    isLoading: boolean;
    isBuffering: boolean;
    qualities: ShakaQualityLevel[];
    audioTracks: ShakaAudioTrack[];
    currentAudioTrack: number;
    /** Selected track id, or -1 when quality is chosen automatically. */
    currentQuality: number;
    stats: ShakaStats;
    setQuality: (index: number) => void;
    setAudioTrack: (index: number) => void;
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

interface ShakaVideoTrack {
    active: boolean;
    height?: number | null;
    width?: number | null;
    bandwidth?: number | null;
}

interface ShakaAudioTrackInternal {
    active: boolean;
    language: string;
    label?: string | null;
    roles: string[];
    primary: boolean;
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

interface ShakaPreloadManager {
    destroy(): Promise<void>;
    /** Settles when the preload has fetched all it will, or failed. */
    waitForFinish(): Promise<void>;
}

interface ShakaPlayerInstance {
    attach(video: HTMLMediaElement): Promise<void>;
    load(asset: string | ShakaPreloadManager, startTime?: number | null, mimeType?: string): Promise<void>;
    preload(asset: string, startTime?: number | null, mimeType?: string, config?: Record<string, unknown>): Promise<ShakaPreloadManager | null>;
    destroy(): Promise<void>;
    configure(config: Record<string, unknown>): void;
    getConfiguration(): { abr: { restrictions: { maxHeight: number } } } & Record<string, unknown>;
    getVariantTracks(): ShakaVariantTrack[];
    getVideoTracks(): ShakaVideoTrack[];
    selectVideoTrack(track: ShakaVideoTrack, clearBuffer?: boolean): void;
    getAudioTracks(): ShakaAudioTrackInternal[];
    selectAudioTrack(track: ShakaAudioTrackInternal): void;
    addEventListener(type: string, listener: (event: Event) => void): void;
    removeEventListener(type: string, listener: (event: Event) => void): void;
}

/** A preload in flight or ready, and what it was started for. */
interface PendingPreload {
    manifestUrl: string;
    startTime: number;
    manager: Promise<ShakaPreloadManager | null>;
}

/** Shaka's code for a load that a newer load or an unload interrupted. */
const SHAKA_LOAD_INTERRUPTED = 7000;

const destroyPreload = (pending: PendingPreload | null) => {
    if (!pending) return;
    void pending.manager
        .then((manager) => manager?.destroy())
        .catch(() => {
            // A preload that failed or was already consumed has nothing left.
        });
};

/**
 * The auto-quality cap for a ladder on this element, under this mode.
 *
 * `headroom === null` is "no cap at all" (the Highest mode), which callers
 * must apply by clearing a cap already in place; `cap === null` with a
 * headroom means nothing measurable to cap against yet.
 */
function capForLadder(video: HTMLVideoElement, heights: readonly number[], mode: QualityMode) {
    const pixelRatio = window.devicePixelRatio || 1;
    const surface = video.clientHeight * pixelRatio;
    const headroom = capHeadroom(mode);
    const cap = headroom === null ? null : autoQualityCap(heights, surface, headroom);
    return { cap, headroom, surface, pixelRatio };
}

export function useShakaPlayer(options: UseShakaPlayerOptions): UseShakaPlayerReturn {
    const { videoRef, manifestUrl, enabled, qualityMode = DEFAULT_QUALITY_MODE } = options;
    const preloadUrl = options.preload?.manifestUrl ?? '';
    const preloadStart = options.preload?.startTime ?? 0;

    // The player outlives the videos it plays: one instance, attached to one
    // element, loads each new manifest in place. Destroying it per video —
    // which a remount per video did — threw away the preload of the next
    // entry, the bandwidth estimate, and the MediaSource, and made every
    // advance start from nothing.
    const [player, setPlayer] = useState<ShakaPlayerInstance | null>(null);
    // The manifest the player has finished loading; a preload waits for it,
    // so it never competes with the start of the video on screen.
    const [loadedUrl, setLoadedUrl] = useState('');
    // Bumped to load the same manifest again: after a re-resolve replaced
    // stream URLs the CDN stopped serving, the manifest address is unchanged
    // but what it describes is not, so nothing else would reload it.
    const [reloadCount, setReloadCount] = useState(0);
    // Where that reload resumes: the position the stale source died at.
    const reloadAtRef = useRef<number | null>(null);
    const preloadRef = useRef<PendingPreload | null>(null);
    // The mode changes while a video plays; reading it through a ref keeps it
    // out of the effects' dependencies, which reload the video.
    const qualityModeRef = useRef(qualityMode);
    // Set once the player exists, so a mode change can re-apply the cap
    // without reloading anything.
    const applyQualityCapRef = useRef<(() => void) | null>(null);
    // Per-load facts the player's event handlers need.
    const loadingRef = useRef(false);
    const expiryReportedRef = useRef(false);
    const manifestReportedRef = useRef(true);
    const lastEstimateRef = useRef(0);
    const [isLoading, setIsLoading] = useState(false);
    const [isBuffering, setIsBuffering] = useState(false);
    const [qualities, setQualities] = useState<ShakaQualityLevel[]>([]);
    const [audioTracks, setAudioTracks] = useState<ShakaAudioTrack[]>([]);
    const [currentAudioTrack, setCurrentAudioTrack] = useState(-1);
    const [currentQuality, setCurrentQuality] = useState(AUTO_QUALITY);
    const manualHeightRef = useRef<number | null>(null);
    const [stats, setStats] = useState<ShakaStats>(EMPTY_STATS);
    const [isSupported, setIsSupported] = useState(true);

    // Callbacks live in a ref so changing them never tears down playback.
    const callbackRefs = useRef(options);
    useEffect(() => {
        callbackRefs.current = options;
    });

    const readTracks = useCallback((instance: ShakaPlayerInstance) => {
        const variants = instance.getVariantTracks();
        const videoTracks = instance.getVideoTracks();
        const seen = new Map<number, ShakaQualityLevel>();
        for (const [index, track] of videoTracks.entries()) {
            if (!track.height) continue;
            const existing = seen.get(track.height);
            const bandwidth = track.bandwidth ?? 0;
            if (!existing || bandwidth > existing.bitrate) {
                seen.set(track.height, {
                    height: track.height,
                    width: track.width ?? 0,
                    bitrate: bandwidth,
                    index,
                });
            }
        }
        const levels = Array.from(seen.values()).sort((a, b) => b.height - a.height);
        setQualities(levels);
        setCurrentQuality(manualHeightRef.current === null
            ? AUTO_QUALITY
            : levels.find((level) => level.height === manualHeightRef.current)?.index ?? AUTO_QUALITY);

        const availableAudio = instance.getAudioTracks();
        setAudioTracks(availableAudio.map((track, index) => ({
            index,
            language: track.language,
            label: track.label ?? '',
            isOriginal: track.roles.includes('main') || track.primary,
        })));
        setCurrentAudioTrack(availableAudio.findIndex((track) => track.active));

        const active = variants.find((track) => track.active);
        setStats((previous) => ({
            ...previous,
            bandwidth: active?.bandwidth ?? 0,
            height: active?.height ?? 0,
            ladderRungs: levels.length,
            videoCodec: active?.videoCodec ?? '',
            audioCodec: active?.audioCodec ?? '',
        }));
    }, []);

    // === THE PLAYER: created once per element, destroyed with it ===
    useEffect(() => {
        if (!enabled) return;
        const video = videoRef.current;
        if (!video) return;

        let cancelled = false;
        let instance: ShakaPlayerInstance | null = null;
        let onProgress: (() => void) | undefined;
        let resizeObserver: ResizeObserver | null = null;
        let pixelRatioQuery: MediaQueryList | null = null;
        let onPixelRatioChange: () => void = () => { };
        // The best estimate this session reached, which is what gets
        // remembered; see `sessionHighWater`.
        let bestBandwidth: number | null = null;

        const onBuffering = (event: Event) => {
            if (cancelled) return;
            const buffering = !!(event as Event & ShakaBufferingEvent).buffering;
            setIsBuffering(buffering);
            callbackRefs.current.onBufferingChange?.(buffering);
        };

        const stopLoading = () => {
            loadingRef.current = false;
            setIsLoading(false);
            callbackRefs.current.onLoadingChange?.(false);
        };

        const onErrorEvent = (event: Event) => {
            const shakaEvent = event as Event & ShakaErrorEvent;
            const detail = shakaEvent.detail ?? shakaEvent;
            console.error('[ShakaPlayer] Playback error:', describeShakaError(detail));
            if (cancelled) return;
            // A signed stream URL the CDN now refuses is not a playback
            // failure to show; it is a stale source to replace. One report
            // per load: once the re-resolve is in, the manifest (same
            // address, fresh URLs inside) is loaded again where it stopped.
            if (isExpiredSourceError(detail) && callbackRefs.current.onSourceExpired && !expiryReportedRef.current) {
                expiryReportedRef.current = true;
                const stoppedAt = videoRef.current?.currentTime ?? 0;
                void callbackRefs.current.onSourceExpired().then(() => {
                    if (cancelled) return;
                    reloadAtRef.current = stoppedAt;
                    setReloadCount((count) => count + 1);
                }).catch((error: unknown) => {
                    if (cancelled) return;
                    stopLoading();
                    setIsBuffering(false);
                    callbackRefs.current.onBufferingChange?.(false);
                    callbackRefs.current.onError?.(error instanceof Error ? error.message : 'Could not refresh the stream.');
                });
                return;
            }
            stopLoading();
            callbackRefs.current.onError?.(
                `Playback failed (${describeShakaError(detail)})`
            );
        };

        const onTracksChanged = () => {
            if (cancelled || !instance) return;
            readTracks(instance);
        };

        const onManifestParsed = () => {
            if (cancelled || manifestReportedRef.current) return;
            manifestReportedRef.current = true;
            callbackRefs.current.onManifestReady?.(false);
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
            const created = new shaka.Player() as unknown as ShakaPlayerInstance;
            instance = created;
            await created.attach(video);
            if (cancelled) {
                void created.destroy().catch(() => { });
                return;
            }

            created.configure({
                streaming: {
                    bufferingGoal: SHAKA_BUFFER_GOAL_SECONDS,
                    rebufferingGoal: SHAKA_REBUFFER_GOAL_SECONDS,
                    bufferBehind: SHAKA_BUFFER_BEHIND_SECONDS,
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
                    lastEstimateRef.current = bps;
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
                    // rung of bitrate headroom; see the load below.
                    // Shaka's own restrictToElementSize allows no headroom.
                    switchInterval: SHAKA_SWITCH_INTERVAL_SECONDS,
                    // A minute of buffered media is a minute before a better
                    // rendition is seen; clear what is beyond the margin so a
                    // switch takes effect while the viewer is still wondering
                    // about it. These live under `abr` since Shaka 5: under
                    // `streaming` they were rejected as unknown keys and the
                    // switch waited behind the whole buffer.
                    clearBufferSwitch: true,
                    safeMarginSwitch: SHAKA_SWITCH_SAFE_MARGIN_SECONDS,
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
                // (`preferredVideoCodecs` is deprecated since Shaka 5.)
                preferredVideo: SHAKA_PREFERRED_VIDEO_CODECS.map((codec) => ({
                    label: '', role: '', language: '', codec, hdrLevel: '', layout: '',
                })),
            });

            created.addEventListener('error', onErrorEvent);
            created.addEventListener('buffering', onBuffering);
            created.addEventListener('trackschanged', onTracksChanged);
            created.addEventListener('adaptation', onTracksChanged);
            created.addEventListener('variantchanged', onTracksChanged);
            created.addEventListener('manifestparsed', onManifestParsed);
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
                    const estimate = lastEstimateRef.current;
                    setStats((previous) => ({
                        ...previous,
                        estimateBps: estimate,
                        estimateIsMeasured: estimate > 0,
                        droppedFrames: total > 0 ? (quality?.droppedVideoFrames ?? 0) / total : 0,
                    }));
                }
                if (video.paused || bestBandwidth === null) return;
                if (now - lastSavedAt < BANDWIDTH_MEMORY_SAVE_INTERVAL_MS) return;
                rememberBandwidth(bestBandwidth, now);
                lastSavedAt = now;
            };
            video.addEventListener('timeupdate', onProgress);

            // Cap auto quality to the surface plus the headroom this viewer's
            // mode allows, and follow the surface as the player is resized or
            // goes fullscreen. Manual picks are not restricted. While a load
            // is under way the tracks still describe the previous video; the
            // load applies its own cap before it starts and re-applies this
            // once it is done.
            const applyQualityCap = () => {
                if (cancelled || loadingRef.current) return;
                const { cap, headroom, surface, pixelRatio } = capForLadder(
                    video, created.getVariantTracks().map((track) => track.height ?? 0), qualityModeRef.current);
                if (headroom === null) {
                    // Not "leave it alone": a cap applied under another
                    // mode would otherwise outlive the switch to this one.
                    created.configure({ abr: { restrictions: { maxHeight: Infinity } } });
                } else if (cap !== null) {
                    created.configure({ abr: { restrictions: { maxHeight: cap } } });
                } else {
                    // Nothing measurable to cap against yet. The observer
                    // below fires when the element is finally laid out.
                    return;
                }
                setStats((previous) => ({ ...previous, autoCap: cap, surfacePx: surface, pixelRatio }));
            };
            applyQualityCapRef.current = applyQualityCap;
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

            setPlayer(created);
        };

        void setup();

        return () => {
            cancelled = true;
            if (onProgress) video.removeEventListener('timeupdate', onProgress);
            resizeObserver?.disconnect();
            pixelRatioQuery?.removeEventListener('change', onPixelRatioChange);
            applyQualityCapRef.current = null;
            destroyPreload(preloadRef.current);
            preloadRef.current = null;
            loadingRef.current = false;
            setPlayer(null);
            setLoadedUrl('');
            if (instance) {
                instance.removeEventListener('error', onErrorEvent);
                instance.removeEventListener('buffering', onBuffering);
                instance.removeEventListener('trackschanged', onTracksChanged);
                instance.removeEventListener('adaptation', onTracksChanged);
                instance.removeEventListener('variantchanged', onTracksChanged);
                instance.removeEventListener('manifestparsed', onManifestParsed);
                instance.destroy().catch(() => {
                    // Destroying an already-torn-down player is not an error.
                });
            }
        };
    }, [enabled, videoRef, readTracks]);

    // === EACH VIDEO: loaded into the same player ===
    useEffect(() => {
        if (!player || !manifestUrl) return;
        const video = videoRef.current;
        if (!video) return;
        let cancelled = false;

        // Everything below describes one video; none of it may leak into
        // the next. A manual rung pick is per video too: it switched the
        // player's automatic choice off, which the next video must not
        // inherit.
        loadingRef.current = true;
        expiryReportedRef.current = false;
        manifestReportedRef.current = false;
        setIsLoading(true);
        callbackRefs.current.onLoadingChange?.(true);
        setIsBuffering(false);
        setQualities([]);
        setAudioTracks([]);
        setCurrentAudioTrack(-1);
        manualHeightRef.current = null;
        setCurrentQuality(AUTO_QUALITY);
        setStats((previous) => ({
            ...EMPTY_STATS,
            estimateBps: previous.estimateBps,
            estimateIsMeasured: previous.estimateIsMeasured,
        }));
        player.configure({ abr: { enabled: true } });

        // Read at load time rather than as dependencies: these describe
        // where to *start*, and re-running this effect means reloading the
        // video. `autoPlay` follows the room's play/pause state and
        // `initialTime` its position, so keying on either reloaded the
        // manifest on every pause, resume and seek.
        const startAt = reloadAtRef.current ?? callbackRefs.current.initialTime ?? 0;
        reloadAtRef.current = null;
        const shouldAutoPlay = callbackRefs.current.autoPlay ?? false;
        const ladder = callbackRefs.current.ladder ?? [];

        // The cap goes in before the load. Shaka picks the opening rung
        // before its load resolves — before `manifestparsed` is even
        // dispatched — so a cap applied afterwards only arrives once the
        // first segments of an uncapped rung (4K AV1 for a returning fast
        // viewer: 13–28 MB each) are already on their way.
        const { cap, headroom, surface, pixelRatio } = capForLadder(
            video, ladder.map((rung) => rung.height), qualityModeRef.current);
        if (headroom === null) {
            player.configure({ abr: { restrictions: { maxHeight: Infinity } } });
        } else if (cap !== null) {
            player.configure({ abr: { restrictions: { maxHeight: cap } } });
            setStats((previous) => ({ ...previous, autoCap: cap, surfacePx: surface, pixelRatio }));
        }

        // The preload of this very video, if the room got here the way it
        // was expected to. Claimed before anything else can destroy it.
        const pending = preloadRef.current?.manifestUrl === manifestUrl ? preloadRef.current : null;
        if (pending) preloadRef.current = null;

        const plan = openingPlan(ladder, headroom === null ? null : cap,
            lastEstimateRef.current > 0 ? lastEstimateRef.current : readOpeningEstimate());
        if (plan) {
            callbackRefs.current.onLoadPlan?.({
                kind: 'load', originalUrl: callbackRefs.current.originalUrl, manifestUrl, startTime: startAt, ...plan,
            });
        }

        const run = async () => {
            try {
                const manager = pending ? await pending.manager.catch(() => null) : null;
                if (cancelled) {
                    if (manager) void manager.destroy().catch(() => { });
                    return;
                }
                if (manager) {
                    manifestReportedRef.current = true;
                    callbackRefs.current.onManifestReady?.(true);
                }
                await player.load(manager ?? manifestUrl, startAt > 0 ? startAt : null, DASH_MIME_TYPE);
                if (cancelled) return;
                loadingRef.current = false;
                readTracks(player);
                applyQualityCapRef.current?.();
                setIsLoading(false);
                callbackRefs.current.onLoadingChange?.(false);
                setLoadedUrl(manifestUrl);

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
                // Superseded by the next video's load: not a failure of either.
                if ((error as ShakaErrorDetail | undefined)?.code === SHAKA_LOAD_INTERRUPTED) return;
                const described = describeShakaError(error);
                console.error('[ShakaPlayer] Could not load manifest:', described);
                loadingRef.current = false;
                setIsLoading(false);
                callbackRefs.current.onLoadingChange?.(false);
                callbackRefs.current.onError?.(`The video could not be loaded (${described})`);
            }
        };

        void run();

        return () => {
            cancelled = true;
        };
        // Deliberately keyed on the player and the stream alone; see above.
    }, [player, manifestUrl, reloadCount, videoRef, readTracks]);

    // === THE NEXT VIDEO: preloaded while this one finishes ===
    useEffect(() => {
        const current = preloadRef.current;
        const wanted = !!player && !!preloadUrl && preloadUrl !== manifestUrl;
        // A preload for anything but the expected next video is stale: the
        // queue changed, the room skipped, or there is no next entry now.
        if (current && (!wanted || current.manifestUrl !== preloadUrl || current.startTime !== preloadStart)) {
            destroyPreload(current);
            preloadRef.current = null;
        }
        if (!wanted || preloadRef.current) return;
        // Not while the video on screen is still starting: it gets the link.
        if (loadedUrl !== manifestUrl) return;
        const video = videoRef.current;
        if (!player || !video) return;

        // The preload chooses its opening rung itself, as a load does, so it
        // carries its own cap — computed for *its* ladder on this surface.
        const target = callbackRefs.current.preload;
        const ladder = target?.ladder ?? [];
        const { cap, headroom } = capForLadder(video, ladder.map((rung) => rung.height), qualityModeRef.current);
        const config = player.getConfiguration();
        if (headroom === null) config.abr.restrictions.maxHeight = Infinity;
        else if (cap !== null) config.abr.restrictions.maxHeight = cap;

        const plan = openingPlan(ladder, headroom === null ? null : cap,
            lastEstimateRef.current > 0 ? lastEstimateRef.current : readOpeningEstimate());
        if (plan) {
            callbackRefs.current.onLoadPlan?.({
                kind: 'preload', originalUrl: target?.originalUrl, manifestUrl: preloadUrl, startTime: preloadStart, ...plan,
            });
        }

        const pending: PendingPreload = {
            manifestUrl: preloadUrl,
            startTime: preloadStart,
            manager: player.preload(preloadUrl, preloadStart > 0 ? preloadStart : null, DASH_MIME_TYPE, config),
        };
        // Speculation: a failed preload is dropped, and the advance loads
        // the ordinary way rather than inheriting the failure.
        const drop = () => {
            if (preloadRef.current !== pending) return;
            preloadRef.current = null;
            destroyPreload(pending);
        };
        pending.manager.then((manager) => {
            if (!manager) drop();
            else manager.waitForFinish().catch(drop);
        }, drop);
        preloadRef.current = pending;
    }, [player, manifestUrl, loadedUrl, preloadUrl, preloadStart, videoRef]);

    // A mode change re-caps the running player; it never reloads anything.
    useEffect(() => {
        qualityModeRef.current = qualityMode;
        applyQualityCapRef.current?.();
    }, [qualityMode]);

    const setQuality = useCallback((index: number) => {
        if (!player) return;

        if (index === AUTO_QUALITY) {
            manualHeightRef.current = null;
            player.configure({ abr: { enabled: true } });
            setCurrentQuality(AUTO_QUALITY);
            return;
        }

        const track = player.getVideoTracks()[index];
        if (!track) return;

        manualHeightRef.current = track.height ?? null;
        player.configure({ abr: { enabled: false } });
        player.selectVideoTrack(track, /* clearBuffer */ true);
        setCurrentQuality(index);
    }, [player]);

    const setAudioTrack = useCallback((index: number) => {
        if (!player) return;
        const track = player.getAudioTracks()[index];
        if (!track) return;
        player.selectAudioTrack(track);
        // Shaka's audio choice can change the video rendition. Keep a manual
        // resolution within the new audio set; automatic ABR remains enabled.
        if (manualHeightRef.current !== null) {
            const videoTrack = player.getVideoTracks().find((item) => item.height === manualHeightRef.current);
            if (videoTrack) player.selectVideoTrack(videoTrack, /* clearBuffer */ true);
        }
        readTracks(player);
    }, [player, readTracks]);

    return {
        isLoading,
        isBuffering,
        qualities,
        audioTracks,
        currentAudioTrack,
        currentQuality,
        stats,
        setQuality,
        setAudioTrack,
        isSupported,
    };
}
