'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { Loader2, Info, Activity, Play, VolumeX } from 'lucide-react';
import { PlayerControls } from './player-controls';
import { QualityOption } from '@/lib/api';
import { useAudioNormalization, useHlsPlayer, useShakaPlayer, HlsQualityLevel } from './player/hooks';
import { startPlayback, type PlaybackStart } from '@/lib/playback';

interface CustomPlayerProps {
    url: string | { src: string; type: string };
    poster?: string;
    title?: string;
    autoPlay?: boolean;
    className?: string;
    isLive?: boolean;
    initialTime?: number;
    onPlay?: () => void;
    onPause?: () => void;
    onSeeked?: (time: number) => void;
    onEnd?: () => void;
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
    availableQualities?: QualityOption[];
    // Callback for quality change notification (for prefetch optimization)
    onQualityChangeNotify?: (oldVideoUrl: string, newVideoUrl: string, audioUrl: string | undefined) => void;
}

interface PlayerAPI {
    play: () => Promise<void> | void;
    pause: () => void;
    currentTime: (time?: number) => number;
    getDuration: () => number;
    setVolume: (val: number) => void;
    getVideoElement: () => HTMLVideoElement | null;
}

/**
 * CustomPlayer - Unified video player supporting both HLS and DASH (separate video/audio) streams.
 * 
 * Architecture:
 * - HLS mode: Uses HLS.js for adaptive streaming
 * - DASH mode: Uses custom useDashSync hook for manual A/V synchronization
 * - Both modes: Use useAudioNormalization for night mode audio processing
 */
