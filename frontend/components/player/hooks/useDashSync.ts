'use client';

import { useRef, useEffect, useCallback, useState } from 'react';

/**
 * Configuration for DASH A/V synchronization
 */
interface DashSyncConfig {
    /** Minimum buffer health (seconds) before preemptively pausing audio */
    bufferThreshold: number;
    /** Maximum allowed drift (seconds) before correcting */
    driftThreshold: number;
    /** Frequency of sync checks (Hz) */
    syncFrequency: number;
    /** Large drift threshold that triggers heavy sync */
    heavySyncThreshold: number;
}

const DEFAULT_CONFIG: DashSyncConfig = {
    bufferThreshold: 0.3,      // Pause audio if less than 0.3s buffered
    driftThreshold: 0.15,      // Correct drift > 150ms (increased to reduce glitches)
    syncFrequency: 4,          // Check sync 4 times per second (reduced frequency)
    heavySyncThreshold: 0.5,   // Heavy sync if drift > 500ms
};

export interface UseDashSyncOptions {
    videoRef: React.RefObject<HTMLVideoElement | null>;
    audioRef: React.RefObject<HTMLAudioElement | null>;
    enabled: boolean;
    initialVolume?: number;
    initialMuted?: boolean;
    onBufferingChange?: (isBuffering: boolean) => void;
    onPlayingChange?: (isPlaying: boolean) => void;
    onTimeUpdate?: (time: number, duration: number) => void;
    onError?: (error: string) => void;
    config?: Partial<DashSyncConfig>;
}

export interface DashSyncState {
    isPlaying: boolean;
    isBuffering: boolean;
    isSyncing: boolean;
    currentTime: number;
    duration: number;
    volume: number;
    muted: boolean;
    syncHealth: 'good' | 'recovering' | 'failed';
    lastDrift: number;
}

export interface UseDashSyncReturn extends DashSyncState {
    play: () => Promise<void>;
    pause: () => void;
    seek: (time: number) => void;
    setVolume: (volume: number) => void;
    setMuted: (muted: boolean) => void;
    getVideoBufferHealth: () => number;
    getAudioBufferHealth: () => number;
}

/**
 * Custom hook for synchronizing separate video and audio elements (DASH-style playback).
 * 
 * Key improvements over previous implementation:
 * 1. Preemptive buffer monitoring - pauses audio BEFORE video stalls
 * 2. RAF-based sync loop - smoother than setInterval
 * 3. All state in refs - no stale closures
 * 4. Graceful error recovery with exponential backoff
 */
