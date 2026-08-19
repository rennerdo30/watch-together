'use client';

import { useRef, useEffect, useCallback, useState } from 'react';

import {
    SHAKA_BUFFER_GOAL_SECONDS,
    SHAKA_BUFFER_BEHIND_SECONDS,
    SHAKA_REBUFFER_GOAL_SECONDS,
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
    bandwidth: number;
    droppedFrames: number;
    videoCodec: string;
    audioCodec: string;
}

export interface UseShakaPlayerOptions {
    videoRef: React.RefObject<HTMLVideoElement | null>;
    /** Manifest URL. Ignored while `enabled` is false. */
    manifestUrl: string;
    enabled: boolean;
    autoPlay?: boolean;
    initialTime?: number;
    onError?: (error: string) => void;
    onLoadingChange?: (isLoading: boolean) => void;
    onBufferingChange?: (isBuffering: boolean) => void;
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
    droppedFrames: 0,
    videoCodec: '',
    audioCodec: '',
};

const AUTO_QUALITY = -1;

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

interface ShakaErrorEvent {
    detail?: { code?: number };
    code?: number;
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
    const {
        videoRef,
        manifestUrl,
        enabled,
        autoPlay = false,
        initialTime = 0,
    } = options;

    const playerRef = useRef<ShakaPlayerInstance | null>(null);
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

        const onErrorEvent = (event: Event) => {
            const shakaEvent = event as Event & ShakaErrorEvent;
            const detail = shakaEvent.detail ?? shakaEvent;
            const code = detail?.code;
            console.error('[ShakaPlayer] Playback error', detail);
            if (cancelled) return;
            setLoading(false);
            callbackRefs.current.onError?.(
                `Playback failed (code ${code ?? 'unknown'})`
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
            setStats({
                bandwidth: active?.bandwidth ?? 0,
                droppedFrames: 0,
                videoCodec: active?.videoCodec ?? '',
                audioCodec: active?.audioCodec ?? '',
            });
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
                },
            });

            instance.addEventListener('error', onErrorEvent);
            instance.addEventListener('buffering', onBuffering);
            instance.addEventListener('trackschanged', onTracksChanged);
            instance.addEventListener('adaptation', onTracksChanged);

            setLoading(true);
            try {
                await instance.load(manifestUrl, initialTime > 0 ? initialTime : undefined);
                if (cancelled) return;
                onTracksChanged();
                setLoading(false);

                if (autoPlay) {
                    video.muted = localStorage.getItem('w2g-player-muted') === 'true';
                    video.play().catch(() => {
                        console.log('[ShakaPlayer] Autoplay blocked');
                    });
                }
            } catch (error: unknown) {
                if (cancelled) return;
                console.error('[ShakaPlayer] Could not load manifest', error);
                setLoading(false);
                callbackRefs.current.onError?.('The video could not be loaded');
            }
        };

        setup();

        return () => {
            cancelled = true;
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
    }, [enabled, manifestUrl, videoRef, autoPlay, initialTime]);

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
