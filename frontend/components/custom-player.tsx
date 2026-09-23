'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { Loader2, Info, Activity, Play, VolumeX } from 'lucide-react';
import { PlayerControls } from './player-controls';
import { QualityOption } from '@/lib/api';
import {
    useAudioProcessing, useHlsPlayer, useShakaPlayer, HlsQualityLevel, AUTO_QUALITY,
    type ShakaLoadPlan, type ShakaPreloadTarget,
} from './player/hooks';
import { startPlayback, type PlaybackStart } from '@/lib/playback';
import type { SponsorSegment } from '@/lib/sponsorblock';
import type { Storyboard } from '@/lib/storyboard';
import type { VideoChapter } from '@/lib/chapters';
import { useLocalStorageState, parseStoredBoolean } from '@/lib/hooks/useLocalStorageState';
import { DEFAULT_QUALITY_MODE, QUALITY_MODE_STORAGE_KEY, parseQualityMode, type QualityMode } from '@/lib/quality-mode';
import { forgetBandwidth, readRememberedEstimate } from '@/lib/bandwidth-memory';
import {
    PLAYER_STATS_REFRESH_MS, QUALITY_REPORT_INTERVAL_MS,
    SHARE_LIVE_EDGE_CHECK_MS, SHARE_LIVE_EDGE_MAX_SECONDS, SHAKA_PREFERRED_VIDEO_CODECS,
} from '@/lib/constants';
import { useVideoEnhancement } from './player/hooks/useVideoEnhancement';

interface CustomPlayerProps {
    url: string | { src: string; type: string };
    poster?: string;
    title?: string;
    autoPlay?: boolean;
    className?: string;
    isLive?: boolean;
    initialTime?: number;
    onPlay?: () => void;
    onPlaying?: () => void;
    onPause?: () => void;
    onSeeked?: (time: number) => void;
    onEnd?: () => void;
    /** The CDN rejected the stream URL (403/410) — it needs re-resolving. */
    onSourceExpired?: () => Promise<void>;
    playerRef?: React.MutableRefObject<PlayerAPI | null>;
    onTimeUpdate?: (time: number, isPlaying: boolean) => void;
    syncThreshold?: number;
    onSyncThresholdChange?: (val: number) => void;
    // DASH-specific props
    streamType?: 'hls' | 'dash' | 'combined' | 'video_only' | 'default' | 'unknown';
    videoUrl?: string;
    audioUrl?: string;
    /** Manifest describing the adaptive streams, used by the MSE engine. */
    manifestUrl?: string;
    /** The page the video came from, as the room knows it. */
    originalUrl?: string;
    /** The video's rungs; the opening rung is capped from these. */
    availableQualities?: QualityOption[];
    /**
     * The adaptive video the room is expected to play next. The player
     * preloads it, and an advance to it starts from what is already here.
     */
    preloadNext?: ShakaPreloadTarget | null;
    /**
     * The player is about to want the bytes at one position of one video:
     * a load or a preload is starting, or the pointer rests on the seek bar.
     */
    onPrewarm?: (request: PrewarmRequest) => void;
    /** Milestones of this video's start, for the room's startup telemetry. */
    onStartupMark?: (mark: StartupMark) => void;
    /** SponsorBlock segments of this video, marked on the seek bar. */
    sponsorSegments?: SponsorSegment[];
    /** Preview thumbnails for the seek bar, when the site provides them. */
    storyboard?: Storyboard;
    /** Chapters of the video, marked on the seek bar and named beside the time. */
    chapters?: VideoChapter[];
    /**
     * A member's screen, live.
     *
     * Two shapes, one seam, because the sharer and the room are watching
     * the same picture by different routes. The sharer holds the capture
     * itself — a `MediaStream`, which goes on `srcObject` with no encoding,
     * no server and no delay. Everyone else is watching what the server
     * relayed, which arrives as container chunks and therefore as a
     * `MediaSource`: a string, which goes on `src`.
     *
     * Either way the engines stand down and there is nothing to resolve or
     * proxy, and everything around it — volume, mute, fullscreen, the audio
     * graph, the autoplay gate — is the same code that serves a video.
     */
    shareSource?: MediaStream | string | null;
    /**
     * What this player can see about its own picture. Auto quality is
     * decided here, from inputs that exist nowhere else — the size the
     * video is drawn at, the pixel ratio, the measured bandwidth, the
     * frames the decoder dropped — so a viewer reporting "it is always
     * blurry for me" is otherwise unanswerable.
     */
    onQualityReport?: (report: QualityReport) => void;
}

export interface PrewarmRequest {
    originalUrl: string;
    seconds: number;
    height: number;
    codec?: string;
}

/** A milestone of a video's start; see lib/playback-timing.ts. */
export type StartupMark = { originalUrl?: string } & (
    | { kind: 'manifest'; preloaded: boolean }
    | { kind: 'first-frame'; height: number }
    | { kind: 'playing' }
    | { kind: 'stall' }
);

/** The codec family of a codec string, as the prewarm endpoint names it. */
const codecFamilyOf = (codec: string) =>
    SHAKA_PREFERRED_VIDEO_CODECS.find((family) => codec.startsWith(family));