export function useDashSync(options: UseDashSyncOptions): UseDashSyncReturn {
    const {
        videoRef,
        audioRef,
        enabled,
        initialVolume = 1.0,
        initialMuted = false,
        onBufferingChange,
        onPlayingChange,
        onTimeUpdate,
        onError,
        config: userConfig,
    } = options;

    const config = { ...DEFAULT_CONFIG, ...userConfig };

    // All mutable state stored in refs to avoid stale closures
    const stateRef = useRef<DashSyncState>({
        isPlaying: false,
        isBuffering: false,
        isSyncing: false,
        currentTime: 0,
        duration: 0,
        volume: initialVolume,
        muted: initialMuted,
        syncHealth: 'good',
        lastDrift: 0,
    });

    // Interval and timing refs (using setInterval instead of RAF for background tab support)
    const syncIntervalIdRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const syncIntervalMs = 1000 / config.syncFrequency;
    const consecutiveFailuresRef = useRef<number>(0);
    const isRecoveringRef = useRef<boolean>(false);
    const lastHeavySyncTimeRef = useRef<number>(0);
    const HEAVY_SYNC_COOLDOWN_BASE_MS = 2000; // Base cooldown, increases with failures
    const MAX_CONSECUTIVE_FAILURES = 5;

    // Play promise tracking to prevent race conditions
    const audioPlayPromiseRef = useRef<Promise<void> | null>(null);
    const isPlayingAudioRef = useRef<boolean>(false);

    // React state for triggering re-renders (minimal)
    const [state, setState] = useState<DashSyncState>(stateRef.current);

    // Update both ref and state
    const updateState = useCallback((updates: Partial<DashSyncState>) => {
        stateRef.current = { ...stateRef.current, ...updates };
        setState(stateRef.current);
    }, []);

    /**
     * Get buffer health (seconds of content buffered ahead)
     */
    const getBufferHealth = useCallback((element: HTMLMediaElement | null): number => {
        if (!element || element.buffered.length === 0) return 0;

        const currentTime = element.currentTime;
        for (let i = 0; i < element.buffered.length; i++) {
            const start = element.buffered.start(i);
            const end = element.buffered.end(i);
            if (currentTime >= start && currentTime <= end) {
                return end - currentTime;
            }
        }
        return 0;
    }, []);

    const getVideoBufferHealth = useCallback(() => {
        return getBufferHealth(videoRef.current);
    }, [videoRef, getBufferHealth]);

    const getAudioBufferHealth = useCallback(() => {
        return getBufferHealth(audioRef.current);
    }, [audioRef, getBufferHealth]);

    /**
     * Perform heavy sync - pause both, seek, and resume
     */
    const performHeavySync = useCallback(async (
        video: HTMLVideoElement,
        audio: HTMLAudioElement,
        targetTime: number
    ) => {
        if (stateRef.current.isSyncing) return;

        // Check cooldown (with exponential backoff based on failure count)
        const now = Date.now();
        const cooldownMs = HEAVY_SYNC_COOLDOWN_BASE_MS * Math.pow(2, Math.min(consecutiveFailuresRef.current, 4));
        if (now - lastHeavySyncTimeRef.current < cooldownMs) {
            console.log(`[DashSync] Heavy sync on cooldown, skipping (${cooldownMs}ms)`);
            return;
        }
        lastHeavySyncTimeRef.current = now;

        updateState({ isSyncing: true, isBuffering: true, syncHealth: 'recovering' });
        onBufferingChange?.(true);

        const wasPlaying = !video.paused;

        try {
            video.pause();
            audio.pause();

            // Seek both to target time
            video.currentTime = targetTime;
            audio.currentTime = targetTime;

            // Wait for both to be ready
            await Promise.race([
                Promise.all([
                    new Promise<void>((resolve) => {
                        const handler = () => { video.removeEventListener('canplay', handler); resolve(); };
                        if (video.readyState >= 3) resolve();
                        else video.addEventListener('canplay', handler);
                    }),
                    new Promise<void>((resolve) => {
                        const handler = () => { audio.removeEventListener('canplay', handler); resolve(); };
                        if (audio.readyState >= 3) resolve();
                        else audio.addEventListener('canplay', handler);
                    }),
                ]),
                // Timeout after 3 seconds
                new Promise<void>((_, reject) => setTimeout(() => reject(new Error('Sync timeout')), 3000)),
            ]);

            consecutiveFailuresRef.current = 0;
            updateState({ isSyncing: false, isBuffering: false, syncHealth: 'good' });
            onBufferingChange?.(false);

            if (wasPlaying) {
                await video.play();
                await audio.play();
            }

            console.log('[DashSync] Heavy sync completed successfully');
        } catch (error) {
            consecutiveFailuresRef.current++;
            const failCount = consecutiveFailuresRef.current;

            console.error(`[DashSync] Heavy sync failed (attempt ${failCount}):`, error);

            if (failCount >= MAX_CONSECUTIVE_FAILURES) {
                updateState({ syncHealth: 'failed' });
                onError?.('Synchronization failed repeatedly. Try refreshing the page.');
                // Cooldown before allowing more syncs (exponential backoff)
                const cooldown = HEAVY_SYNC_COOLDOWN_BASE_MS * Math.pow(2, failCount - 1);
                console.log(`[DashSync] Entering cooldown for ${cooldown}ms`);
            }

            // Force resume even on failure
            updateState({ isSyncing: false, isBuffering: false });
            onBufferingChange?.(false);

            if (wasPlaying) {
                video.play().catch(() => { });
                audio.play().catch(() => { });
            }
        }
    }, [updateState, onBufferingChange, onError]);

    /**
     * Safe audio play that tracks the promise to prevent race conditions
     */
    const safeAudioPlay = useCallback(async (audio: HTMLAudioElement): Promise<void> => {
        if (isPlayingAudioRef.current) {
            // Already trying to play, wait for it
            if (audioPlayPromiseRef.current) {
                return audioPlayPromiseRef.current;
            }
            return;
        }

        isPlayingAudioRef.current = true;
        try {
            audioPlayPromiseRef.current = audio.play();
            await audioPlayPromiseRef.current;
        } catch (e: unknown) {
            const error = e as Error;
            if (error.name !== 'NotAllowedError' && error.name !== 'AbortError') {
                console.warn('[DashSync] Audio play failed:', error.message);
            }
        } finally {
            audioPlayPromiseRef.current = null;
            isPlayingAudioRef.current = false;
        }
    }, []);

    /**
     * Safe audio pause that waits for any pending play promise
     */
    const safeAudioPause = useCallback(async (audio: HTMLAudioElement): Promise<void> => {
        // Wait for any pending play to complete before pausing
        if (audioPlayPromiseRef.current) {
            try {
                await audioPlayPromiseRef.current;
            } catch {
                // Ignore - we're pausing anyway
            }
        }
        audio.pause();
    }, []);

    /**
     * Attempt to recover stopped audio
     */
    const recoverAudio = useCallback(async (video: HTMLVideoElement, audio: HTMLAudioElement) => {
        if (isRecoveringRef.current) return;
        isRecoveringRef.current = true;

        try {
            audio.currentTime = video.currentTime;
            await safeAudioPlay(audio);
            console.log('[DashSync] Audio recovered successfully');
            consecutiveFailuresRef.current = 0;
        } catch (e: unknown) {
            const error = e as Error;
            if (error.name !== 'NotAllowedError' && error.name !== 'AbortError') {
                console.warn('[DashSync] Audio recovery failed:', error.message);
                consecutiveFailuresRef.current++;
            }
        } finally {
            // Delay before allowing another recovery attempt
            setTimeout(() => { isRecoveringRef.current = false; }, 1000);
        }
    }, [safeAudioPlay]);

    /**
     * Core sync loop - runs via setInterval to support background tabs
     * (requestAnimationFrame stops when tab is hidden)
     */
    const syncLoop = useCallback(() => {
        if (!enabled) return;

        const video = videoRef.current;
        const audio = audioRef.current;

        if (!video || !audio) {
            return;
        }

        const currentState = stateRef.current;

        // Update time info
        const newTime = video.currentTime;
        const newDuration = video.duration || audio.duration || 0;
        if (newTime !== currentState.currentTime || newDuration !== currentState.duration) {
            updateState({ currentTime: newTime, duration: newDuration });
            onTimeUpdate?.(newTime, newDuration);
        }

        // Skip sync logic if video is paused or seeking
        if (video.paused || video.seeking || audio.seeking || currentState.isSyncing) {
            return;
        }

        // === PREEMPTIVE BUFFER MONITORING ===
        const videoBuffer = getBufferHealth(video);
        const audioBuffer = getBufferHealth(audio);
        const minBuffer = Math.min(videoBuffer, audioBuffer);

        // Preemptively pause audio if buffer is getting low
        if (minBuffer < config.bufferThreshold && !audio.paused) {
            console.log(`[DashSync] Preemptive pause: buffer=${minBuffer.toFixed(2)}s`);
            safeAudioPause(audio);
            if (!currentState.isBuffering) {
                updateState({ isBuffering: true });
                onBufferingChange?.(true);
            }
        }

        // Resume audio if buffer recovered and video is playing
        if (minBuffer >= config.bufferThreshold && audio.paused && !video.paused && currentState.isBuffering && !isPlayingAudioRef.current) {
            console.log(`[DashSync] Buffer recovered: ${minBuffer.toFixed(2)}s, resuming audio`);
            audio.currentTime = video.currentTime; // Sync position first
            safeAudioPlay(audio);
            updateState({ isBuffering: false });
            onBufferingChange?.(false);
        }

        // === DRIFT CORRECTION (Using playback rate for smooth correction) ===
        if (!audio.paused && !isPlayingAudioRef.current) {
            const drift = audio.currentTime - video.currentTime;
            const absDrift = Math.abs(drift);

            updateState({ lastDrift: drift });

            if (absDrift > config.heavySyncThreshold) {
                // Heavy sync needed - pause both and resync
                console.warn(`[DashSync] Heavy sync triggered: drift=${drift.toFixed(3)}s`);
                performHeavySync(video, audio, video.currentTime);
            } else if (absDrift > config.driftThreshold) {
                // Use playback rate adjustment for smooth correction instead of time jumps
                // This prevents audio pops/clicks
                if (drift > 0) {
                    // Audio is ahead - slow it down slightly
                    audio.playbackRate = 0.97;
                } else {
                    // Audio is behind - speed it up slightly
                    audio.playbackRate = 1.03;
                }
                consecutiveFailuresRef.current = 0;

                if (currentState.syncHealth !== 'good') {
                    updateState({ syncHealth: 'good' });
                }
            } else {
                // Within threshold - restore normal playback rate
                if (audio.playbackRate !== 1.0) {
                    audio.playbackRate = 1.0;
                }
            }
        }

        // === AUDIO PLAYBACK RECOVERY ===
        // If video is playing but audio stopped, try to restart it
        if (!video.paused && audio.paused && audio.readyState >= 2 && !currentState.isBuffering && !isRecoveringRef.current) {
            console.log('[DashSync] Audio stopped while video playing, recovering...');
            recoverAudio(video, audio);
        }
    }, [enabled, videoRef, audioRef, config, getBufferHealth, updateState, onTimeUpdate, onBufferingChange, performHeavySync, recoverAudio, safeAudioPlay, safeAudioPause]);

    // === PUBLIC API ===

    const play = useCallback(async () => {
        const video = videoRef.current;
        const audio = audioRef.current;
        if (!video || !audio) return;

        try {
            // Sync audio position first
            audio.currentTime = video.currentTime;

            // Unmute audio on user interaction
            if (audio.muted) {
                audio.muted = false;
                updateState({ muted: false });
            }

            await video.play();
            updateState({ isPlaying: true });
            onPlayingChange?.(true);

            // Try to play audio (may fail due to autoplay policy)
            try {
                await audio.play();
                console.log('[DashSync] Both playing');
            } catch (audioErr: unknown) {
                const error = audioErr as Error;
                if (error.name === 'NotAllowedError') {
                    console.warn('[DashSync] Audio blocked by autoplay policy');
                    updateState({ muted: true });
                }
            }
        } catch (err: unknown) {
            const error = err as Error;
            // Ignore "interrupted by a new load request" error (AbortError)
            if (error.name === 'AbortError' || error.message.includes('interrupted by a new load request')) {
                console.warn('[DashSync] Play interrupted by load/pause:', error.message);
                return;
            }
            console.error('[DashSync] Play failed:', error.message);
            onError?.(error.message);
        }
    }, [videoRef, audioRef, updateState, onPlayingChange, onError]);

    const pause = useCallback(() => {
        const video = videoRef.current;
        const audio = audioRef.current;

        video?.pause();
        audio?.pause();

        updateState({ isPlaying: false });
        onPlayingChange?.(false);
    }, [videoRef, audioRef, updateState, onPlayingChange]);

    const seek = useCallback((time: number) => {
        const video = videoRef.current;
        const audio = audioRef.current;

        if (video) video.currentTime = time;
        if (audio) audio.currentTime = time;

        updateState({ currentTime: time });
    }, [videoRef, audioRef, updateState]);

    const setVolume = useCallback((volume: number) => {
        const audio = audioRef.current;
        if (audio) {
            audio.volume = volume;
            // Unmute if setting volume > 0
            if (volume > 0 && audio.muted) {
                audio.muted = false;
                updateState({ volume, muted: false });
            } else {
                updateState({ volume });
            }
        }
    }, [audioRef, updateState]);

    const setMuted = useCallback((muted: boolean) => {
        const audio = audioRef.current;
        const video = videoRef.current;

        if (audio) {
            audio.muted = muted;

            // If unmuting and audio is paused while video plays, start audio
            if (!muted && audio.paused && video && !video.paused) {
                audio.currentTime = video.currentTime;
                audio.play().catch((e) => {
                    if (e.name !== 'NotAllowedError') {
                        console.warn('[DashSync] Audio play on unmute failed:', e.message);
                    }
                });
            }
        }

        updateState({ muted });
    }, [audioRef, videoRef, updateState]);

    // === EFFECT: Start/stop sync loop (using setInterval for background tab support) ===
    useEffect(() => {
        if (!enabled) {
            if (syncIntervalIdRef.current) {
                clearInterval(syncIntervalIdRef.current);
                syncIntervalIdRef.current = null;
            }
            return;
        }

        // Start the sync loop with setInterval
        // setInterval continues running in background tabs (throttled to ~1Hz by browser)
        syncIntervalIdRef.current = setInterval(syncLoop, syncIntervalMs);

        // Also run immediately
        syncLoop();

        return () => {
            if (syncIntervalIdRef.current) {
                clearInterval(syncIntervalIdRef.current);
                syncIntervalIdRef.current = null;
            }
        };
    }, [enabled, syncLoop, syncIntervalMs]);

    // === EFFECT: Handle visibility change (tab switching) ===
    useEffect(() => {
        if (!enabled) return;

        const handleVisibilityChange = () => {
            const video = videoRef.current;
            const audio = audioRef.current;
            if (!video || !audio) return;

            if (document.visibilityState === 'visible') {
                console.log('[DashSync] Tab became visible, checking sync...');

                // Resume AudioContext if it exists and was suspended
                // (handled by useAudioNormalization, but we ensure playback resumes)

                // If video was playing, ensure audio resumes
                if (!video.paused && audio.paused) {
                    audio.currentTime = video.currentTime;
                    safeAudioPlay(audio);
                }

                // Reset playback rate in case it was adjusted
                audio.playbackRate = 1.0;
            } else {
                console.log('[DashSync] Tab became hidden');
                // We don't pause on hide - let the browser handle throttling
                // But reset playback rate to prevent issues
                audio.playbackRate = 1.0;
            }
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [enabled, videoRef, audioRef, safeAudioPlay]);

    // === EFFECT: Set up video event listeners ===
    useEffect(() => {
        const video = videoRef.current;
        const audio = audioRef.current;
        if (!video || !audio || !enabled) return;

        const onVideoPlay = () => {
            updateState({ isPlaying: true, isBuffering: false });
            onPlayingChange?.(true);

            // Start audio when video starts
            if (audio.paused) {
                audio.currentTime = video.currentTime;
                audio.play().catch((e) => {
                    if (e.name !== 'NotAllowedError') {
                        console.warn('[DashSync] Audio start failed:', e.message);
                    }
                });
            }
        };

        const onVideoPause = () => {
            // Check if this pause was browser-initiated (tab in background) or user-initiated
            // If we're in the background and didn't intend to pause, try to recover
            if (document.visibilityState === 'hidden' && stateRef.current.isPlaying) {
                console.log('[DashSync] Video paused by browser (background), attempting recovery...');
                // Small delay to avoid fighting with the browser
                setTimeout(() => {
                    if (video.paused && stateRef.current.isPlaying) {
                        video.play().catch((e) => {
                            if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') {
                                console.warn('[DashSync] Video recovery failed:', e.message);
                            }
                        });
                    }
                }, 100);
                return; // Don't update state since we're trying to recover
            }

            // User-initiated pause
            updateState({ isPlaying: false });
            onPlayingChange?.(false);
            audio.pause();
        };

        const onVideoWaiting = () => {
            console.log('[DashSync] Video waiting');
            updateState({ isBuffering: true });
            onBufferingChange?.(true);
            audio.pause(); // Stop audio immediately
        };

        const onVideoCanPlay = () => {
            if (stateRef.current.isBuffering && !stateRef.current.isSyncing) {
                updateState({ isBuffering: false });
                onBufferingChange?.(false);

                // Resume audio if video is playing
                if (!video.paused) {
                    audio.currentTime = video.currentTime;
                    audio.play().catch(() => { });
                }
            }
        };

        const onVideoSeeking = () => {
            // Pause audio during seek
            audio.pause();
        };

        const onVideoSeeked = () => {
            // Sync audio after seek
            audio.currentTime = video.currentTime;
            if (!video.paused) {
                audio.play().catch(() => { });
            }
        };

        const onVideoEnded = () => {
            updateState({ isPlaying: false });
            onPlayingChange?.(false);
            audio.pause();
        };

        // === Audio event listeners for background tab recovery ===
        const onAudioPause = () => {
            // If audio paused but video is still playing, this is likely browser throttling
            // Try to resume immediately
            if (!video.paused && !video.seeking && !stateRef.current.isSyncing) {
                console.log('[DashSync] Audio paused unexpectedly, attempting recovery...');
                // Small delay to avoid tight loop with browser
                setTimeout(() => {
                    if (!video.paused && audio.paused) {
                        audio.currentTime = video.currentTime;
                        audio.play().catch((e) => {
                            if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') {
                                console.warn('[DashSync] Audio recovery failed:', e.message);
                            }
                        });
                    }
                }, 100);
            }
        };

        const onAudioSuspend = () => {
            // Browser is suspending the audio resource (common in background)
            // Try to keep it alive by resuming
            if (!video.paused && audio.paused) {
                console.log('[DashSync] Audio suspended, attempting to keep alive...');
                audio.play().catch(() => { });
            }
        };

        video.addEventListener('play', onVideoPlay);
        video.addEventListener('pause', onVideoPause);
        video.addEventListener('waiting', onVideoWaiting);
        video.addEventListener('canplay', onVideoCanPlay);
        video.addEventListener('seeking', onVideoSeeking);
        video.addEventListener('seeked', onVideoSeeked);
        video.addEventListener('ended', onVideoEnded);

        // Audio events for background recovery
        audio.addEventListener('pause', onAudioPause);
        audio.addEventListener('suspend', onAudioSuspend);

        // Initialize audio state
        audio.volume = stateRef.current.volume;
        audio.muted = stateRef.current.muted;

        return () => {
            video.removeEventListener('play', onVideoPlay);
            video.removeEventListener('pause', onVideoPause);
            video.removeEventListener('waiting', onVideoWaiting);
            video.removeEventListener('canplay', onVideoCanPlay);
            video.removeEventListener('seeking', onVideoSeeking);
            video.removeEventListener('seeked', onVideoSeeked);
            video.removeEventListener('ended', onVideoEnded);
            audio.removeEventListener('pause', onAudioPause);
            audio.removeEventListener('suspend', onAudioSuspend);
        };
    }, [enabled, videoRef, audioRef, updateState, onPlayingChange, onBufferingChange]);

    return {
        ...state,
        play,
        pause,
        seek,
        setVolume,
        setMuted,
        getVideoBufferHealth,
        getAudioBufferHealth,
    };
}
