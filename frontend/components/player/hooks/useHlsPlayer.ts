'use client';

import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import Hls from 'hls.js';

import { startPlayback, type PlaybackStart } from '@/lib/playback';

export interface UseHlsPlayerOptions {
    videoRef: React.RefObject<HTMLVideoElement | null>;
    src: string;
    enabled: boolean;
    autoPlay?: boolean;
    initialTime?: number;
    isLive?: boolean;
    onManifestParsed?: (levels: HlsQualityLevel[]) => void;
    onError?: (error: string) => void;
    /**
     * The CDN rejected the source outright (403/410). Retrying the same URL
     * cannot succeed — the signed token in it has expired, which is routine
     * for long-running live streams. The owner should re-resolve and hand
     * this hook a fresh src.
     */
    onSourceExpired?: () => Promise<void>;
    onLoadingChange?: (isLoading: boolean) => void;
    onBufferingChange?: (isBuffering: boolean) => void;
    /** How autoplay actually went; see `lib/playback`. */
    onPlaybackStart?: (outcome: PlaybackStart) => void;
}

export interface HlsQualityLevel {
    height: number;
    bitrate: number;
    index: number;
}

export interface HlsStats {
    bandwidth: number;
    videoCodec: string;
    audioCodec: string;
    totalBytes: number;
}

export interface UseHlsPlayerReturn {
    isLoading: boolean;
    isBuffering: boolean;
    qualities: HlsQualityLevel[];
    /** Selected level, or -1 while adaptive quality is enabled. */
    currentLevel: number;
    stats: HlsStats;
    setLevel: (index: number) => void;
    isHlsSupported: boolean;
    isNativeHls: boolean;
}

/**
 * Custom hook for HLS.js playback.
 * 
 * Handles:
 * - HLS.js initialization and lifecycle
 * - Quality level management
 * - Stats tracking
 * - Native HLS fallback (Safari)
 */
