'use client';

import { useRef, useEffect, useCallback, useState } from 'react';

import { reportClientError } from '@/lib/client-errors';
import { createMonoDownmix } from '@/lib/mono-audio';

export interface UseAudioProcessingOptions {
    /** The media element to process (video or audio) */
    sourceElement: HTMLMediaElement | null;
    /** Level the audio with a compressor and make-up gain ("night mode") */
    nightMode: boolean;
    /** Make-up gain applied after the compressor (default 1.0) */
    gain: number;
    normalizeLoudness?: boolean;
    /** Fold every channel into one, played identically by both speakers */
    mono: boolean;
    /** Fixed local presentation buffer used by frame interpolation. */
    delayMs?: number;
    prepareDelay?: boolean;
}

export interface UseAudioProcessingReturn {
    /** Whether the compressor is in the path right now */
    nightModeActive: boolean;
    /** Whether the downmix is in the path right now */
    monoActive: boolean;
    delayReady: boolean;
    loudnessStatus: 'off' | 'starting' | 'active' | 'unavailable';
    loudnessGainDb: number;
}

// Global WeakMap to track which elements have MediaElementSourceNodes
// This is CRITICAL because createMediaElementSource() can only be called once per element
const normalizerModules = new WeakMap<AudioContext, Promise<void>>();

const connectedElements = new WeakMap<HTMLMediaElement, {
    sourceNode: MediaElementAudioSourceNode;
    audioContext: AudioContext;
}>();

/**
 * Compressor settings for night mode
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
 * Independent stages: Night mode compression, mono downmix, streaming
 * loudness normalization and optional frame-generation audio delay. They share one AudioContext and one
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
    const { sourceElement, nightMode, gain, mono, normalizeLoudness = false, delayMs = 0, prepareDelay = false } = options;

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
    const delayRef = useRef<DelayNode | null>(null);
    const delayMsRef = useRef(delayMs);
    const [audioRunning, setAudioRunning] = useState(false);
    const normalizerRef = useRef<AudioWorkletNode | null>(null);
    const [normalizerReady, setNormalizerReady] = useState(false);
    const [normalizerFailed, setNormalizerFailed] = useState(false);
    const [loudnessGainDb, setLoudnessGainDb] = useState(0);

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
            const context = audioContextRef.current;
            context.onstatechange = () => setAudioRunning(context.state === 'running');
            setAudioRunning(context.state === 'running');
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
        delayRef.current?.disconnect();
        normalizerRef.current?.disconnect();

        let tail: AudioNode = source;

        if (nightMode) {
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

        if (normalizeLoudness && normalizerReady && normalizerRef.current) {
            tail.connect(normalizerRef.current);
            tail = normalizerRef.current;
        }
        if (prepareDelay || delayRef.current) {
            delayRef.current ??= ctx.createDelay(0.5);
            delayRef.current.delayTime.value = delayMsRef.current / 1000;
            tail.connect(delayRef.current);
            tail = delayRef.current;
        }
        tail.connect(ctx.destination);

        if (ctx.state === 'suspended') {
            ctx.resume();
        }
    }, [nightMode, mono, prepareDelay, normalizeLoudness, normalizerReady]);

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
        if (!nightMode && !normalizeLoudness && !mono && !prepareDelay && !audioContextRef.current) return;

        // Deferred so the connection does not run inside the effect that
        // renders the element, and a burst of toggles settles into one rebuild.
        const timerId = window.setTimeout(() => {
            const connected = connectSource(sourceElement);
            if (connected) applyRouting();
            setIsConnected(connected);
        }, 0);
        return () => window.clearTimeout(timerId);
    }, [sourceElement, nightMode, normalizeLoudness, mono, prepareDelay, isSupported, connectSource, applyRouting]);

    useEffect(() => {
        delayMsRef.current = delayMs;
        if (delayRef.current && audioContextRef.current) {
            delayRef.current.delayTime.setValueAtTime(Math.min(0.12, Math.max(0, delayMs / 1000)), audioContextRef.current.currentTime);
        }
    }, [delayMs]);

    // The module is loaded only after local opt-in. Base routing stays audible
    // while it loads, and a failed processor is removed from the signal path.
    useEffect(() => {
        if (!normalizeLoudness || !isConnected || !sourceElement) return;
        const context = audioContextRef.current;
        if (!context) return;
        let cancelled = false;
        void (async () => {
            try {
                if (!normalizerRef.current) {
                    if (!normalizerModules.has(context)) {
                        const workletLoad = context.audioWorklet.addModule('/audio/v1/normalizer.worklet.js');
                        normalizerModules.set(context, workletLoad);
                        void workletLoad.catch(() => normalizerModules.delete(context));
                    }
                    await normalizerModules.get(context);
                    if (cancelled || context.state === 'closed') return;
                    const node = new AudioWorkletNode(context, 'w2g-loudness-normalizer', {
                        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
                        channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
                    });
                    node.port.onmessage = ({ data }) => {
                        if (normalizerRef.current === node && Number.isFinite(data.gainDb)) setLoudnessGainDb(data.gainDb);
                    };
                    node.addEventListener('processorerror', () => {
                        if (normalizerRef.current !== node) return;
                        normalizerRef.current = null; node.disconnect(); node.port.close();
                        setNormalizerFailed(true); setNormalizerReady(false);
                        reportClientError({ source: 'media', message: 'Volume normalization processor failed; original audio routing restored' });
                    });
                    normalizerRef.current = node;
                }
                normalizerRef.current.port.postMessage({ type: 'volume', volume: sourceElement.muted ? 0 : sourceElement.volume });
                normalizerRef.current.port.postMessage({ type: 'reset' });
                setNormalizerFailed(false); setNormalizerReady(true);
            } catch { if (!cancelled) { setNormalizerFailed(true); setNormalizerReady(false); reportClientError({ source: 'media', message: 'Volume normalization could not load; original audio routing retained' }); } }
        })();
        return () => {
            cancelled = true;
            const node = normalizerRef.current;
            if (node) {
                node.port.postMessage({ type: 'dispose' }); node.disconnect(); node.port.close();
                normalizerRef.current = null;
            }
            setNormalizerReady(false);
        };
    }, [normalizeLoudness, isConnected, sourceElement]);

    useEffect(() => {
        if (!sourceElement) return;
        const reset = () => normalizerRef.current?.port.postMessage({ type: 'reset' });
        const volume = () => normalizerRef.current?.port.postMessage({ type: 'volume', volume: sourceElement.muted ? 0 : sourceElement.volume });
        sourceElement.addEventListener('volumechange', volume);
        for (const event of ['seeking', 'emptied', 'loadeddata']) sourceElement.addEventListener(event, reset);
        return () => { sourceElement.removeEventListener('volumechange', volume); for (const event of ['seeking', 'emptied', 'loadeddata']) sourceElement.removeEventListener(event, reset); };
    }, [sourceElement]);

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
            delayRef.current = null;
            if (normalizerRef.current) {
                normalizerRef.current.port.onmessage = null;
                normalizerRef.current.disconnect(); normalizerRef.current.port.close(); normalizerRef.current = null;
            }
            setNormalizerReady(false);
            connectedElementRef.current = null;
            setIsConnected(false);
        };
    }, [sourceElement]);

    return {
        nightModeActive: nightMode && isConnected,
        monoActive: mono && isConnected,
        delayReady: prepareDelay && isConnected && audioRunning,
        loudnessStatus: !normalizeLoudness ? 'off' : normalizerFailed || !isSupported ? 'unavailable' : normalizerReady && isConnected ? 'active' : 'starting',
        loudnessGainDb,
    };
}
