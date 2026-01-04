'use client';

import { useRef, useEffect, useCallback, useState } from 'react';

export interface UseAudioNormalizationOptions {
    /** The media element to process (video or audio) */
    sourceElement: HTMLMediaElement | null;
    /** Whether normalization is enabled */
    enabled: boolean;
    /** Gain value (default 1.0) */
    gain: number;
}

export interface UseAudioNormalizationReturn {
    /** Whether normalization is currently active */
    isActive: boolean;
    /** Whether AudioContext is supported */
    isSupported: boolean;
    /** Current connection status */
    connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
}

/**
 * Compressor settings for night mode / normalization
 */
const COMPRESSOR_CONFIG = {
    threshold: -24,    // dB - signals above this get compressed
    knee: 30,          // dB - soft knee for smoother compression
    ratio: 12,         // Compression ratio (12:1)
    attack: 0.003,     // seconds - fast attack
    release: 0.25,     // seconds - release time
};

/**
 * Custom hook for audio normalization using Web Audio API.
 * 
 * Applies a dynamics compressor and gain node to the audio path
 * for "night mode" style volume leveling.
 * 
 * Key features:
 * - Handles switching between source elements (video ↔ audio)
 * - Proper cleanup on unmount
 * - Graceful fallback when AudioContext is not supported
 */
