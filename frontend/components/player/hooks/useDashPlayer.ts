'use client';

import { useRef, useEffect, useCallback, useState } from 'react';
import { QualityOption } from '@/lib/api';

export interface UseDashPlayerOptions {
    videoRef: React.RefObject<HTMLVideoElement | null>;
    audioRef: React.RefObject<HTMLAudioElement | null>;
    videoUrl: string;
    audioUrl: string;
    enabled: boolean;
    autoPlay?: boolean;
    initialTime?: number;
    isLive?: boolean;
    initialVolume?: number;
    initialMuted?: boolean;
    availableQualities?: QualityOption[];
    onQualitiesReady?: (qualities: DashQualityLevel[]) => void;
    onError?: (error: string) => void;
    onLoadingChange?: (isLoading: boolean) => void;
    onReady?: () => void;
    // For quality prefetch optimization
    onQualityChangeNotify?: (oldVideoUrl: string, newVideoUrl: string, audioUrl: string | undefined) => void;
}

export interface DashQualityLevel {
    height: number;
    bitrate: number;
    index: number;
}

export interface UseDashPlayerReturn {
    isLoading: boolean;
    error: string | null;
    qualities: DashQualityLevel[];
    currentQuality: number;
    setQuality: (index: number) => void;
    duration: number;
}

/**
 * Custom hook for DASH player initialization and quality management.
 *
 * Handles:
 * - Video and audio element initialization
 * - Loading timeout and error handling
 * - Quality level management
 * - Quality switching with seamless playback
 *
 * Works in conjunction with useDashSync which handles ongoing A/V synchronization.
 */