export function CustomPlayer({
    url,
    poster,
    autoPlay = false,
    className,
    isLive,
    initialTime = 0,
    onPlay,
    onPause,
    onSeeked,
    onEnd,
    playerRef,
    onTimeUpdate,
    syncThreshold,
    onSyncThresholdChange,
    streamType,
    videoUrl,
    audioUrl,
    manifestUrl,
    availableQualities,
    onQualityChangeNotify,
}: CustomPlayerProps) {
    // === REFS ===
    const videoRef = useRef<HTMLVideoElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const isAutoPlayingRef = useRef(false);

    // Adaptive streams play through one media element, fed by the generated
    // manifest, so the browser muxes audio and video against a single clock.
    const isMseMode = streamType === 'dash' && !!manifestUrl;
    const src = typeof url === 'string' ? url : url.src;

    // === UI STATE ===
    const [showControls, setShowControls] = useState(true);
    const [showStats, setShowStats] = useState(false);
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
    const [liveLatency, setLiveLatency] = useState(0);
    const [seekableRange, setSeekableRange] = useState({ start: 0, end: 0 });

    // === VOLUME STATE (persisted via useEffect to avoid SSR hydration mismatch) ===
    const [volume, setVolume] = useState(1.0);
    const [isMuted, setIsMuted] = useState(false);
    const volumeInitializedRef = useRef(false);

    useEffect(() => {
        if (!volumeInitializedRef.current) {
            volumeInitializedRef.current = true;
            const savedVolume = localStorage.getItem('w2g-player-volume');
            if (savedVolume !== null) setVolume(parseFloat(savedVolume));
            const savedMuted = localStorage.getItem('w2g-player-muted');
            if (savedMuted === 'true') setIsMuted(true);
        }
    }, []);

    // === NORMALIZATION STATE (persisted via useEffect to avoid SSR hydration mismatch) ===
    const [isNormalizationEnabled, setIsNormalizationEnabled] = useState(true);
    const [normalizationGain, setNormalizationGain] = useState(1.0);

    useEffect(() => {
        const savedNorm = localStorage.getItem('w2g-player-normalization');
        if (savedNorm === 'false') setIsNormalizationEnabled(false);
        const savedGain = localStorage.getItem('w2g-player-normalization-gain');
        if (savedGain !== null) setNormalizationGain(parseFloat(savedGain));
    }, []);

    // === HLS PLAYER HOOK ===
    const [hlsLoading, setHlsLoading] = useState(true);
    const [hlsQualities, setHlsQualities] = useState<HlsQualityLevel[]>([]);
    const [hlsCurrentQuality, setHlsCurrentQuality] = useState(-1);

    const hlsPlayer = useHlsPlayer({
        videoRef,
        // HLS handles the sources MSE does not.
        src: isMseMode ? '' : src,
        enabled: !isMseMode,
        autoPlay,
        initialTime,
        isLive,
        onManifestParsed: (levels: HlsQualityLevel[]) => {
            setHlsQualities(levels);
            setHlsLoading(false);
        },
        onLevelSwitch: setHlsCurrentQuality,
        onError: setError,
        onLoadingChange: setHlsLoading,
        onPlaybackStart: setPlaybackGate,
    });

    // === MSE PLAYER HOOK (single element, manifest-driven) ===
    const shakaPlayer = useShakaPlayer({
        videoRef,
        manifestUrl: manifestUrl ?? '',
        enabled: isMseMode,
        autoPlay,
        initialTime,
        onError: setError,
        onPlaybackStart: setPlaybackGate,
    });

    // Derive loading/qualities/currentQuality from the active engine
    const isLoading = isMseMode ? shakaPlayer.isLoading : hlsLoading;
    const qualities = isMseMode ? shakaPlayer.qualities : hlsQualities;
    const currentQuality = isMseMode ? shakaPlayer.currentQuality : hlsCurrentQuality;

    // === AUDIO NORMALIZATION HOOK ===
    // Both engines carry audio on the video element.
    const normalization = useAudioNormalization({
        sourceElement: videoRef.current,
        enabled: isNormalizationEnabled,
        gain: normalizationGain,
    });

    const isBuffering = isMseMode ? shakaPlayer.isBuffering : hlsPlayer.isBuffering;
    const isPlaying = !videoRef.current?.paused;

    // === APPLY INITIAL VOLUME (non-DASH mode) ===
    // This runs once on mount and when switching modes to sync persisted settings
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        // Apply saved volume and muted state to video element
        video.volume = volume;
        video.muted = isMuted;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []); // Only on mount, not on every volume change

    // === VIDEO EVENT HANDLERS (non-DASH mode) ===
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        const handleVideoPlay = () => {
            if (!isAutoPlayingRef.current) onPlay?.();
        };
        const handleVideoPause = () => onPause?.();
        const handleVideoSeeked = () => {
            if (!isAutoPlayingRef.current) onSeeked?.(video.currentTime);
        };
        const handleVideoEnded = () => onEnd?.();
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

        video.addEventListener('play', handleVideoPlay);
        video.addEventListener('pause', handleVideoPause);
        video.addEventListener('seeked', handleVideoSeeked);
        video.addEventListener('ended', handleVideoEnded);
        video.addEventListener('timeupdate', handleVideoTimeUpdate);

        return () => {
            video.removeEventListener('play', handleVideoPlay);
            video.removeEventListener('pause', handleVideoPause);
            video.removeEventListener('seeked', handleVideoSeeked);
            video.removeEventListener('ended', handleVideoEnded);
            video.removeEventListener('timeupdate', handleVideoTimeUpdate);
        };
    }, [isLive, onPlay, onPause, onSeeked, onEnd, onTimeUpdate]);

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
                    setPlaybackGate(await startPlayback(video));
                },
                pause: () => isLive ? undefined : videoRef.current?.pause(),
                currentTime: (time?: number) => {
                    if (time !== undefined && videoRef.current) {
                        videoRef.current.currentTime = time;
                    }
                    return videoRef.current?.currentTime || 0;
                },
                getDuration: () => videoRef.current?.duration || 0,
                setVolume: (val: number) => {
                    if (videoRef.current) videoRef.current.volume = val;
                },
                getVideoElement: () => videoRef.current,
            };
        }
    }, [playerRef, isLive]);

    // === CONTROL VISIBILITY TIMEOUT ===
    useEffect(() => {
        let timeout: NodeJS.Timeout;
        const resetTimeout = () => {
            setShowControls(true);
            clearTimeout(timeout);
            if (isPlaying) {
                timeout = setTimeout(() => setShowControls(false), 3000);
            }
        };
        document.addEventListener('mousemove', resetTimeout);
        return () => {
            document.removeEventListener('mousemove', resetTimeout);
            clearTimeout(timeout);
        };
    }, [isPlaying]);

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
        video.muted = localStorage.getItem('w2g-player-muted') === 'true';
        setPlaybackGate(await startPlayback(video));
    }, []);

    const handleRestoreSound = useCallback(() => {
        const video = videoRef.current;
        if (!video) return;
        video.muted = false;
        setIsMuted(false);
        setPlaybackGate('started');
    }, []);

    const handleMuteToggle = useCallback(() => {
        const newMuted = !isMuted;
        setIsMuted(newMuted);
        localStorage.setItem('w2g-player-muted', String(newMuted));

        if (videoRef.current) {
            videoRef.current.muted = newMuted;
        }
    }, [isMuted]);

    const handleVolumeChange = useCallback((val: number) => {
        setVolume(val);
        localStorage.setItem('w2g-player-volume', String(val));

        if (val > 0 && isMuted) {
            setIsMuted(false);
            localStorage.setItem('w2g-player-muted', 'false');
        }

        if (videoRef.current) {
            videoRef.current.volume = val;
            if (val > 0) videoRef.current.muted = false;
        }
    }, [isMuted]);

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
        const newVal = !isNormalizationEnabled;
        setIsNormalizationEnabled(newVal);
        localStorage.setItem('w2g-player-normalization', String(newVal));
    }, [isNormalizationEnabled]);

    const updateNormalizationGain = useCallback((val: number) => {
        setNormalizationGain(val);
        localStorage.setItem('w2g-player-normalization-gain', String(val));
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
                ref={videoRef}
                poster={poster}
                className="w-full h-full object-contain"
                playsInline
                data-stream-type={isMseMode ? 'mse' : 'hls'}
                onClick={() => {
                    if (isLive) return;
                    handlePlayToggle();
                }}
            />

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
                                        {qualities.find((q) => q.index === currentQuality)?.height ?? 'auto'}
                                    </span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-zinc-500">Bandwidth</span>
                                    <span className="text-right text-zinc-300">
                                        {(shakaPlayer.stats.bandwidth / 1000000).toFixed(2)} Mbps
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
                            <span className={cn("text-right", normalization.isActive ? "text-emerald-400" : "text-zinc-500")}>
                                {normalization.isActive ? 'Active' : 'Off'}
                            </span>
                        </div>
                    </div>
                </div>
            )}

            {/* Player Controls */}
            <PlayerControls
                isPlaying={isPlaying}
                isMuted={isMuted}
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
                visible={showControls || !isPlaying}
                normalizationActive={isNormalizationEnabled}
                onToggleNormalization={toggleNormalization}
                normalizationGain={normalizationGain}
                onNormalizationGainChange={updateNormalizationGain}
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
                isLive={isLive}
            />
        </div>
    );
}