export function useHlsPlayer(options: UseHlsPlayerOptions): UseHlsPlayerReturn {
    const {
        videoRef,
        src,
        enabled,
        autoPlay = false,
        initialTime = 0,
        isLive = false,
        onManifestParsed,
        onError,
        onSourceExpired,
        onLoadingChange,
        onBufferingChange,
        onPlaybackStart,
    } = options;

    // HLS instance ref
    const hlsRef = useRef<Hls | null>(null);
    const isAutoPlayingRef = useRef(false);
    const retryCountRef = useRef<number>(0);
    const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const recoverStalledLiveRef = useRef<(() => void) | null>(null);
    const lastSrcRef = useRef<string>('');
    // One expiry report per source: the re-resolve it triggers swaps the src,
    // which resets this. Without the guard a burst of segment 403s would
    // spam the owner with refresh requests.
    const sourceExpiredRef = useRef(false);
    const MAX_RETRIES = 3;
    const RETRY_COOLDOWN_MS = 2000;
    // Upstream verdicts that a retry of the same URL can never change: the
    // signed token in the URL is dead (403) or the resource is gone (410).
    const EXPIRED_SOURCE_HTTP_CODES = [403, 410];

    // Use refs for callbacks to avoid recreating initHls on every render
    const callbackRefs = useRef({
        onManifestParsed,
        onError,
        onSourceExpired,
        onLoadingChange,
        onBufferingChange,
        onPlaybackStart,
    });
    useEffect(() => {
        callbackRefs.current = {
            onManifestParsed,
            onError,
            onSourceExpired,
            onLoadingChange,
            onBufferingChange,
            onPlaybackStart,
        };
    }, [onManifestParsed, onError, onSourceExpired, onLoadingChange,
        onBufferingChange, onPlaybackStart]);

    // State
    const [isLoading, setIsLoading] = useState(true);
    const [isBuffering, setIsBuffering] = useState(false);
    const [qualities, setQualities] = useState<HlsQualityLevel[]>([]);
    const [currentLevel, setCurrentLevel] = useState(-1);
    const [stats, setStats] = useState<HlsStats>({
        bandwidth: 0,
        videoCodec: '',
        audioCodec: '',
        totalBytes: 0,
    });

    // Check HLS support
    const isHlsSupported = typeof window !== 'undefined' && Hls.isSupported();
    const isNativeHls = useMemo(() => {
        if (typeof window === 'undefined') return false;
        const testVideo = document.createElement('video');
        return testVideo.canPlayType('application/vnd.apple.mpegurl') === 'probably';
    }, []);

    /**
     * Check if source is HLS
     */
    const isHlsSource = useCallback((url: string): boolean => {
        return url.includes('.m3u8') || url.includes('.m3u') || url.includes('manifest');
    }, []);

    /**
     * Set quality level
     */
    const setLevel = useCallback((index: number) => {
        if (hlsRef.current) {
            // Returning to Auto only changes selection for future requests.
            // currentLevel flushes the buffer, including when assigned -1.
            if (index === -1) hlsRef.current.loadLevel = -1;
            else hlsRef.current.currentLevel = index;
            setCurrentLevel(index);
        }
    }, []);

    /**
     * Initialize HLS.js player or direct video playback
     */
    const initHls = useCallback(() => {
        const video = videoRef.current;
        if (!video || !src || !enabled) return;

        // Prevent re-initialization with the same source
        if (lastSrcRef.current === src) {
            return;
        }
        lastSrcRef.current = src;

        if (recoveryTimerRef.current !== null) {
            clearTimeout(recoveryTimerRef.current);
            recoveryTimerRef.current = null;
        }

        // Destroy existing HLS instance
        if (hlsRef.current) {
            hlsRef.current.destroy();
            hlsRef.current = null;
        }

        setCurrentLevel(-1);
        setIsLoading(true);
        callbackRefs.current.onLoadingChange?.(true);

        // For non-HLS sources (direct MP4, etc.), use native video element
        if (!isHlsSource(src)) {
            console.log('[Player] Using native playback for:', src.slice(0, 80));
            video.src = src;
            video.load();

            const onLoadedMetadata = () => {
                setIsLoading(false);
                callbackRefs.current.onLoadingChange?.(false);

                if (initialTime > 0 && Number.isFinite(initialTime)) {
                    video.currentTime = initialTime;
                }

                if (autoPlay) {
                    const savedMuted = localStorage.getItem('w2g-player-muted') === 'true';
                    video.muted = savedMuted;

                    isAutoPlayingRef.current = true;
                    // Reported rather than logged: a browser that refuses to
                    // autoplay leaves this viewer behind the rest of the room,
                    // and only the UI can ask for the gesture it wants.
                    startPlayback(video)
                        .then((outcome) => callbackRefs.current.onPlaybackStart?.(outcome))
                        .finally(() => {
                            setTimeout(() => { isAutoPlayingRef.current = false; }, 1000);
                        });
                }
            };

            const handleError = () => {
                console.error('[Player] Native playback error');
                callbackRefs.current.onError?.('Failed to load video');
                setIsLoading(false);
                callbackRefs.current.onLoadingChange?.(false);
            };

            video.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
            video.addEventListener('error', handleError, { once: true });
            return;
        }

        if (isHlsSupported) {
            const hls = new Hls({
                enableWorker: true,
                lowLatencyMode: isLive,
                // Buffer configuration for reduced buffering
                backBufferLength: 120,          // Keep 2 minutes of back buffer (was 90)
                maxBufferLength: 60,            // Buffer up to 60 seconds ahead
                maxMaxBufferLength: 120,        // Allow up to 2 minutes in good conditions
                liveSyncDurationCount: 4,       // Sync 4 segments behind live edge (was 3)
                // Quality selection
                startLevel: -1,                 // Auto-select initial quality
                abrBandWidthFactor: 0.9,        // Conservative quality selection
                abrBandWidthUpFactor: 0.7,      // Cautious quality upgrades
                // Retry configuration
                fragLoadingRetryDelay: 1000,
                manifestLoadingRetryDelay: 1000,
                levelLoadingRetryDelay: 1000,
                manifestLoadingTimeOut: 20000,
                fragLoadingTimeOut: 20000,
            });

            const stopWithError = (message = 'Playback failed after multiple retries. Please try refreshing.') => {
                if (hlsRef.current && hlsRef.current !== hls) return;
                if (recoveryTimerRef.current !== null) clearTimeout(recoveryTimerRef.current);
                recoveryTimerRef.current = null;
                recoverStalledLiveRef.current = null;
                setIsLoading(false);
                setIsBuffering(false);
                callbackRefs.current.onLoadingChange?.(false);
                callbackRefs.current.onBufferingChange?.(false);
                callbackRefs.current.onError?.(message);
                if (hlsRef.current === hls) hls.destroy();
                hlsRef.current = null;
            };
            const scheduleRecovery = (recover: () => void) => {
                if (hlsRef.current !== hls || recoveryTimerRef.current !== null) return;
                if (retryCountRef.current >= MAX_RETRIES) {
                    stopWithError();
                    return;
                }
                retryCountRef.current++;
                recoveryTimerRef.current = setTimeout(() => {
                    recoveryTimerRef.current = null;
                    if (hlsRef.current === hls) recover();
                }, RETRY_COOLDOWN_MS);
            };
            recoverStalledLiveRef.current = () => scheduleRecovery(() => hls.loadSource(src));

            hls.loadSource(src);
            hls.attachMedia(video);

            hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
                setIsLoading(false);
                callbackRefs.current.onLoadingChange?.(false);

                console.log('[HLS] Manifest parsed:', data.levels.length, 'levels');

                // Extract unique quality levels
                const levels = data.levels.map((level, index) => ({
                    height: level.height || 0,
                    bitrate: level.bitrate || 0,
                    index,
                }));

                // Filter duplicates and sort by bitrate (descending)
                const uniqueLevels = levels.filter((l, i, self) =>
                    i === self.findIndex(t => t.height === l.height && t.bitrate === l.bitrate)
                ).sort((a, b) => b.bitrate - a.bitrate);

                setQualities(uniqueLevels);
                callbackRefs.current.onManifestParsed?.(uniqueLevels);

                // Set initial time if provided
                if (initialTime > 0 && Number.isFinite(initialTime) && !isLive) {
                    video.currentTime = initialTime;
                }

                // Handle autoplay
                if (autoPlay) {
                    const savedMuted = localStorage.getItem('w2g-player-muted') === 'true';
                    video.muted = savedMuted;

                    isAutoPlayingRef.current = true;
                    // Reported rather than logged: a browser that refuses to
                    // autoplay leaves this viewer behind the rest of the room,
                    // and only the UI can ask for the gesture it wants.
                    startPlayback(video)
                        .then((outcome) => callbackRefs.current.onPlaybackStart?.(outcome))
                        .finally(() => {
                            setTimeout(() => { isAutoPlayingRef.current = false; }, 1000);
                        });
                }
            });

            hls.on(Hls.Events.FRAG_LOADED, (_, data) => {
                setStats(prev => ({
                    ...prev,
                    bandwidth: data.frag.stats.bwEstimate,
                    totalBytes: prev.totalBytes + data.frag.stats.total,
                }));
            });

            hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
                setCurrentLevel(hls.autoLevelEnabled ? -1 : hls.manualLevel);

                const level = hls.levels[data.level];
                if (level) {
                    setStats(prev => ({
                        ...prev,
                        videoCodec: level.videoCodec || '',
                        audioCodec: level.audioCodec || '',
                    }));
                }
            });

            hls.on(Hls.Events.ERROR, (_, data) => {
                if (data.fatal) {
                    console.error('[HLS] Fatal error:', data);

                    // A 403/410 from the CDN means the signed URL itself has
                    // expired — normal for live streams that outlive their
                    // token. Retrying the same URL just burns the retry
                    // budget on an answer that cannot change; ask the owner
                    // for a freshly resolved source instead.
                    const httpCode = data.response?.code;
                    if (
                        data.type === Hls.ErrorTypes.NETWORK_ERROR &&
                        typeof httpCode === 'number' &&
                        EXPIRED_SOURCE_HTTP_CODES.includes(httpCode) &&
                        callbackRefs.current.onSourceExpired &&
                        !sourceExpiredRef.current
                    ) {
                        sourceExpiredRef.current = true;
                        console.warn(`[HLS] Upstream rejected the source (${httpCode}), requesting a fresh stream URL`);
                        if (recoveryTimerRef.current !== null) clearTimeout(recoveryTimerRef.current);
                        recoveryTimerRef.current = null;
                        recoverStalledLiveRef.current = null;
                        const refreshing = callbackRefs.current.onSourceExpired();
                        hls.destroy();
                        hlsRef.current = null;
                        void refreshing.catch((error: unknown) => {
                            // A newer source owns the player once refresh succeeds.
                            if (lastSrcRef.current !== src) return;
                            stopWithError(error instanceof Error ? error.message : 'Could not refresh the stream.');
                        });
                        return;
                    }

                    // Keep transient failures out of the permanent error overlay.
                    if (data.type !== Hls.ErrorTypes.NETWORK_ERROR && data.type !== Hls.ErrorTypes.MEDIA_ERROR) {
                        stopWithError();
                        return;
                    }
                    // Pending errors coalesce into a scheduled retry; none is
                    // discarded merely because it arrived during the cooldown.
                    scheduleRecovery(() => {
                        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                            hls.recoverMediaError();
                        } else if (data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR ||
                                   data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT ||
                                   data.details === Hls.ErrorDetails.MANIFEST_PARSING_ERROR) {
                            hls.loadSource(src);
                        } else {
                            hls.startLoad();
                        }
                    });
                }
            });

            hlsRef.current = hls;
        } else if (isNativeHls) {
            // Safari native HLS
            video.src = src;
            video.load();

            const onLoadedMetadata = () => {
                setIsLoading(false);
                callbackRefs.current.onLoadingChange?.(false);

                if (initialTime > 0 && Number.isFinite(initialTime) && !isLive) {
                    video.currentTime = initialTime;
                }

                if (autoPlay) {
                    const savedMuted = localStorage.getItem('w2g-player-muted') === 'true';
                    video.muted = savedMuted;

                    isAutoPlayingRef.current = true;
                    // Reported rather than logged: a browser that refuses to
                    // autoplay leaves this viewer behind the rest of the room,
                    // and only the UI can ask for the gesture it wants.
                    startPlayback(video)
                        .then((outcome) => callbackRefs.current.onPlaybackStart?.(outcome))
                        .finally(() => {
                            setTimeout(() => { isAutoPlayingRef.current = false; }, 1000);
                        });
                }
            };

            video.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
        }
    }, [videoRef, src, enabled, autoPlay, initialTime, isLive, isHlsSource, isHlsSupported, isNativeHls]);

    // === EFFECT: Initialize on mount/src change ===
    const initVersionRef = useRef(0);
    useEffect(() => {
        // Reset lastSrcRef when src changes to allow reinitialization
        if (src !== lastSrcRef.current) {
            lastSrcRef.current = ''; // Clear to allow initHls to run
            // A new source gets a clean slate: fresh retry budget, and the
            // right to report its own expiry.
            sourceExpiredRef.current = false;
            retryCountRef.current = 0;
        }

        const currentVersion = ++initVersionRef.current;
        let initTimer: number | null = null;
        if (enabled && src) {
            initTimer = window.setTimeout(() => {
                // Verify this is still the current version (prevents double init on rapid changes)
                if (initVersionRef.current !== currentVersion) return;
                initHls();
            }, 0);
        }

        return () => {
            if (initTimer) {
                window.clearTimeout(initTimer);
            }
            recoverStalledLiveRef.current = null;
            if (recoveryTimerRef.current !== null) {
                clearTimeout(recoveryTimerRef.current);
                recoveryTimerRef.current = null;
            }
            if (hlsRef.current) {
                hlsRef.current.destroy();
                hlsRef.current = null;
            }
        };
    }, [enabled, src]); // eslint-disable-line react-hooks/exhaustive-deps
    // Note: initHls excluded from deps - it has internal src guard and including it causes infinite loops

    // === EFFECT: Buffering detection ===
    useEffect(() => {
        const video = videoRef.current;
        if (!video || !enabled) return;

        let hasPlayed = false;
        let stallTimer: ReturnType<typeof setTimeout> | null = null;
        const clearStallTimer = () => {
            if (stallTimer !== null) clearTimeout(stallTimer);
            stallTimer = null;
        };
        const onWaiting = () => {
            setIsBuffering(true);
            callbackRefs.current.onBufferingChange?.(true);
            // Live playlists can return 200 forever without advancing. HLS
            // then has no fatal network error to recover from. Only restart
            // after playback has begun and a real mid-stream stall persists.
            if (isLive && hasPlayed && !video.paused && stallTimer === null) {
                stallTimer = setTimeout(() => {
                    stallTimer = null;
                    if (!video.paused && !video.seeking && video.readyState < 3) {
                        recoverStalledLiveRef.current?.();
                    }
                }, 12_000);
            }
        };

        const onCanPlay = () => {
            clearStallTimer();
            setIsBuffering(false);
            callbackRefs.current.onBufferingChange?.(false);
        };

        const onPlaying = () => {
            hasPlayed = true;
            clearStallTimer();
            setIsBuffering(false);
            callbackRefs.current.onBufferingChange?.(false);
        };

        video.addEventListener('waiting', onWaiting);
        video.addEventListener('canplay', onCanPlay);
        video.addEventListener('playing', onPlaying);

        return () => {
            clearStallTimer();
            video.removeEventListener('waiting', onWaiting);
            video.removeEventListener('canplay', onCanPlay);
            video.removeEventListener('playing', onPlaying);
        };
    }, [enabled, videoRef, src, isLive]);

    return {
        isLoading,
        isBuffering,
        qualities,
        currentLevel,
        stats,
        setLevel,
        isHlsSupported,
        isNativeHls,
    };
}
