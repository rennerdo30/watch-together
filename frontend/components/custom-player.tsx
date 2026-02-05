'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { Loader2, Info, Activity } from 'lucide-react';
import { PlayerControls } from './player-controls';
import { QualityOption } from '@/lib/api';
import { useDashSync, useDashPlayer, useAudioNormalization, useHlsPlayer, HlsQualityLevel } from './player/hooks';

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
    availableQualities,
    onQualityChangeNotify,
}: CustomPlayerProps) {
    // === REFS ===
    const videoRef = useRef<HTMLVideoElement>(null);
    const audioRef = useRef<HTMLAudioElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const isAutoPlayingRef = useRef(false);

    // Determine playback mode
    const isDashMode = streamType === 'dash' && !!videoUrl && !!audioUrl;
    const src = typeof url === 'string' ? url : url.src;

    // === UI STATE ===
    const [showControls, setShowControls] = useState(true);
    const [showStats, setShowStats] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [error, setError] = useState<string | null>(null);

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

    // === DASH SYNC HOOK ===
    const dashSync = useDashSync({
        videoRef,
        audioRef,
        enabled: isDashMode,
        initialVolume: volume,
        initialMuted: isMuted,
        onPlayingChange: (playing) => {
            if (playing) onPlay?.();
            else onPause?.();
        },
        onTimeUpdate: (time, dur) => {
            setCurrentTime(time);
            setDuration(dur);
            onTimeUpdate?.(time, dashSync.isPlaying);
        },
        onError: setError,
    });

    // === DASH PLAYER HOOK (initialization & quality management) ===
    const dashPlayer = useDashPlayer({
        videoRef,
        audioRef,
        videoUrl: videoUrl || '',
        audioUrl: audioUrl || '',
        enabled: isDashMode,
        autoPlay,
        initialTime,
        isLive,
        initialVolume: volume,
        initialMuted: isMuted,
        availableQualities,
        onError: setError,
        onQualityChangeNotify,
        onReady: () => {
            // Trigger autoplay through dashSync after both streams are ready
            if (autoPlay) {
                isAutoPlayingRef.current = true;
                dashSync.play()
                    .finally(() => {
                        setTimeout(() => { isAutoPlayingRef.current = false; }, 1000);
                    });
            }
        },
    });

    // === HLS PLAYER HOOK ===
    const [hlsLoading, setHlsLoading] = useState(true);
    const [hlsQualities, setHlsQualities] = useState<HlsQualityLevel[]>([]);
    const [hlsCurrentQuality, setHlsCurrentQuality] = useState(-1);

    const hlsPlayer = useHlsPlayer({
        videoRef,
        src: isDashMode ? '' : src, // Only use HLS if not in DASH mode
        enabled: !isDashMode,
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
    });

    // Derive loading/qualities/currentQuality from appropriate hook
    const isLoading = isDashMode ? dashPlayer.isLoading : hlsLoading;
    const qualities = isDashMode ? dashPlayer.qualities : hlsQualities;
    const currentQuality = isDashMode ? dashPlayer.currentQuality : hlsCurrentQuality;

    // === AUDIO NORMALIZATION HOOK ===
    const normalization = useAudioNormalization({
        sourceElement: isDashMode ? audioRef.current : videoRef.current,
        enabled: isNormalizationEnabled,
        gain: normalizationGain,
    });

    // Derive buffering state from appropriate hook
    const isBuffering = isDashMode ? dashSync.isBuffering : hlsPlayer.isBuffering;
    const isPlaying = isDashMode ? dashSync.isPlaying : !videoRef.current?.paused;

    // === APPLY INITIAL VOLUME (non-DASH mode) ===
    // This runs once on mount and when switching modes to sync persisted settings
    useEffect(() => {
        const video = videoRef.current;
        if (!video || isDashMode) return;

        // Apply saved volume and muted state to video element
        video.volume = volume;
        video.muted = isMuted;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isDashMode]); // Only on mount/mode change, not on every volume change

    // === VIDEO EVENT HANDLERS (non-DASH mode) ===
    useEffect(() => {
        const video = videoRef.current;
        if (!video || isDashMode) return;

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
    }, [isDashMode, isLive, onPlay, onPause, onSeeked, onEnd, onTimeUpdate]);

    // === EXPOSE PLAYER API ===
    useEffect(() => {
        if (playerRef) {
            playerRef.current = {
                play: () => isDashMode ? dashSync.play() : videoRef.current?.play(),
                pause: () => isLive ? undefined : (isDashMode ? dashSync.pause() : videoRef.current?.pause()),
                currentTime: (time?: number) => {
                    if (time !== undefined) {
                        if (isDashMode) dashSync.seek(time);
                        else if (videoRef.current) videoRef.current.currentTime = time;
                    }
                    return videoRef.current?.currentTime || 0;
                },
                getDuration: () => videoRef.current?.duration || 0,
                setVolume: (val: number) => {
                    if (isDashMode) dashSync.setVolume(val);
                    else if (videoRef.current) videoRef.current.volume = val;
                },
                getVideoElement: () => videoRef.current,
            };
        }
    }, [playerRef, isLive, isDashMode, dashSync]);

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

        if (isDashMode) {
            if (isPlaying) dashSync.pause();
            else dashSync.play();
        } else {
            if (isPlaying) videoRef.current?.pause();
            else videoRef.current?.play();
        }
    }, [isDashMode, isPlaying, isLive, dashSync]);

    const handleMuteToggle = useCallback(() => {
        const newMuted = !isMuted;
        setIsMuted(newMuted);
        localStorage.setItem('w2g-player-muted', String(newMuted));

        if (isDashMode) {
            dashSync.setMuted(newMuted);
        } else if (videoRef.current) {
            videoRef.current.muted = newMuted;
        }
    }, [isDashMode, isMuted, dashSync]);

    const handleVolumeChange = useCallback((val: number) => {
        setVolume(val);
        localStorage.setItem('w2g-player-volume', String(val));

        if (val > 0 && isMuted) {
            setIsMuted(false);
            localStorage.setItem('w2g-player-muted', 'false');
        }

        if (isDashMode) {
            dashSync.setVolume(val);
            if (val > 0) dashSync.setMuted(false);
        } else if (videoRef.current) {
            videoRef.current.volume = val;
            if (val > 0) videoRef.current.muted = false;
        }
    }, [isDashMode, isMuted, dashSync]);

    const handleSeek = useCallback((time: number) => {
        if (isDashMode) {
            dashSync.seek(time);
        } else if (videoRef.current) {
            videoRef.current.currentTime = time;
        }
    }, [isDashMode, dashSync]);

    const handleQualityChange = useCallback((index: number) => {
        if (isDashMode) {
            dashPlayer.setQuality(index);
        } else {
            hlsPlayer.setLevel(index);
        }
    }, [isDashMode, dashPlayer, hlsPlayer]);

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
                "relative w-full h-full bg-black flex items-center justify-center overflow-hidden group rounded-xl",
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
                data-stream-type={isDashMode ? 'dash' : 'hls'}
                onClick={() => {
                    if (isLive) return;
                    handlePlayToggle();
                }}
            />

            {/* Audio Element (DASH mode) */}
            <audio
                ref={audioRef}
                className="absolute w-1 h-1 opacity-0 pointer-events-none"
                preload="auto"
                playsInline
            />

            {/* Loading Overlay */}
            {isLoading && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-50">
                    <Loader2 className="w-12 h-12 text-emerald-500 animate-spin drop-shadow-lg" />
                </div>
            )}

            {/* Buffering Overlay */}
            {isBuffering && !isLoading && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-40">
                    <div className="flex flex-col items-center gap-2">
                        <Loader2 className="w-10 h-10 text-white/80 animate-spin" />
                        <span className="text-white/60 text-xs font-medium uppercase tracking-wider">Buffering...</span>
                    </div>
                </div>
            )}

            {/* Error Overlay */}
            {error && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-md z-50 p-6 text-center">
                    <div className="max-w-xs">
                        <Info className="w-12 h-12 text-amber-500 mx-auto mb-4" />
                        <p className="text-white font-semibold text-lg mb-2">Playback Issue</p>
                        <p className="text-zinc-400 text-sm">{error}</p>
                    </div>
                </div>
            )}

            {/* Stats Overlay */}
            {showStats && (
                <div className="absolute top-4 left-4 p-4 rounded-xl bg-black/80 backdrop-blur-xl border border-white/10 z-50 font-mono text-[10px] text-emerald-400 min-w-[200px] shadow-2xl animate-in fade-in zoom-in-95 duration-300">
                    <div className="flex items-center justify-between mb-2 border-b border-white/5 pb-2">
                        <span className="font-bold text-white uppercase tracking-widest flex items-center gap-1.5">
                            <Activity className="w-3 h-3" /> Stats
                        </span>
                        <span className="text-zinc-500 uppercase">{isDashMode ? 'DASH' : 'HLS'}</span>
                    </div>
                    <div className="space-y-1.5">
                        {isDashMode ? (
                            <>
                                <div className="flex justify-between">
                                    <span className="text-zinc-500">Mode</span>
                                    <span className="text-right text-purple-400">Separate V+A</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-zinc-500">Quality</span>
                                    <span className="text-right text-zinc-300">
                                        {availableQualities?.[currentQuality]?.height || '?'}p
                                    </span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-zinc-500">Video Buffer</span>
                                    <span className="text-right text-emerald-400">
                                        {dashSync.getVideoBufferHealth().toFixed(1)}s
                                    </span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-zinc-500">Audio Buffer</span>
                                    <span className="text-right text-emerald-400">
                                        {dashSync.getAudioBufferHealth().toFixed(1)}s
                                    </span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-zinc-500">A/V Sync</span>
                                    <span className={cn(
                                        "text-right",
                                        Math.abs(dashSync.lastDrift) < 0.05 ? "text-emerald-400" :
                                            Math.abs(dashSync.lastDrift) < 0.2 ? "text-yellow-400" : "text-red-400"
                                    )}>
                                        {dashSync.lastDrift.toFixed(3)}s
                                    </span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-zinc-500">Sync Health</span>
                                    <span className={cn(
                                        "text-right",
                                        dashSync.syncHealth === 'good' ? "text-emerald-400" :
                                            dashSync.syncHealth === 'recovering' ? "text-yellow-400" : "text-red-400"
                                    )}>
                                        {dashSync.syncHealth}
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
                currentTime={isDashMode ? dashSync.currentTime : currentTime}
                duration={isDashMode ? dashSync.duration : duration}
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
