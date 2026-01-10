'use client';

import { useRef, useEffect, useCallback, useState } from 'react';
import Hls from 'hls.js';

export interface UseHlsPlayerOptions {
    videoRef: React.RefObject<HTMLVideoElement | null>;
    src: string;
    enabled: boolean;
    autoPlay?: boolean;
    initialTime?: number;
    isLive?: boolean;
    onManifestParsed?: (levels: HlsQualityLevel[]) => void;
    onLevelSwitch?: (level: number) => void;
    onError?: (error: string) => void;
    onLoadingChange?: (isLoading: boolean) => void;
    onBufferingChange?: (isBuffering: boolean) => void;
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
        onLevelSwitch,
        onError,
        onLoadingChange,
        onBufferingChange,
    } = options;

    // HLS instance ref
    const hlsRef = useRef<Hls | null>(null);
    const isAutoPlayingRef = useRef(false);
    const retryCountRef = useRef<number>(0);
    const lastRetryTimeRef = useRef<number>(0);
    const MAX_RETRIES = 3;
    const RETRY_COOLDOWN_MS = 2000;

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
    const isNativeHls = typeof window !== 'undefined' &&
        videoRef.current?.canPlayType('application/vnd.apple.mpegurl') === 'probably';

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
            hlsRef.current.currentLevel = index;
            setCurrentLevel(index);
        }
    }, []);

    /**
     * Initialize HLS.js player or direct video playback
     */
    const initHls = useCallback(() => {
        const video = videoRef.current;
        if (!video || !src || !enabled) return;

        // Destroy existing HLS instance
        if (hlsRef.current) {
            hlsRef.current.destroy();
            hlsRef.current = null;
        }

        setIsLoading(true);
        onLoadingChange?.(true);

        // For non-HLS sources (direct MP4, etc.), use native video element
        if (!isHlsSource(src)) {
            console.log('[Player] Using native playback for:', src.slice(0, 80));
            video.src = src;
            video.load();

            const onLoadedMetadata = () => {
                setIsLoading(false);
                onLoadingChange?.(false);

                if (initialTime > 0 && Number.isFinite(initialTime)) {
                    video.currentTime = initialTime;
                }

                if (autoPlay) {
                    const savedMuted = localStorage.getItem('w2g-player-muted') === 'true';
                    video.muted = savedMuted;

                    isAutoPlayingRef.current = true;
                    video.play().catch(() => {
                        console.log('[Player] Autoplay blocked');
                    }).finally(() => {
                        setTimeout(() => { isAutoPlayingRef.current = false; }, 1000);
                    });
                }
            };

            const handleError = () => {
                console.error('[Player] Native playback error');
                onError?.('Failed to load video');
                setIsLoading(false);
                onLoadingChange?.(false);
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

            hls.loadSource(src);
            hls.attachMedia(video);

            hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
                setIsLoading(false);
                onLoadingChange?.(false);

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
                onManifestParsed?.(uniqueLevels);

                // Set initial time if provided
                if (initialTime > 0 && Number.isFinite(initialTime) && !isLive) {
                    video.currentTime = initialTime;
                }

                // Handle autoplay
                if (autoPlay) {
                    const savedMuted = localStorage.getItem('w2g-player-muted') === 'true';
                    video.muted = savedMuted;

                    isAutoPlayingRef.current = true;
                    video.play().catch(() => {
                        console.log('[HLS] Autoplay blocked');
                    }).finally(() => {
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
                setCurrentLevel(data.level);
                onLevelSwitch?.(data.level);

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

                    const now = Date.now();
                    const timeSinceLastRetry = now - lastRetryTimeRef.current;

                    // Check if we should attempt recovery
                    if (retryCountRef.current >= MAX_RETRIES) {
                        console.error('[HLS] Max retries exceeded, giving up');
                        onError?.('Playback failed after multiple retries. Please try refreshing.');
                        hls.destroy();
                        return;
                    }

                    // Cooldown between retries
                    if (timeSinceLastRetry < RETRY_COOLDOWN_MS) {
                        console.warn('[HLS] Retry too soon, waiting...');
                        return;
                    }

                    retryCountRef.current++;
                    lastRetryTimeRef.current = now;

                    switch (data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            onError?.(`Network issue. Retry ${retryCountRef.current}/${MAX_RETRIES}...`);
                            setTimeout(() => hls.startLoad(), RETRY_COOLDOWN_MS);
                            break;
                        case Hls.ErrorTypes.MEDIA_ERROR:
                            onError?.(`Decoding error. Retry ${retryCountRef.current}/${MAX_RETRIES}...`);
                            hls.recoverMediaError();
                            break;
                        default:
                            onError?.('Fatal playback error.');
                            hls.destroy();
                            break;
                    }
                }
            });

            hlsRef.current = hls;
        } else if (isNativeHls) {
            // Safari native HLS
            video.src = src;
            video.load();

            const onLoadedMetadata = () => {
                setIsLoading(false);
                onLoadingChange?.(false);

                if (initialTime > 0 && Number.isFinite(initialTime) && !isLive) {
                    video.currentTime = initialTime;
                }

                if (autoPlay) {
                    const savedMuted = localStorage.getItem('w2g-player-muted') === 'true';
                    video.muted = savedMuted;

                    isAutoPlayingRef.current = true;
                    video.play().catch(() => {
                        console.log('[HLS] Autoplay blocked');
                    }).finally(() => {
                        setTimeout(() => { isAutoPlayingRef.current = false; }, 1000);
                    });
                }
            };

            video.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
        }
    }, [videoRef, src, enabled, autoPlay, initialTime, isLive, isHlsSource, isHlsSupported, isNativeHls, onManifestParsed, onLevelSwitch, onError, onLoadingChange]);

    // === EFFECT: Initialize on mount/src change ===
    useEffect(() => {
        if (enabled) {
            initHls();
        }

        return () => {
            if (hlsRef.current) {
                hlsRef.current.destroy();
                hlsRef.current = null;
            }
        };
    }, [enabled, src, initHls]);

    // === EFFECT: Buffering detection ===
    useEffect(() => {
        const video = videoRef.current;
        if (!video || !enabled) return;

        const onWaiting = () => {
            setIsBuffering(true);
            onBufferingChange?.(true);
        };

        const onCanPlay = () => {
            setIsBuffering(false);
            onBufferingChange?.(false);
        };

        const onPlaying = () => {
            setIsBuffering(false);
            onBufferingChange?.(false);
        };

        video.addEventListener('waiting', onWaiting);
        video.addEventListener('canplay', onCanPlay);
        video.addEventListener('playing', onPlaying);

        return () => {
            video.removeEventListener('waiting', onWaiting);
            video.removeEventListener('canplay', onCanPlay);
            video.removeEventListener('playing', onPlaying);
        };
    }, [enabled, videoRef, onBufferingChange]);

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