export interface QualityReport {
    rung: number;
    cap: number | null;
    surface_px: number;
    pixel_ratio: number;
    estimate_bps: number;
    dropped_frames: number;
    ladder_rungs: number;
    mode: QualityMode;
    engine: 'mse' | 'hls';
}

interface PlayerAPI {
    play: () => Promise<void> | void;
    pause: () => void;
    currentTime: (time?: number) => number;
    getDuration: () => number;
    getVideoElement: () => HTMLVideoElement | null;
}


// Idle time before the controls fade while playing.
const CONTROLS_HIDE_DELAY_MS = 3000;
// A click that arrives together with the pointer movement that woke the
// faded controls is a reach for a control, not a request to pause: the
// overlay is still pointer-events-none when the click lands, so it would
// fall through to the video's click-to-pause. Clicks inside this window
// after a wake-up only reveal the controls.
const WAKE_CLICK_GRACE_MS = 500;

const parseStoredVolume = (stored: string | null, fallback: number) => {
    if (stored === null) return fallback;
    const parsed = Number.parseFloat(stored);
    return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : fallback;
};

const parseStoredQualityMode = (stored: string | null, fallback: QualityMode) =>
    stored === null ? fallback : parseQualityMode(stored);

/** How long ago a remembered measurement was taken, for the stats overlay. */
const formatAge = (ageMs: number) => {
    const minutes = Math.round(ageMs / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    return `${Math.round(minutes / 60)} h ago`;
};

const parseStoredGain = (stored: string | null, fallback: number) => {
    if (stored === null) return fallback;
    const parsed = Number.parseFloat(stored);
    return Number.isFinite(parsed) ? Math.min(3, Math.max(0.5, parsed)) : fallback;
};

/**
 * CustomPlayer - Unified video player supporting both HLS and DASH (separate video/audio) streams.
 * 
 * Architecture:
 * - HLS mode: Uses HLS.js for adaptive streaming
 * - DASH mode: Uses Shaka through MSE, fed by the generated manifest, so one
 *   element carries both tracks against a single clock
 * - Both modes: Use useAudioProcessing for night mode levelling and mono downmix
 */
export function CustomPlayer({
    url,
    poster,
    autoPlay = false,
    className,
    isLive,
    initialTime = 0,
    onPlay,
    onPlaying,
    onPause,
    onSeeked,
    onEnd,
    onSourceExpired,
    playerRef,
    onTimeUpdate,
    syncThreshold,
    onSyncThresholdChange,
    streamType,
    videoUrl,
    audioUrl,
    manifestUrl,
    originalUrl,
    availableQualities,
    preloadNext,
    onPrewarm,
    onStartupMark,
    sponsorSegments,
    storyboard,
    chapters,
    shareSource,
    onQualityReport,
}: CustomPlayerProps) {
    // === REFS ===
    const videoRef = useRef<HTMLVideoElement>(null);
    const [mediaElement, setMediaElement] = useState<HTMLVideoElement | null>(null);
    const setVideoElement = useCallback((element: HTMLVideoElement | null) => {
        videoRef.current = element;
        setMediaElement(element);
    }, []);
    const containerRef = useRef<HTMLDivElement>(null);
    // Seeks commanded through the player API (sync corrections, server
    // broadcasts) rather than by this viewer. `seeked` fires only when the
    // seek completes — after buffering, which can be seconds — so a fixed
    // suppression window cannot tell the two apart: it swallowed user seeks
    // that completed near an incoming message and echoed server seeks that
    // completed after the window. Matching the landing position against the
    // commanded targets can.
    const pendingProgrammaticSeeksRef = useRef<{ time: number; at: number }[]>([]);
    const pendingProgrammaticPauseRef = useRef(false);

    // A live share is its own source: no manifest, no proxy, no engine.
    const isShareMode = !!shareSource;
    // Adaptive streams play through one media element, fed by the generated
    // manifest, so the browser muxes audio and video against a single clock.
    const isMseMode = !isShareMode && streamType === 'dash' && !!manifestUrl;
    const src = typeof url === 'string' ? url : url.src;
    const { hostRef: enhancementHostRef, mode: enhancementMode, setMode: setEnhancementMode, status: enhancementStatus } =
        useVideoEnhancement(mediaElement, isMseMode ? manifestUrl! : src);

    // === UI STATE ===
    const [showControls, setShowControls] = useState(true);
    // Whether the controls are currently faded, readable synchronously from
    // event handlers (state lags a render behind the pointer).
    const controlsHiddenRef = useRef(false);
    // When a pointer movement last brought faded controls back.
    const lastWakeAtRef = useRef(0);
    // The pointer is over the control bar: never fade underneath it.
    const pointerOverControlsRef = useRef(false);
    const [showStats, setShowStats] = useState(false);
    // What auto quality will open the next video on. Read while the overlay
    // is on screen: a viewer stuck on a low rendition needs to see whether a
    // bad measurement from an earlier session is what keeps putting them
    // there — it is the one input to the decision that outlives the page.
    const [remembered, setRemembered] = useState<{ bps: number; ageMs: number } | null>(null);
    const [showSettings, setShowSettings] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // What the browser's autoplay policy did to the last attempt to start.
    // 'blocked' means this viewer is stopped while the room plays on, and only
    // a click of theirs can fix it.
    const [playbackGate, setPlaybackGate] = useState<PlaybackStart>('started');

    // === PLAYBACK STATE ===
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [isPlaying, setIsPlaying] = useState(false);
    const [liveLatency, setLiveLatency] = useState(0);
    const [seekableRange, setSeekableRange] = useState({ start: 0, end: 0 });

    // === ONE PLAYER, MANY VIDEOS ===
    // An adaptive video is loaded into the element already on screen rather
    // than into a new one, so everything this component knows about the
    // *previous* video has to be forgotten here — a remount used to do it.
    // Adjusted during render, not in an effect, so the next video never
    // renders a frame with the last one's error, clock or quality list.
    const sourceKey = isShareMode ? 'share' : isMseMode ? manifestUrl! : src;
    const [currentSource, setCurrentSource] = useState(sourceKey);
    if (currentSource !== sourceKey) {
        setCurrentSource(sourceKey);
        setError(null);
        setPlaybackGate('started');
        setCurrentTime(0);
        setDuration(0);
        setIsPlaying(false);
        setLiveLatency(0);
        setSeekableRange({ start: 0, end: 0 });
    }
    useEffect(() => {
        // Commanded seeks and pauses belong to the video they were aimed at.
        pendingProgrammaticSeeksRef.current = [];
        pendingProgrammaticPauseRef.current = false;
    }, [sourceKey]);

    // === PERSISTED AUDIO PREFERENCES ===
    // useSyncExternalStore gives hydration the server defaults, then reads the
    // browser snapshot and updates every subscriber. Unlike a mount effect, it
    // cannot leave React controls on the stored value while the media element
    // is stuck on the first render's defaults.
    const [volume, setVolume] = useLocalStorageState(
        'w2g-player-volume', 1, parseStoredVolume);
    const [isMuted, setIsMuted] = useLocalStorageState(
        'w2g-player-muted', false, parseStoredBoolean);
    const [isNormalizationEnabled, setIsNormalizationEnabled] = useLocalStorageState(
        'w2g-player-normalization', true, parseStoredBoolean);
    const [normalizationGain, setNormalizationGain] = useLocalStorageState(
        'w2g-player-normalization-gain', 1, parseStoredGain);
    // Mono is one viewer's choice about their own speakers, so it is stored
    // per browser and never sent to the room.
    const [isMonoEnabled, setIsMonoEnabled] = useLocalStorageState(
        'w2g-player-mono', false, parseStoredBoolean);
    // What auto quality optimises for. Also this viewer's own business: it
    // describes their screen and their link, not the room's video.
    const [qualityMode, setQualityMode] = useLocalStorageState<QualityMode>(
        QUALITY_MODE_STORAGE_KEY, DEFAULT_QUALITY_MODE, parseStoredQualityMode);

    // === HLS PLAYER HOOK ===
    const [hlsLoading, setHlsLoading] = useState(true);
    const [hlsQualities, setHlsQualities] = useState<HlsQualityLevel[]>([]);

    const hlsPlayer = useHlsPlayer({
        videoRef,
        // HLS handles the sources MSE does not.
        src: isMseMode || isShareMode ? '' : src,
        enabled: !isMseMode && !isShareMode,
        autoPlay,
        initialTime,
        isLive,
        onManifestParsed: (levels: HlsQualityLevel[]) => {
            setHlsQualities(levels);
            setHlsLoading(false);
            onStartupMark?.({ kind: 'manifest', preloaded: false, originalUrl });
        },
        onError: setError,
        onSourceExpired,
        onLoadingChange: setHlsLoading,
        onPlaybackStart: setPlaybackGate,
    });

    // === MSE PLAYER HOOK (single element, manifest-driven) ===
    const shakaPlayer = useShakaPlayer({
        videoRef,
        manifestUrl: manifestUrl ?? '',
        originalUrl,
        enabled: isMseMode && !isShareMode,
        ladder: availableQualities,
        preload: preloadNext,
        qualityMode,
        autoPlay,
        initialTime,
        onError: setError,
        onSourceExpired,
        onPlaybackStart: setPlaybackGate,
        onLoadPlan: (plan: ShakaLoadPlan) => {
            if (!plan.originalUrl) return;
            onPrewarm?.({ originalUrl: plan.originalUrl, seconds: plan.startTime, height: plan.height, codec: plan.codec });
        },
        onManifestReady: (preloaded: boolean) => onStartupMark?.({ kind: 'manifest', preloaded, originalUrl }),
    });

    // Derive loading/qualities/currentQuality from the active engine
    const isLoading = isMseMode ? shakaPlayer.isLoading : hlsLoading;
    const qualities = isMseMode ? shakaPlayer.qualities : hlsQualities;
    const currentQuality = isMseMode ? shakaPlayer.currentQuality : hlsPlayer.currentLevel;

    // === AUDIO PROCESSING HOOK ===
    // Both engines carry audio on the video element.
    const audio = useAudioProcessing({
        sourceElement: mediaElement,
        normalize: isNormalizationEnabled,
        gain: normalizationGain,
        mono: isMonoEnabled,
    });

    const isBuffering = isMseMode ? shakaPlayer.isBuffering : hlsPlayer.isBuffering;

    // === A LIVE SHARE IS HANDED TO THE ELEMENT DIRECTLY ===
    // No engine, no manifest, no proxy: either the capture itself on
    // `srcObject`, or the relayed stream's `MediaSource` on `src`.
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        if (shareSource instanceof MediaStream) {
            if (video.srcObject !== shareSource) {
                video.removeAttribute('src');
                video.srcObject = shareSource;
                void startPlayback(video).then(setPlaybackGate);
            }
            return;
        }
        if (typeof shareSource === 'string') {
            if (video.src === shareSource) return;
            video.srcObject = null;
            video.src = shareSource;
            // Nothing is decodable the instant the object URL is set: the
            // first chunk still has to arrive and be appended. The listener
            // is removed on the way out, because a source that is replaced
            // before it ever loaded — a resync does exactly that — would
            // otherwise leave one behind for every attempt.
            const start = () => { void startPlayback(video).then(setPlaybackGate); };
            video.addEventListener('loadeddata', start, { once: true });
            return () => video.removeEventListener('loadeddata', start);
        }
        if (video.srcObject) video.srcObject = null;
    }, [shareSource, mediaElement]);

    // === A SHARE IS ONLY WORTH WATCHING LIVE ===
    // Every stall leaves the element playing at 1x from wherever it stopped,
    // so delay accumulates and never comes back on its own. Past
    // SHARE_LIVE_EDGE_MAX_SECONDS behind the newest buffered frame, the
    // viewer is simply moved forward — a visible jump, and better than
    // watching a conversation that finished half a minute ago.
    useEffect(() => {
        if (typeof shareSource !== 'string') return;
        const video = videoRef.current;
        if (!video) return;
        const interval = setInterval(() => {
            const buffered = video.buffered;
            if (!buffered.length) return;
            const edge = buffered.end(buffered.length - 1);
            if (edge - video.currentTime > SHARE_LIVE_EDGE_MAX_SECONDS) {
                video.currentTime = edge;
            }
        }, SHARE_LIVE_EDGE_CHECK_MS);
        return () => clearInterval(interval);
    }, [shareSource, mediaElement]);

    // === KEEP MEDIA AND CONTROLS ON ONE VOLUME STATE ===
    // A queue transition remounts the player and creates a new media element at
    // the browser defaults (volume 1, unmuted). Persisted preferences are read
    // after hydration, so a mount-only effect captures those defaults and never
    // sees the state update: the slider says 25% while the new video plays at
    // 100%. React state is authoritative, and every change is applied to the
    // current element. Autoplay-policy muting remains transient because it does
    // not change `isMuted`.
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        video.volume = volume;
        video.muted = isMuted;
    }, [volume, isMuted]);

    // === VIDEO EVENT HANDLERS (non-DASH mode) ===
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        const handleVideoPlay = () => {
            setIsPlaying(true);
            onPlay?.();
        };
        const handleVideoPause = () => {
            setIsPlaying(false);
            if (pendingProgrammaticPauseRef.current) {
                pendingProgrammaticPauseRef.current = false;
                return;
            }
            if (!video.ended && video.readyState >= 2) onPause?.();
        };
        const handleVideoSeeked = () => {
            const landed = video.currentTime;
            const pending = pendingProgrammaticSeeksRef.current;
            const now = Date.now();
            // A superseded correction never fires its own `seeked`; expire it
            // so it cannot swallow a genuine user seek near the same spot.
            pendingProgrammaticSeeksRef.current = pending.filter(
                (entry) => now - entry.at < 10_000);
            const index = pendingProgrammaticSeeksRef.current.findIndex(
                (entry) => Math.abs(entry.time - landed) < 1.0);
            if (index !== -1) {
                pendingProgrammaticSeeksRef.current.splice(index, 1);
                return;
            }
            onSeeked?.(landed);
        };
        const handleVideoEnded = () => {
            setIsPlaying(false);
            onEnd?.();
        };
        const handleVideoTimeUpdate = () => {
            setCurrentTime(video.currentTime);
            onTimeUpdate?.(video.currentTime, !video.paused);
            if (video.duration) setDuration(video.duration);

            // Live latency tracking
            if (isLive && video.seekable.length > 0) {
                const end = video.seekable.end(video.seekable.length - 1);
                setLiveLatency(Math.max(0, end - video.currentTime));
                setSeekableRange({ start: video.seekable.start(0), end });
            }
        };

        const handlePlaying = () => onPlaying?.();
        video.addEventListener('playing', handlePlaying);
        video.addEventListener('play', handleVideoPlay);
        video.addEventListener('pause', handleVideoPause);
        video.addEventListener('seeked', handleVideoSeeked);
        video.addEventListener('ended', handleVideoEnded);
        video.addEventListener('timeupdate', handleVideoTimeUpdate);

        return () => {
            video.removeEventListener('playing', handlePlaying);
            video.removeEventListener('play', handleVideoPlay);
            video.removeEventListener('pause', handleVideoPause);
            video.removeEventListener('seeked', handleVideoSeeked);
            video.removeEventListener('ended', handleVideoEnded);
            video.removeEventListener('timeupdate', handleVideoTimeUpdate);
        };
    }, [isLive, onPlay, onPlaying, onPause, onSeeked, onEnd, onTimeUpdate]);

    // === STARTUP MILESTONES ===
    // The first frame is the element's `loadeddata` for a source: a picture
    // at the current position is decoded and on screen. Its height is the
    // rung the video opened on, whichever engine chose it.
    const startupMarkRef = useRef(onStartupMark);
    const originalUrlRef = useRef(originalUrl);
    useEffect(() => {
        startupMarkRef.current = onStartupMark;
        originalUrlRef.current = originalUrl;
    });
    useEffect(() => {
        const video = mediaElement;
        if (!video) return;
        const onLoadedData = () => startupMarkRef.current?.(
            { kind: 'first-frame', height: video.videoHeight, originalUrl: originalUrlRef.current });
        const onPlayingMark = () => startupMarkRef.current?.({ kind: 'playing', originalUrl: originalUrlRef.current });
        video.addEventListener('loadeddata', onLoadedData);
        video.addEventListener('playing', onPlayingMark);
        return () => {
            video.removeEventListener('loadeddata', onLoadedData);
            video.removeEventListener('playing', onPlayingMark);
        };
    }, [mediaElement]);
    useEffect(() => {
        if (isBuffering) startupMarkRef.current?.({ kind: 'stall', originalUrl: originalUrlRef.current });
    }, [isBuffering]);

    // Resting on the seek bar is the moment before a seek: the server gets a
    // head start on the segment there, at the rung this viewer is on now.
    const handleSeekHoverRest = useCallback((time: number) => {
        if (!isMseMode || !originalUrl || shakaPlayer.stats.height <= 0) return;
        onPrewarm?.({
            originalUrl,
            seconds: time,
            height: shakaPlayer.stats.height,
            codec: codecFamilyOf(shakaPlayer.stats.videoCodec),
        });
    }, [isMseMode, originalUrl, onPrewarm, shakaPlayer.stats.height, shakaPlayer.stats.videoCodec]);

    // === EXPOSE PLAYER API ===
    useEffect(() => {
        if (playerRef) {
            playerRef.current = {
                play: async () => {
                    const video = videoRef.current;
                    if (!video) return;
                    // A `play` broadcast by another member is not a gesture
                    // from *this* viewer, so the policy applies to it exactly
                    // as it does to autoplay.
                    const outcome = await startPlayback(video);
                    // An element the policy muted earlier starts fine, so the
                    // outcome reads 'started' — but the forced mute is still
                    // in effect, and the controls must keep saying so.
                    const stillForcedMute = outcome === 'started' && video.muted && !isMuted;
                    setPlaybackGate(stillForcedMute ? 'muted-to-start' : outcome);
                },
                pause: () => {
                    const video = videoRef.current;
                    if (isLive || !video || video.paused) return;
                    pendingProgrammaticPauseRef.current = true;
                    video.pause();
                },
                currentTime: (time?: number) => {
                    if (time !== undefined && videoRef.current) {
                        pendingProgrammaticSeeksRef.current.push(
                            { time, at: Date.now() });
                        videoRef.current.currentTime = time;
                    }
                    return videoRef.current?.currentTime || 0;
                },
                getDuration: () => videoRef.current?.duration || 0,
                getVideoElement: () => videoRef.current,
            };
        }
    }, [playerRef, isLive, isMuted]);

    // === CONTROL VISIBILITY TIMEOUT ===
    useEffect(() => {
        let timeout: NodeJS.Timeout;
        const armHide = () => {
            clearTimeout(timeout);
            if (!isPlaying) return;
            timeout = setTimeout(() => {
                // A pointer resting on the bar is about to use it.
                if (pointerOverControlsRef.current) {
                    armHide();
                    return;
                }
                controlsHiddenRef.current = true;
                setShowControls(false);
            }, CONTROLS_HIDE_DELAY_MS);
        };
        const resetTimeout = () => {
            if (controlsHiddenRef.current) {
                controlsHiddenRef.current = false;
                lastWakeAtRef.current = Date.now();
            }
            setShowControls(true);
            armHide();
        };
        document.addEventListener('mousemove', resetTimeout);
        return () => {
            document.removeEventListener('mousemove', resetTimeout);
            clearTimeout(timeout);
        };
    }, [isPlaying]);
    // Paused or open settings keep the controls up; treat that as not hidden
    // so the next movement is not mistaken for a wake-up.
    useEffect(() => {
        if (!isPlaying || showSettings) controlsHiddenRef.current = false;
    }, [isPlaying, showSettings]);

    // === HANDLERS ===
    const toggleFullscreen = useCallback(() => {
        if (!containerRef.current) return;
        if (!document.fullscreenElement) {
            containerRef.current.requestFullscreen().catch((e) => {
                console.warn('[CustomPlayer] Fullscreen request failed:', e);
            });
        } else {
            document.exitFullscreen().catch(() => { });
        }
    }, []);

    // === FULLSCREEN SYNC (handles Escape key etc) ===
    useEffect(() => {
        const handleFullscreenChange = () => {
            setIsFullscreen(!!document.fullscreenElement);
        };
        document.addEventListener('fullscreenchange', handleFullscreenChange);
        return () => {
            document.removeEventListener('fullscreenchange', handleFullscreenChange);
        };
    }, []);

    const handlePlayToggle = useCallback(() => {
        if (isLive && isPlaying) return; // Prevent pausing live

        if (isPlaying) videoRef.current?.pause();
        else videoRef.current?.play();
    }, [isPlaying, isLive]);

    const handleStartFromGate = useCallback(async () => {
        const video = videoRef.current;
        if (!video) return;
        // Restore the viewer's own sound preference first: the gate is the
        // gesture the policy wanted, so there is no need to start muted.
        video.muted = isMuted;
        setPlaybackGate(await startPlayback(video));
    }, [isMuted]);

    const handleRestoreSound = useCallback(() => {
        const video = videoRef.current;
        if (!video) return;
        video.muted = false;
        setIsMuted(false);
        setPlaybackGate('started');
    }, [setIsMuted]);

    // The autoplay policy can mute the element behind React's back (see
    // `startPlayback`), so the element, not `isMuted`, says whether there is
    // sound right now. Toggling from the state instead re-muted an already
    // muted element, and the viewer had to click twice to hear anything.
    const isEffectivelyMuted = isMuted || playbackGate === 'muted-to-start';

    const handleMuteToggle = useCallback(() => {
        const video = videoRef.current;
        const next = !(video ? video.muted : isEffectivelyMuted);
        if (video) video.muted = next;
        setIsMuted(next);
        if (!next && playbackGate === 'muted-to-start') setPlaybackGate('started');
    }, [isEffectivelyMuted, playbackGate, setIsMuted]);

    const handleVolumeChange = useCallback((val: number) => {
        setVolume(val);
        if (val > 0 && isEffectivelyMuted) {
            if (videoRef.current) videoRef.current.muted = false;
            setIsMuted(false);
            if (playbackGate === 'muted-to-start') setPlaybackGate('started');
        }
    }, [isEffectivelyMuted, playbackGate, setIsMuted, setVolume]);

    useEffect(() => {
        if (!showStats) return;
        const read = () => {
            const stored = readRememberedEstimate();
            setRemembered(stored && { bps: stored.bps, ageMs: Date.now() - stored.at });
        };
        read();
        const timer = window.setInterval(read, PLAYER_STATS_REFRESH_MS * 5);
        return () => window.clearInterval(timer);
    }, [showStats]);

    const handleSeek = useCallback((time: number) => {
        if (videoRef.current) {
            videoRef.current.currentTime = time;
        }
    }, []);

    const handleQualityChange = useCallback((index: number) => {
        if (isMseMode) {
            shakaPlayer.setQuality(index);
        } else {
            hlsPlayer.setLevel(index);
        }
    }, [isMseMode, shakaPlayer, hlsPlayer]);

    const toggleNormalization = useCallback(() => {
        setIsNormalizationEnabled(!isNormalizationEnabled);
    }, [isNormalizationEnabled, setIsNormalizationEnabled]);

    const updateNormalizationGain = useCallback((val: number) => {
        setNormalizationGain(val);
    }, [setNormalizationGain]);

    const toggleMono = useCallback(() => {
        setIsMonoEnabled(!isMonoEnabled);
    }, [isMonoEnabled, setIsMonoEnabled]);

    const lastReportRef = useRef({ at: 0, signature: '' });
    useEffect(() => {
        if (!onQualityReport) return;
        const report: QualityReport = isMseMode
            ? {
                rung: shakaPlayer.stats.height,
                cap: shakaPlayer.stats.autoCap,
                surface_px: Math.round(shakaPlayer.stats.surfacePx),
                pixel_ratio: shakaPlayer.stats.pixelRatio,
                estimate_bps: Math.round(shakaPlayer.stats.estimateBps),
                dropped_frames: shakaPlayer.stats.droppedFrames,
                ladder_rungs: shakaPlayer.stats.ladderRungs,
                mode: qualityMode,
                engine: 'mse',
            }
            : {
                rung: hlsQualities.find((q) => q.index === hlsPlayer.currentLevel)?.height ?? 0,
                cap: null,
                surface_px: 0,
                pixel_ratio: 0,
                estimate_bps: Math.round(hlsPlayer.stats.bandwidth),
                dropped_frames: 0,
                ladder_rungs: hlsQualities.length,
                mode: qualityMode,
                engine: 'hls',
            };
        if (report.rung === 0 && report.ladder_rungs === 0) return;
        const signature = `${report.engine}|${report.rung}|${report.cap}|${report.mode}|${report.ladder_rungs}`;
        const now = Date.now();
        if (signature === lastReportRef.current.signature &&
            now - lastReportRef.current.at < QUALITY_REPORT_INTERVAL_MS) return;
        lastReportRef.current = { at: now, signature };
        onQualityReport(report);
    }, [onQualityReport, isMseMode, qualityMode, shakaPlayer.stats, hlsPlayer.stats,
        hlsPlayer.currentLevel, hlsQualities]);

    const forgetRememberedBandwidth = useCallback(() => {
        forgetBandwidth();
        setRemembered(null);
    }, []);

    // === RENDER ===
    return (
        <div
            ref={containerRef}
            className={cn(
                // `on-dark`: the video stage and its chrome stay dark in every colour scheme.
                "on-dark relative w-full h-full bg-black flex items-center justify-center overflow-hidden group rounded-xl",
                className
            )}
            onDoubleClick={toggleFullscreen}
        >
            {/* Video Element */}
            <video
                ref={setVideoElement}
                poster={poster}
                className="w-full h-full object-contain"
                playsInline
                data-stream-type={isShareMode ? 'share' : isMseMode ? 'mse' : 'hls'}
                onClick={() => {
                    if (isLive) return;
                    // The click that woke the faded controls only reveals them.
                    if (Date.now() - lastWakeAtRef.current < WAKE_CLICK_GRACE_MS) return;
                    handlePlayToggle();
                }}
            />

            <div ref={enhancementHostRef} data-video-enhancement={enhancementStatus.state} data-enhancement-backend={enhancementStatus.backend}
                className="absolute inset-0 pointer-events-none" aria-hidden="true" />

            {/* Loading Overlay */}
            {isLoading && (
                <div role="status" aria-label="Loading the stream" className="absolute inset-0 flex items-center justify-center pointer-events-none z-50">
                    <Loader2 aria-hidden="true" className="w-12 h-12 text-emerald-500 animate-spin drop-shadow-lg" />
                </div>
            )}

            {/* Buffering Overlay */}
            {isBuffering && !isLoading && (
                <div role="status" className="absolute inset-0 flex items-center justify-center pointer-events-none z-40">
                    <div className="flex flex-col items-center gap-2">
                        <Loader2 aria-hidden="true" className="w-10 h-10 text-white/80 animate-spin" />
                        <span className="ui-label text-neutral-300">Buffering...</span>
                    </div>
                </div>
            )}

            {/* Autoplay gate.
                The browser refused to start playback without a gesture from
                this viewer, so the room plays on without them until they
                click. Silence here is what made a friend "have to press play
                manually" with no indication why. */}
            {playbackGate === 'blocked' && !error && (
                <button
                    type="button"
                    onClick={handleStartFromGate}
                    className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/70 backdrop-blur-sm cursor-pointer"
                >
                    <span className="flex h-16 w-16 items-center justify-center rounded-full bg-[color:var(--accent-primary)] on-accent-light">
                        <Play aria-hidden="true" className="w-7 h-7 translate-x-0.5" fill="currentColor" />
                    </span>
                    <span className="text-white font-medium">Click to join playback</span>
                    <span className="text-zinc-400 text-sm max-w-xs text-center">
                        Your browser blocks video from starting on its own. The
                        room is already playing.
                    </span>
                </button>
            )}

            {/* Started, but muted against the viewer's wishes to satisfy the
                policy. One click gets the sound back. */}
            {playbackGate === 'muted-to-start' && (
                <button
                    type="button"
                    onClick={handleRestoreSound}
                    className="absolute top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-full bg-black/80 backdrop-blur-sm px-4 py-2 text-sm text-white shadow-lg hover:bg-black/90"
                >
                    <VolumeX aria-hidden="true" className="w-4 h-4" />
                    Started muted — click for sound
                </button>
            )}

            {/* Error Overlay */}
            {error && (
                <div role="alert" className="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-md z-50 p-6 text-center">
                    <div className="max-w-xs">
                        <Info aria-hidden="true" className="w-12 h-12 text-amber-400 mx-auto mb-4" />
                        <p className="text-white font-semibold text-lg mb-2">Playback Issue</p>
                        <p className="text-zinc-400 text-sm">{error}</p>
                    </div>
                </div>
            )}

            {/* Stats Overlay */}
            {showStats && (
                <div aria-label="Playback statistics" className="absolute top-4 left-4 p-4 rounded-xl bg-black/80 backdrop-blur-xl border border-white/10 z-50 font-mono text-[10px] text-emerald-400 min-w-[200px] shadow-2xl animate-in fade-in zoom-in-95 duration-300">
                    <div className="flex items-center justify-between mb-2 border-b border-white/5 pb-2">
                        <span className="ui-title flex items-center gap-1.5">
                            <Activity className="w-3 h-3" /> Stats
                        </span>
                        <span className="ui-label">{isMseMode ? 'DASH' : 'HLS'}</span>
                    </div>
                    <div className="space-y-1.5">
                        {isMseMode ? (
                            <>
                                <div className="flex justify-between">
                                    <span className="text-zinc-500">Mode</span>
                                    <span className="text-right text-[color:var(--accent-primary)]">MSE (single element)</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-zinc-500">Quality</span>
                                    <span className="text-right text-zinc-300">
                                        {currentQuality === AUTO_QUALITY
                                            ? `auto (${shakaPlayer.stats.height}p)`
                                            : qualities.find((q) => q.index === currentQuality)?.height ?? 'auto'}
                                    </span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-zinc-500">Auto cap</span>
                                    <span data-testid="stat-auto-cap" className="text-right text-zinc-300">
                                        {shakaPlayer.stats.autoCap === null
                                            ? 'off (highest)'
                                            : `${shakaPlayer.stats.autoCap}p · ${Math.round(shakaPlayer.stats.surfacePx)}px`}
                                    </span>
                                </div>
                                {/* The measured estimate is what auto decides
                                    on; the rendition's own bitrate below is
                                    the consequence, and used to be shown
                                    under this label. */}
                                <div className="flex justify-between">
                                    <span className="text-zinc-500">Estimate</span>
                                    <span data-testid="stat-estimate" className="text-right text-zinc-300">
                                        {shakaPlayer.stats.estimateIsMeasured
                                            ? `${(shakaPlayer.stats.estimateBps / 1000000).toFixed(2)} Mbps`
                                            : 'measuring…'}
                                    </span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-zinc-500">Rendition</span>
                                    <span className="text-right text-zinc-300">
                                        {(shakaPlayer.stats.bandwidth / 1000000).toFixed(2)} Mbps
                                    </span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-zinc-500">Remembered</span>
                                    <span className="text-right text-zinc-300">
                                        {remembered
                                            ? `${(remembered.bps / 1000000).toFixed(2)} Mbps · ${formatAge(remembered.ageMs)}`
                                            : 'nothing'}
                                    </span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-zinc-500">Dropped</span>
                                    <span className="text-right text-zinc-300">
                                        {(shakaPlayer.stats.droppedFrames * 100).toFixed(1)} %
                                    </span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-zinc-500">Ladder</span>
                                    <span className="text-right text-zinc-300">
                                        {shakaPlayer.stats.ladderRungs} rungs
                                    </span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-zinc-500">Video</span>
                                    <span className="text-right text-zinc-300 truncate pl-4">
                                        {shakaPlayer.stats.videoCodec || 'unknown'}
                                    </span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-zinc-500">Audio</span>
                                    <span className="text-right text-zinc-300 truncate pl-4">
                                        {shakaPlayer.stats.audioCodec || 'unknown'}
                                    </span>
                                </div>
                            </>
                        ) : (
                            <>
                                <div className="flex justify-between">
                                    <span className="text-zinc-500">Latency</span>
                                    <span className="text-right text-zinc-300">{liveLatency.toFixed(2)}s</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-zinc-500">Bandwidth</span>
                                    <span className="text-right text-zinc-300">{(hlsPlayer.stats.bandwidth / 1000000).toFixed(2)} Mbps</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-zinc-500">Video</span>
                                    <span className="text-right text-zinc-300 truncate pl-4">{hlsPlayer.stats.videoCodec || 'unknown'}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-zinc-500">Audio</span>
                                    <span className="text-right text-zinc-300 truncate pl-4">{hlsPlayer.stats.audioCodec || 'unknown'}</span>
                                </div>
                            </>
                        )}
                        <div className="flex justify-between border-t border-white/5 pt-1.5 mt-1.5">
                            <span className="text-zinc-500">Normalization</span>
                            <span className={cn("text-right", audio.normalizeActive ? "text-emerald-400" : "text-zinc-500")}>
                                {audio.normalizeActive ? 'Active' : 'Off'}
                            </span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-zinc-500">Channels</span>
                            <span className={cn("text-right", audio.monoActive ? "text-emerald-400" : "text-zinc-500")}>
                                {audio.monoActive ? 'Mono' : 'Stereo'}
                            </span>
                        </div>
                        {isMseMode && (
                            <button
                                type="button"
                                onClick={forgetRememberedBandwidth}
                                className="w-full mt-1 rounded-md border border-white/10 px-2 py-1 text-[10px] text-zinc-400 hover:bg-white/5 hover:text-white transition-colors focus-visible:outline-2 focus-visible:outline-[color:var(--accent-primary)]"
                            >
                                Forget remembered bandwidth
                            </button>
                        )}
                    </div>
                </div>
            )}

            {/* Player Controls */}
            <PlayerControls
                isPlaying={isPlaying}
                isMuted={isEffectivelyMuted}
                volume={volume}
                currentTime={currentTime}
                duration={duration}
                liveLatency={isLive ? liveLatency : undefined}
                showSettings={showSettings}
                showStats={showStats}
                isFullscreen={isFullscreen}
                currentQuality={currentQuality}
                qualities={qualities}
                seekableForDVR={isLive ? seekableRange : undefined}
                visible={showControls || !isPlaying || showSettings}
                onPointerOverChange={(over) => { pointerOverControlsRef.current = over; }}
                enhancementMode={enhancementMode}
                onEnhancementModeChange={setEnhancementMode}
                enhancementStatus={enhancementStatus.message}
                normalizationActive={isNormalizationEnabled}
                onToggleNormalization={toggleNormalization}
                normalizationGain={normalizationGain}
                onNormalizationGainChange={updateNormalizationGain}
                monoAudio={isMonoEnabled}
                onToggleMono={toggleMono}
                qualityMode={isMseMode ? qualityMode : undefined}
                onQualityModeChange={isMseMode ? setQualityMode : undefined}
                autoHeight={isMseMode ? shakaPlayer.stats.height : undefined}
                syncThreshold={syncThreshold}
                onSyncThresholdChange={onSyncThresholdChange}
                onPlayToggle={handlePlayToggle}
                onMuteToggle={handleMuteToggle}
                onVolumeChange={handleVolumeChange}
                onFullscreenToggle={toggleFullscreen}
                onPiPToggle={() => videoRef.current?.requestPictureInPicture().catch(() => { })}
                onSettingsToggle={() => setShowSettings(!showSettings)}
                onStatsToggle={() => setShowStats(!showStats)}
                onQualityChange={handleQualityChange}
                onSeek={handleSeek}
                onSeekHoverRest={handleSeekHoverRest}
                isLive={isLive}
                sponsorSegments={sponsorSegments}
                storyboard={storyboard}
                chapters={chapters}
            />
        </div>
    );
}