export function useDashPlayer(options: UseDashPlayerOptions): UseDashPlayerReturn {
    const {
        videoRef,
        audioRef,
        videoUrl,
        audioUrl,
        enabled,
        autoPlay = false,
        initialTime = 0,
        isLive = false,
        initialVolume = 1.0,
        initialMuted = false,
        availableQualities,
        onQualitiesReady,
        onError,
        onLoadingChange,
        onReady,
        onQualityChangeNotify,
    } = options;

    // Use refs for callbacks to avoid recreating functions on every render
    const callbackRefs = useRef({
        onQualitiesReady,
        onError,
        onLoadingChange,
        onReady,
        onQualityChangeNotify,
    });
    callbackRefs.current = {
        onQualitiesReady,
        onError,
        onLoadingChange,
        onReady,
        onQualityChangeNotify,
    };

    // Initialization tracking
    const dashInitializedRef = useRef<string | null>(null);
    const loadingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const qualitySwitchAbortRef = useRef<AbortController | null>(null);

    // State
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [qualities, setQualities] = useState<DashQualityLevel[]>([]);
    const [currentQuality, setCurrentQuality] = useState(-1);
    const [duration, setDuration] = useState(0);

    /**
     * Set quality level (changes video source, keeps audio)
     */
    const setQuality = useCallback((index: number) => {
        if (!availableQualities?.[index]) return;

        const video = videoRef.current;
        const audio = audioRef.current;
        if (!video) return;

        // Abort any previous quality switch listener
        if (qualitySwitchAbortRef.current) {
            qualitySwitchAbortRef.current.abort();
        }
        qualitySwitchAbortRef.current = new AbortController();

        const savedTime = video.currentTime;
        const wasPlaying = !video.paused;
        const selectedQuality = availableQualities[index];

        console.log(`[DashPlayer] Switching to quality ${index}: ${selectedQuality.height}p`);

        // Notify backend for prefetch optimization (before switching)
        const oldVideoUrl = video.src;
        callbackRefs.current.onQualityChangeNotify?.(oldVideoUrl, selectedQuality.video_url, audioUrl);

        // Pause both during quality switch
        video.pause();
        audio?.pause();

        // Change video source - audio stays the same (DASH uses shared audio track)
        video.src = selectedQuality.video_url;
        video.load();

        const signal = qualitySwitchAbortRef.current.signal;

        video.addEventListener('canplay', () => {
            if (signal.aborted) return;

            video.currentTime = savedTime;
            if (audio) audio.currentTime = savedTime;

            if (wasPlaying) {
                video.play().catch(console.warn);
                if (audio) {
                    // Small delay to ensure video starts first
                    setTimeout(() => {
                        if (signal.aborted) return;
                        audio.currentTime = video.currentTime;
                        audio.play().catch(console.warn);
                    }, 50);
                }
            }
        }, { once: true, signal });

        setCurrentQuality(index);
    }, [videoRef, audioRef, audioUrl, availableQualities]);

    // === EFFECT: Initialize DASH player ===
    useEffect(() => {
        if (!enabled) {
            dashInitializedRef.current = null;
            return;
        }

        const video = videoRef.current;
        const audio = audioRef.current;
        if (!video || !audio || !videoUrl || !audioUrl) return;

        // Prevent re-initialization with same URLs
        const initKey = `${videoUrl}|${audioUrl}`;
        if (dashInitializedRef.current === initKey) return;
        dashInitializedRef.current = initKey;

        console.log('[DashPlayer] Initializing DASH mode');
        setError(null);
        setIsLoading(true);
        callbackRefs.current.onLoadingChange?.(true);

        // Set up video (use volume=0 instead of muted to prevent aggressive browser pausing)
        // Some browsers pause muted videos in background tabs more aggressively than volume=0 videos
        video.src = videoUrl;
        video.volume = 0; // No audio from video element - audio comes from separate audio element
        video.muted = false; // Keep muted=false to avoid background throttling
        video.load();

        // Set up audio with user's saved preferences
        audio.src = audioUrl;
        audio.muted = initialMuted;
        audio.volume = initialVolume;
        audio.load();

        // Set up qualities from availableQualities
        if (availableQualities && availableQualities.length > 0) {
            const dashQualities = availableQualities.map((q, index) => ({
                height: q.height,
                bitrate: q.tbr ? q.tbr * 1000 : (q.height * 5000),
                index,
            }));
            setQualities(dashQualities);
            setCurrentQuality(0);
            callbackRefs.current.onQualitiesReady?.(dashQualities);
        }

        // Wait for both to load with timeout
        let videoLoaded = false;
        let audioLoaded = false;

        // Set loading timeout (10 seconds)
        loadingTimeoutRef.current = setTimeout(() => {
            if (!videoLoaded || !audioLoaded) {
                console.warn('[DashPlayer] Loading timeout - one or both streams failed to load');
                const errorMsg = 'Stream loading timed out. The video may be unavailable or region-locked.';
                setError(errorMsg);
                callbackRefs.current.onError?.(errorMsg);
                setIsLoading(false);
                callbackRefs.current.onLoadingChange?.(false);
            }
        }, 10000);

        const checkBothLoaded = () => {
            if (videoLoaded && audioLoaded) {
                // Clear the loading timeout
                if (loadingTimeoutRef.current) {
                    clearTimeout(loadingTimeoutRef.current);
                    loadingTimeoutRef.current = null;
                }

                setIsLoading(false);
                callbackRefs.current.onLoadingChange?.(false);
                setDuration(video.duration || audio.duration);

                // Re-apply volume/muted settings AFTER load completes
                // (browsers can reset these during load)
                audio.volume = initialVolume;
                audio.muted = initialMuted;

                // Set initial time
                if (initialTime > 0 && Number.isFinite(initialTime) && !isLive) {
                    video.currentTime = initialTime;
                    audio.currentTime = initialTime;
                }

                console.log('[DashPlayer] Both streams loaded successfully');
                callbackRefs.current.onReady?.();
            }
        };

        const onVideoLoaded = () => { videoLoaded = true; checkBothLoaded(); };
        const onAudioLoaded = () => { audioLoaded = true; checkBothLoaded(); };

        const onVideoError = () => {
            if (loadingTimeoutRef.current) {
                clearTimeout(loadingTimeoutRef.current);
                loadingTimeoutRef.current = null;
            }
            const errorMsg = `Video load failed: ${video.error?.message || 'Unknown'}`;
            setError(errorMsg);
            callbackRefs.current.onError?.(errorMsg);
            setIsLoading(false);
            callbackRefs.current.onLoadingChange?.(false);
        };

        const onAudioError = () => {
            if (loadingTimeoutRef.current) {
                clearTimeout(loadingTimeoutRef.current);
                loadingTimeoutRef.current = null;
            }
            const errorMsg = `Audio load failed: ${audio.error?.message || 'Unknown'}`;
            setError(errorMsg);
            callbackRefs.current.onError?.(errorMsg);
            setIsLoading(false);
            callbackRefs.current.onLoadingChange?.(false);
        };

        video.addEventListener('loadedmetadata', onVideoLoaded, { once: true });
        audio.addEventListener('loadedmetadata', onAudioLoaded, { once: true });
        video.addEventListener('error', onVideoError, { once: true });
        audio.addEventListener('error', onAudioError, { once: true });

        return () => {
            if (loadingTimeoutRef.current) {
                clearTimeout(loadingTimeoutRef.current);
                loadingTimeoutRef.current = null;
            }
            video.removeEventListener('loadedmetadata', onVideoLoaded);
            audio.removeEventListener('loadedmetadata', onAudioLoaded);
            video.removeEventListener('error', onVideoError);
            audio.removeEventListener('error', onAudioError);
            dashInitializedRef.current = null;

            // Clean up audio element when switching modes
            audio.pause();
            audio.removeAttribute('src');
            audio.load();
        };
    }, [enabled, videoUrl, audioUrl, initialTime, isLive, initialVolume, initialMuted, availableQualities, videoRef, audioRef]);

    return {
        isLoading,
        error,
        qualities,
        currentQuality,
        setQuality,
        duration,
    };
}
