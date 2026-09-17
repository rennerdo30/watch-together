'use client';

import { useRef, useEffect, useCallback, useState } from 'react';

import { createMonoDownmix } from '@/lib/mono-audio';

export interface UseAudioProcessingOptions {
    /** The media element to process (video or audio) */
    sourceElement: HTMLMediaElement | null;
    /** Level the audio with a compressor and make-up gain ("night mode") */
    normalize: boolean;
    /** Make-up gain applied after the compressor (default 1.0) */
    gain: number;
    /** Fold every channel into one, played identically by both speakers */
    mono: boolean;
}

export interface UseAudioProcessingReturn {
    /** Whether the compressor is in the path right now */
    normalizeActive: boolean;
    /** Whether the downmix is in the path right now */
    monoActive: boolean;
}

// Global WeakMap to track which elements have MediaElementSourceNodes
// This is CRITICAL because createMediaElementSource() can only be called once per element
const connectedElements = new WeakMap<HTMLMediaElement, {
    sourceNode: MediaElementAudioSourceNode;
    audioContext: AudioContext;
}>();

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
 * Custom hook for the player's audio graph (Web Audio API).
 *
 * Both stages are optional and independent: volume levelling for night
 * listening, and a mono downmix. They share one AudioContext and one
 * MediaElementAudioSourceNode because a media element can be the source of
 * exactly one such node, ever — a second hook owning a second graph for the
 * same element is impossible, not merely wasteful.
 *
 * Key features:
 * - Handles switching between source elements (video <-> audio)
 * - Proper cleanup on unmount
 * - Graceful fallback when AudioContext is not supported
 * - Touches nothing until a stage is switched on, so a viewer using neither
 *   never spends one of the browser's handful of AudioContexts
 */