export function useAudioNormalization(options: UseAudioNormalizationOptions): UseAudioNormalizationReturn {
    const { sourceElement, enabled, gain } = options;

    // Refs for audio nodes (persist across renders)
    const audioContextRef = useRef<AudioContext | null>(null);
    const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
    const compressorRef = useRef<DynamicsCompressorNode | null>(null);
    const gainNodeRef = useRef<GainNode | null>(null);
    const connectedElementRef = useRef<HTMLMediaElement | null>(null);

    // State
    const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
    const [isSupported, setIsSupported] = useState(true);

    /**
     * Create or get AudioContext
     */
    const getAudioContext = useCallback((): AudioContext | null => {
        if (audioContextRef.current) {
            return audioContextRef.current;
        }

        try {
            const AudioContextClass = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            if (!AudioContextClass) {
                console.warn('[AudioNormalization] AudioContext not supported');
                setIsSupported(false);
                return null;
            }
            audioContextRef.current = new AudioContextClass();
            return audioContextRef.current;
        } catch (e) {
            console.error('[AudioNormalization] Failed to create AudioContext:', e);
            setIsSupported(false);
            return null;
        }
    }, []);

    /**
     * Create audio processing nodes
     */
    const createNodes = useCallback((ctx: AudioContext) => {
        if (!compressorRef.current) {
            compressorRef.current = ctx.createDynamicsCompressor();
            compressorRef.current.threshold.value = COMPRESSOR_CONFIG.threshold;
            compressorRef.current.knee.value = COMPRESSOR_CONFIG.knee;
            compressorRef.current.ratio.value = COMPRESSOR_CONFIG.ratio;
            compressorRef.current.attack.value = COMPRESSOR_CONFIG.attack;
            compressorRef.current.release.value = COMPRESSOR_CONFIG.release;
        }

        if (!gainNodeRef.current) {
            gainNodeRef.current = ctx.createGain();
            gainNodeRef.current.gain.value = gain;
        }
    }, [gain]);

    /**
     * Connect source element to audio graph
     */
    const connectSource = useCallback((element: HTMLMediaElement) => {
        const ctx = getAudioContext();
        if (!ctx) {
            setConnectionStatus('error');
            return;
        }

        setConnectionStatus('connecting');

        try {
            // Disconnect old source if needed
            if (sourceNodeRef.current && connectedElementRef.current !== element) {
                try {
                    sourceNodeRef.current.disconnect();
                } catch {
                    // May already be disconnected
                }
                sourceNodeRef.current = null;
            }

            // Don't reconnect to same element
            if (connectedElementRef.current === element && sourceNodeRef.current) {
                setConnectionStatus('connected');
                return;
            }

            // Create source from media element
            // Note: MediaElementAudioSourceNode can only be created once per element
            sourceNodeRef.current = ctx.createMediaElementSource(element);
            connectedElementRef.current = element;

            // Create processing nodes
            createNodes(ctx);

            // Connect graph: Source -> Compressor -> Gain -> Destination
            sourceNodeRef.current.connect(compressorRef.current!);
            compressorRef.current!.connect(gainNodeRef.current!);
            gainNodeRef.current!.connect(ctx.destination);

            console.log('[AudioNormalization] Connected to', element.tagName);
            setConnectionStatus('connected');

            // Resume AudioContext if suspended
            if (ctx.state === 'suspended') {
                ctx.resume();
            }
        } catch (e) {
            console.error('[AudioNormalization] Connection failed:', e);
            setConnectionStatus('error');
        }
    }, [getAudioContext, createNodes]);

    /**
     * Bypass normalization (connect source directly to destination)
     */
    const bypassNormalization = useCallback(() => {
        const ctx = audioContextRef.current;
        if (!ctx || !sourceNodeRef.current) return;

        try {
            // Disconnect from processing chain
            sourceNodeRef.current.disconnect();
            if (compressorRef.current) compressorRef.current.disconnect();
            if (gainNodeRef.current) gainNodeRef.current.disconnect();

            // Connect directly to destination
            sourceNodeRef.current.connect(ctx.destination);
            console.log('[AudioNormalization] Bypassed (direct routing)');
        } catch (e) {
            console.warn('[AudioNormalization] Bypass failed:', e);
        }
    }, []);

    /**
     * Reconnect normalization chain
     */
    const reconnectNormalization = useCallback(() => {
        const ctx = audioContextRef.current;
        if (!ctx || !sourceNodeRef.current) return;

        try {
            // Disconnect from direct routing
            sourceNodeRef.current.disconnect();

            // Ensure nodes exist
            createNodes(ctx);

            // Reconnect through chain
            sourceNodeRef.current.connect(compressorRef.current!);
            compressorRef.current!.connect(gainNodeRef.current!);
            gainNodeRef.current!.connect(ctx.destination);

            console.log('[AudioNormalization] Reconnected normalization chain');
        } catch (e) {
            console.warn('[AudioNormalization] Reconnect failed:', e);
        }
    }, [createNodes]);

    // === EFFECT: Connect/disconnect based on enabled state ===
    useEffect(() => {
        if (!sourceElement || !isSupported) return;

        if (enabled) {
            // Connect to element if not already connected
            if (connectedElementRef.current !== sourceElement) {
                connectSource(sourceElement);
            } else if (connectionStatus === 'connected') {
                // Already connected, ensure chain is connected
                reconnectNormalization();
            }
        } else {
            // Bypass normalization but keep connection
            if (connectionStatus === 'connected') {
                bypassNormalization();
            }
        }
    }, [sourceElement, enabled, isSupported, connectionStatus, connectSource, bypassNormalization, reconnectNormalization]);

    // === EFFECT: Update gain value ===
    useEffect(() => {
        if (gainNodeRef.current && audioContextRef.current) {
            // Use setTargetAtTime for smooth transitions
            const currentTime = audioContextRef.current.currentTime;
            gainNodeRef.current.gain.setTargetAtTime(gain, currentTime, 0.1);
        }
    }, [gain]);

    // === EFFECT: Resume AudioContext on user interaction ===
    useEffect(() => {
        const handleInteraction = () => {
            if (audioContextRef.current?.state === 'suspended') {
                audioContextRef.current.resume();
            }
        };

        // Listen for any user interaction
        document.addEventListener('click', handleInteraction, { once: true });
        document.addEventListener('keydown', handleInteraction, { once: true });

        return () => {
            document.removeEventListener('click', handleInteraction);
            document.removeEventListener('keydown', handleInteraction);
        };
    }, []);

    // === EFFECT: Resume AudioContext when tab becomes visible ===
    useEffect(() => {
        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible' && audioContextRef.current?.state === 'suspended') {
                console.log('[AudioNormalization] Tab visible, resuming AudioContext');
                audioContextRef.current.resume();
            }
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, []);

    // === EFFECT: Cleanup on unmount ===
    useEffect(() => {
        return () => {
            if (audioContextRef.current) {
                // Close AudioContext
                audioContextRef.current.close().catch(() => { });
                audioContextRef.current = null;
            }
            sourceNodeRef.current = null;
            compressorRef.current = null;
            gainNodeRef.current = null;
            connectedElementRef.current = null;
        };
    }, []);

    return {
        isActive: enabled && connectionStatus === 'connected',
        isSupported,
        connectionStatus,
    };
}
