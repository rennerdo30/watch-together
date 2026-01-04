'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { Loader2, Info, Activity } from 'lucide-react';
import { PlayerControls } from './player-controls';
import { QualityOption, AudioOption } from '@/lib/api';
import { useDashSync, useAudioNormalization, useHlsPlayer, HlsQualityLevel } from './player/hooks';

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
    audioOptions?: AudioOption[];
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
}: CustomPlayerProps) {
    // === REFS ===
    const videoRef = useRef<HTMLVideoElement>(null);
    const audioRef = useRef<HTMLAudioElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const isAutoPlayingRef = useRef(false);
    const dashInitializedRef = useRef<string | null>(null);

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
    const [isLoading, setIsLoading] = useState(true);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [liveLatency, setLiveLatency] = useState(0);
    const [seekableRange, setSeekableRange] = useState({ start: 0, end: 0 });

    // === QUALITY STATE ===
    const [qualities, setQualities] = useState<{ height: number; index: number; bitrate: number }[]>([]);
    const [currentQuality, setCurrentQuality] = useState(-1);

    // === VOLUME STATE (persisted) ===
    const [volume, setVolume] = useState(() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('w2g-player-volume');
            return saved !== null ? parseFloat(saved) : 1.0;
        }
        return 1.0;
    });
    const [isMuted, setIsMuted] = useState(() => {
        if (typeof window !== 'undefined') {
            return localStorage.getItem('w2g-player-muted') === 'true';
        }
        return false;
    });

    // === NORMALIZATION STATE (persisted) ===
    const [isNormalizationEnabled, setIsNormalizationEnabled] = useState(() => {
        if (typeof window !== 'undefined') {
            return localStorage.getItem('w2g-player-normalization') !== 'false';
        }
        return true;
    });
    const [normalizationGain, setNormalizationGain] = useState(() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('w2g-player-normalization-gain');
            return saved !== null ? parseFloat(saved) : 1.0;
        }
        return 1.0;
    });

    // === DASH SYNC HOOK ===
    const dashSync = useDashSync({
        videoRef,
        audioRef,
        enabled: isDashMode,
        initialVolume: volume,
        initialMuted: isMuted,
        onBufferingChange: (buffering) => {
            // Already handled in hook, but we can mirror to state if needed
        },
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

    // === HLS PLAYER HOOK ===
    const hlsPlayer = useHlsPlayer({
        videoRef,
        src: isDashMode ? '' : src, // Only use HLS if not in DASH mode
        enabled: !isDashMode,
        autoPlay,
        initialTime,
        isLive,
        onManifestParsed: (levels: HlsQualityLevel[]) => {
            setQualities(levels);
            setIsLoading(false);
        },
        onLevelSwitch: setCurrentQuality,
        onError: setError,
        onLoadingChange: setIsLoading,
        onBufferingChange: () => { }, // Handled by hook internally
    });

    // === AUDIO NORMALIZATION HOOK ===
    const normalization = useAudioNormalization({
        sourceElement: isDashMode ? audioRef.current : videoRef.current,
        enabled: isNormalizationEnabled,
        gain: normalizationGain,
    });

    // Derive buffering state from appropriate hook
    const isBuffering = isDashMode ? dashSync.isBuffering : hlsPlayer.isBuffering;
    const isPlaying = isDashMode ? dashSync.isPlaying : !videoRef.current?.paused;

    // === DASH INITIALIZATION ===
    useEffect(() => {
        if (!isDashMode) {
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

        console.log('[CustomPlayer] Initializing DASH mode');
        setError(null);
        setIsLoading(true);

        // Set up video (always muted in DASH mode - audio comes from audio element)
        video.src = videoUrl;
        video.muted = true;
        video.load();

        // Set up audio with user's saved preferences
        audio.src = audioUrl;
        audio.muted = isMuted;
        audio.volume = volume;
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
        }

        // Wait for both to load
        let videoLoaded = false;
        let audioLoaded = false;

        const checkBothLoaded = () => {
            if (videoLoaded && audioLoaded) {
                setIsLoading(false);
                setDuration(video.duration || audio.duration);

                // Re-apply volume/muted settings AFTER load completes
                // (browsers can reset these during load)
                audio.volume = volume;
                audio.muted = isMuted;

                // Set initial time
                if (initialTime > 0 && Number.isFinite(initialTime) && !isLive) {
                    video.currentTime = initialTime;
                    audio.currentTime = initialTime;
                    setCurrentTime(initialTime);
                }

                // Autoplay
                if (autoPlay) {
                    isAutoPlayingRef.current = true;
                    dashSync.play()
                        .finally(() => {
                            setTimeout(() => { isAutoPlayingRef.current = false; }, 1000);
                        });
                }
            }
        };

        const onVideoLoaded = () => { videoLoaded = true; checkBothLoaded(); };
        const onAudioLoaded = () => { audioLoaded = true; checkBothLoaded(); };
        const onVideoError = () => setError(`Video load failed: ${video.error?.message || 'Unknown'}`);
        const onAudioError = () => setError(`Audio load failed: ${audio.error?.message || 'Unknown'}`);

        video.addEventListener('loadedmetadata', onVideoLoaded, { once: true });
        audio.addEventListener('loadedmetadata', onAudioLoaded, { once: true });
        video.addEventListener('error', onVideoError, { once: true });
        audio.addEventListener('error', onAudioError, { once: true });

        return () => {
            video.removeEventListener('loadedmetadata', onVideoLoaded);
            audio.removeEventListener('loadedmetadata', onAudioLoaded);
            video.removeEventListener('error', onVideoError);
            audio.removeEventListener('error', onAudioError);
            dashInitializedRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [videoUrl, audioUrl, isDashMode]);

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
            containerRef.current.requestFullscreen();
            setIsFullscreen(true);
        } else {
            document.exitFullscreen();
            setIsFullscreen(false);
        }
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
        if (isDashMode && availableQualities?.[index]) {
            const video = videoRef.current;
            const audio = audioRef.current;
            if (!video) return;

            const savedTime = video.currentTime;
            const wasPlaying = !video.paused;

            console.log(`[CustomPlayer] Switching to quality ${index}: ${availableQualities[index].height}p`);

            // Pause audio during quality switch
            audio?.pause();

            // Change video source
            video.src = availableQualities[index].video_url;

            const onCanPlay = () => {
                video.currentTime = savedTime;
                if (audio) audio.currentTime = savedTime;
                if (wasPlaying) {
                    video.play().catch(console.warn);
                    audio?.play().catch(console.warn);
                }
                video.removeEventListener('canplay', onCanPlay);
            };
            video.addEventListener('canplay', onCanPlay);

            setCurrentQuality(index);
        } else {
            hlsPlayer.setLevel(index);
        }
    }, [isDashMode, availableQualities, hlsPlayer]);

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
                onPiPToggle={() => videoRef.current?.requestPictureInPicture()}
                onSettingsToggle={() => setShowSettings(!showSettings)}
                onStatsToggle={() => setShowStats(!showStats)}
                onQualityChange={handleQualityChange}
                onSeek={handleSeek}
                isLive={isLive}
            />
        </div>
    );
}