export function useAudioProcessing(options: UseAudioProcessingOptions): UseAudioProcessingReturn {
    const { sourceElement, normalize, gain, mono } = options;

    // Refs for audio nodes (persist across renders)
    const audioContextRef = useRef<AudioContext | null>(null);
    const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
    const compressorRef = useRef<DynamicsCompressorNode | null>(null);
    const gainNodeRef = useRef<GainNode | null>(null);
    const monoNodeRef = useRef<GainNode | null>(null);
    const connectedElementRef = useRef<HTMLMediaElement | null>(null);
    // The make-up gain moves on its own slider; reading it through a ref keeps
    // it out of the routing callbacks, which must not be rebuilt for a volume
    // change (that would tear down and re-create the graph mid-playback).
    const gainRef = useRef(gain);

    // State
    const [isConnected, setIsConnected] = useState(false);
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
                console.warn('[AudioProcessing] AudioContext not supported');
                setIsSupported(false);
                return null;
            }
            audioContextRef.current = new AudioContextClass();
            return audioContextRef.current;
        } catch (e) {
            console.error('[AudioProcessing] Failed to create AudioContext:', e);
            setIsSupported(false);
            return null;
        }
    }, []);

    /**
     * Route the source through the stages that are switched on.
     *
     * The chain is rebuilt from the source every time rather than patched, so
     * switching a stage off cannot leave a stale edge feeding the destination
     * twice (which is audible: a doubled signal, 6 dB louder).
     */
    const applyRouting = useCallback(() => {
        const ctx = audioContextRef.current;
        const source = sourceNodeRef.current;
        if (!ctx || !source) return;

        source.disconnect();
        compressorRef.current?.disconnect();
        gainNodeRef.current?.disconnect();
        monoNodeRef.current?.disconnect();

        let tail: AudioNode = source;

        if (normalize) {
            if (!compressorRef.current) {
                const compressor = ctx.createDynamicsCompressor();
                compressor.threshold.value = COMPRESSOR_CONFIG.threshold;
                compressor.knee.value = COMPRESSOR_CONFIG.knee;
                compressor.ratio.value = COMPRESSOR_CONFIG.ratio;
                compressor.attack.value = COMPRESSOR_CONFIG.attack;
                compressor.release.value = COMPRESSOR_CONFIG.release;
                compressorRef.current = compressor;
            }
            if (!gainNodeRef.current) {
                gainNodeRef.current = ctx.createGain();
                gainNodeRef.current.gain.value = gainRef.current;
            }
            tail.connect(compressorRef.current);
            compressorRef.current.connect(gainNodeRef.current);
            tail = gainNodeRef.current;
        }

        if (mono) {
            if (!monoNodeRef.current) {
                monoNodeRef.current = createMonoDownmix(ctx);
            }
            tail.connect(monoNodeRef.current);
            tail = monoNodeRef.current;
        }

        tail.connect(ctx.destination);

        if (ctx.state === 'suspended') {
            ctx.resume();
        }
    }, [normalize, mono]);

    /**
     * Connect source element to audio graph. Idempotent: the source node for a
     * given element is created once and reused.
     */
    const connectSource = useCallback((element: HTMLMediaElement): boolean => {
        if (connectedElementRef.current === element && sourceNodeRef.current) {
            return true;
        }

        const ctx = getAudioContext();
        if (!ctx) return false;

        try {
            // Disconnect old source if switching elements
            if (sourceNodeRef.current) {
                try {
                    sourceNodeRef.current.disconnect();
                } catch {
                    // May already be disconnected
                }
                sourceNodeRef.current = null;
            }

            // Check if this element was already connected (possibly in a previous render)
            // MediaElementAudioSourceNode can only be created ONCE per element EVER
            const existing = connectedElements.get(element);
            if (existing) {
                // A source node belongs to the context that created it; a new
                // context cannot adopt it and the element's audio is stuck in
                // the old graph.
                if (existing.audioContext !== ctx) {
                    console.warn('[AudioProcessing] Element was connected to a different AudioContext, cannot reconnect');
                    return false;
                }
                sourceNodeRef.current = existing.sourceNode;
                console.log('[AudioProcessing] Reusing existing source node for', element.tagName);
            } else {
                sourceNodeRef.current = ctx.createMediaElementSource(element);
                connectedElements.set(element, {
                    sourceNode: sourceNodeRef.current,
                    audioContext: ctx,
                });
            }

            connectedElementRef.current = element;
            console.log('[AudioProcessing] Connected to', element.tagName);
            return true;
        } catch (e) {
            console.error('[AudioProcessing] Connection failed:', e);
            return false;
        }
    }, [getAudioContext]);

    // === EFFECT: Build and maintain the graph for the current options ===
    useEffect(() => {
        if (!sourceElement || !isSupported) return;
        // Nothing switched on and nothing built yet: leave the element alone.
        // Once a source node exists the element's audio only reaches the
        // speakers through the graph, so it must still be routed.
        if (!normalize && !mono && !audioContextRef.current) return;

        // Deferred so the connection does not run inside the effect that
        // renders the element, and a burst of toggles settles into one rebuild.
        const timerId = window.setTimeout(() => {
            const connected = connectSource(sourceElement);
            if (connected) applyRouting();
            setIsConnected(connected);
        }, 0);
        return () => window.clearTimeout(timerId);
    }, [sourceElement, normalize, mono, isSupported, connectSource, applyRouting]);

    // === EFFECT: Update gain value ===
    useEffect(() => {
        gainRef.current = gain;
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
                console.log('[AudioProcessing] Tab visible, resuming AudioContext');
                audioContextRef.current.resume();
            }
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, []);

    // === EFFECT: Close AudioContext when source element changes or on unmount ===
    // This prevents leaking AudioContexts (browsers limit to ~6 concurrent ones)
    useEffect(() => {
        return () => {
            if (audioContextRef.current) {
                audioContextRef.current.close().catch(() => { });
                audioContextRef.current = null;
            }
            sourceNodeRef.current = null;
            compressorRef.current = null;
            gainNodeRef.current = null;
            monoNodeRef.current = null;
            connectedElementRef.current = null;
            setIsConnected(false);
        };
    }, [sourceElement]);

    return {
        normalizeActive: normalize && isConnected,
        monoActive: mono && isConnected,
    };
}
