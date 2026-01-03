'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import Hls from 'hls.js';
import { cn } from '@/lib/utils';
import { Loader2, Info, Activity, Ear } from 'lucide-react';
import { PlayerControls } from './player-controls';

interface CustomPlayerProps {
    url: string | { src: string; type: string };
    poster?: string;
    title?: string;
    autoPlay?: boolean;
    className?: string;
    isLive?: boolean;
    onPlay?: () => void;
    onPause?: () => void;
    onSeeked?: (time: number) => void;
    onEnd?: () => void;
    playerRef?: React.MutableRefObject<any>;
    onTimeUpdate?: (time: number, isPlaying: boolean) => void;
}

export function CustomPlayer({
    url,
    poster,
    title,
    autoPlay = false,
    className,
    isLive,
    onPlay,
    onPause,
    onSeeked,
    onEnd,
    playerRef,
    onTimeUpdate
}: CustomPlayerProps) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const hlsRef = useRef<Hls | null>(null);

    // State
    const [isPlaying, setIsPlaying] = useState(false);
    const [isMuted, setIsMuted] = useState(false);
    const [volume, setVolume] = useState(1);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [showControls, setShowControls] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [currentQuality, setCurrentQuality] = useState<number>(-1);
    const [qualities, setQualities] = useState<{ height: number; index: number; bitrate: number }[]>([]);
    const [showStats, setShowStats] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [liveLatency, setLiveLatency] = useState(0);
    const [seekableRange, setSeekableRange] = useState({ start: 0, end: 0 });
    const [isNormalizationEnabled, setIsNormalizationEnabled] = useState(false);

    // Audio Context Refs
    const audioContextRef = useRef<AudioContext | null>(null);
    const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
    const compressorNodeRef = useRef<DynamicsCompressorNode | null>(null);
    const gainNodeRef = useRef<GainNode | null>(null);

    // Stats tracking
    const [stats, setStats] = useState({
        fps: 0,
        bandwidth: 0,
        dropped: 0,
        videoCodec: '',
        audioCodec: '',
        bufferForward: 0,
        rebufferCount: 0,
        totalBytes: 0,
    });

    const src = typeof url === 'string' ? url : url.src;

    // Expose control methods via playerRef
    useEffect(() => {
        if (playerRef) {
            playerRef.current = {
                play: () => videoRef.current?.play(),
                pause: () => isLive ? null : videoRef.current?.pause(), // Disable pause for live
                currentTime: (time?: number) => {
                    if (time !== undefined && videoRef.current) {
                        videoRef.current.currentTime = time;
                    }
                    return videoRef.current?.currentTime || 0;
                },
                getDuration: () => videoRef.current?.duration || 0,
                setVolume: (val: number) => {
                    if (videoRef.current) videoRef.current.volume = val;
                }
            };
        }
    }, [playerRef, isLive]);

    // Load volume settings
    useEffect(() => {
        const savedVolume = localStorage.getItem('w2g-player-volume');
        const savedMuted = localStorage.getItem('w2g-player-muted');
        const savedNorm = localStorage.getItem('w2g-player-normalization');

        if (savedVolume !== null && videoRef.current) {
            const vol = parseFloat(savedVolume);
            setVolume(vol);
            videoRef.current.volume = vol;
        }
        if (savedMuted !== null && videoRef.current) {
            const muted = savedMuted === 'true';
            setIsMuted(muted);
            videoRef.current.muted = muted;
        }
        if (savedNorm !== null) {
            setIsNormalizationEnabled(savedNorm === 'true');
        }
    }, []);

    // Audio Normalization Logic
    useEffect(() => {
        if (!videoRef.current) return;

        if (isNormalizationEnabled) {
            // Initialize AudioContext if needed
            if (!audioContextRef.current) {
                const AudioContextClass = (window.AudioContext || (window as any).webkitAudioContext);
                if (AudioContextClass) {
                    audioContextRef.current = new AudioContextClass();

                    // Create nodes
                    sourceNodeRef.current = audioContextRef.current.createMediaElementSource(videoRef.current);
                    compressorNodeRef.current = audioContextRef.current.createDynamicsCompressor();
                    gainNodeRef.current = audioContextRef.current.createGain();

                    // Configure Compressor for "Night Mode" / Normalization
                    // Aggressive compression to lift quiet sounds and clamp loud ones
                    compressorNodeRef.current.threshold.value = -24;
                    compressorNodeRef.current.knee.value = 30;
                    compressorNodeRef.current.ratio.value = 12;
                    compressorNodeRef.current.attack.value = 0.003;
                    compressorNodeRef.current.release.value = 0.25;

                    // Makeup gain since compression reduces overall level
                    gainNodeRef.current.gain.value = 2.0;

                    // Connect graph: Source -> Compressor -> Gain -> Destination
                    sourceNodeRef.current.connect(compressorNodeRef.current);
                    compressorNodeRef.current.connect(gainNodeRef.current);
                    gainNodeRef.current.connect(audioContextRef.current.destination);
                }
            } else if (audioContextRef.current.state === 'suspended') {
                audioContextRef.current.resume();
            }
        } else {
            // Bypass logic: ideally we disconnect but WebAudio graph management is tricky.
            // Simplest way for toggle is often to rely on gain=1 and standard routing, 
            // but since we hijacked the destination, we might need to reconnect direct or destroy.
            // For robustness in React, checking `isNormalizationEnabled` before creating graph is best,
            // but for runtime toggling:
            if (audioContextRef.current && sourceNodeRef.current) {
                // If we disable, we probably want to assume the browser handles it default 
                // OR we route Source -> Destination directly? 
                // Actually `createMediaElementSource` "hijacks" the audio.
                // So if we disable, we must reconnect Source -> Destination directly.

                // Disconnect everything
                try {
                    sourceNodeRef.current.disconnect();
                    if (compressorNodeRef.current) compressorNodeRef.current.disconnect();
                    if (gainNodeRef.current) gainNodeRef.current.disconnect();

                    // Reconnect source directly to destination (bypass effects)
                    sourceNodeRef.current.connect(audioContextRef.current.destination);
                } catch (e) {
                    console.warn("Audio graph reconfiguration error:", e);
                }
            }
        }

        // Cleanup not strictly necessary since context persists with component
    }, [isNormalizationEnabled]);

    const toggleNormalization = () => {
        const newVal = !isNormalizationEnabled;
        setIsNormalizationEnabled(newVal);
        localStorage.setItem('w2g-player-normalization', String(newVal));
    };

    // Initialize HLS
    useEffect(() => {
        const video = videoRef.current;
        if (!video || !src) return;

        setError(null);
        setIsLoading(true);

        const initPlayer = () => {
            const isHlsSource = (typeof url === 'object' && url.type === 'application/x-mpegurl') ||
                (src.includes('.m3u8') || src.includes('.m3u') || src.includes('manifest'));

            if (isHlsSource && Hls.isSupported()) {
                if (hlsRef.current) hlsRef.current.destroy();

                const hls = new Hls({
                    enableWorker: true,
                    lowLatencyMode: true,
                    backBufferLength: 90,
                    liveSyncDurationCount: 3,
                    // Robust retry logic for proxied segments
                    fragLoadingRetryDelay: 1000,
                    manifestLoadingRetryDelay: 1000,
                    levelLoadingRetryDelay: 1000,
                    manifestLoadingTimeOut: 20000,
                    fragLoadingTimeOut: 20000,
                });

                hls.loadSource(src);
                hls.attachMedia(video);

                hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
                    setIsLoading(false);
                    console.log('HLS Manifest Parsed:', data.levels.length, 'levels');
                    const levels = data.levels.map((level, index) => ({
                        height: level.height || 0,
                        bitrate: level.bitrate || 0,
                        index,
                    }));
                    // Filter out levels with no height (might be audio-only)
                    const videoLevels = levels.filter(l => l.height > 0 || l.bitrate > 0);
                    setQualities(videoLevels.length > 0 ? videoLevels : levels);
                    console.log('Quality levels:', videoLevels);
                    if (autoPlay) {
                        // Try to autoplay, fallback to muted autoplay if blocked
                        video.play().catch(() => {
                            // Browser blocked autoplay - try muted
                            video.muted = true;
                            video.play().catch(() => setIsPlaying(false));
                        });
                    }
                });

                hls.on(Hls.Events.FRAG_LOADED, (_, data) => {
                    setStats(prev => ({
                        ...prev,
                        bandwidth: data.frag.stats.bwEstimate,
                        totalBytes: prev.totalBytes + data.frag.stats.total,
                    }));
                });

                hls.on(Hls.Events.ERROR, (_, data) => {
                    if (data.fatal) {
                        console.error('HLS Fatal Error:', data);
                        switch (data.type) {
                            case Hls.ErrorTypes.NETWORK_ERROR:
                                setError('Network connectivity issue. Retrying...');
                                hls.startLoad();
                                break;
                            case Hls.ErrorTypes.MEDIA_ERROR:
                                setError('Decoding error. Attempting recovery...');
                                hls.recoverMediaError();
                                break;
                            default:
                                setError('Fatal playback error.');
                                hls.destroy();
                                break;
                        }
                    }
                });

                hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
                    setCurrentQuality(data.level);
                    const level = hls.levels[data.level];
                    setStats(prev => ({
                        ...prev,
                        videoCodec: level.videoCodec || '',
                        audioCodec: level.audioCodec || '',
                    }));
                });

                hlsRef.current = hls;
            } else {
                // Standard Native Playback (MP4 / Native HLS on Safari)
                video.src = src;
                video.load(); // Ensure reload

                const onLoadedMetadata = () => {
                    setIsLoading(false);
                    if (autoPlay) {
                        video.play().catch(() => {
                            video.muted = true;
                            video.play().catch(() => setIsPlaying(false));
                        });
                    }
                };

                video.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
            }
        };

        initPlayer();

        return () => {
            if (hlsRef.current) {
                hlsRef.current.destroy();
                hlsRef.current = null;
            }
        };
    }, [src, autoPlay]);

    // Video Event Handlers
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        const onVideoPlay = () => { setIsPlaying(true); onPlay?.(); };
        const onVideoPause = () => { setIsPlaying(false); onPause?.(); };
        const onVideoTimeUpdate = () => {
            setCurrentTime(video.currentTime);
            setDuration(video.duration);
            if (video.seekable.length > 0) {
                const end = video.seekable.end(video.seekable.length - 1);
                setSeekableRange({ start: video.seekable.start(0), end });
                setLiveLatency(Math.max(0, end - video.currentTime));
            }

            // Update stats
            const quality = (video as any).getVideoPlaybackQuality?.() || {};
            setStats(prev => ({
                ...prev,
                fps: quality.totalVideoFrames ? (quality.totalVideoFrames / video.currentTime) : 0,
                dropped: quality.droppedVideoFrames || 0,
                bufferForward: video.buffered.length > 0 ? (video.buffered.end(video.buffered.length - 1) - video.currentTime) : 0,
            }));
        };
        const onVideoEnded = () => onEnd?.();
        const onVideoWaiting = () => setIsLoading(true);
        const onVideoPlaying = () => setIsLoading(false);
        const onVideoVolumeChange = () => {
            setIsMuted(video.muted);
            setVolume(video.volume);
            localStorage.setItem('w2g-player-volume', String(video.volume));
            localStorage.setItem('w2g-player-muted', String(video.muted));
        };
        const onVideoSeeked = () => onSeeked?.(video.currentTime);

        video.addEventListener('play', onVideoPlay);
        video.addEventListener('pause', onVideoPause);
        video.addEventListener('timeupdate', onVideoTimeUpdate);
        video.addEventListener('ended', onVideoEnded);
        video.addEventListener('waiting', onVideoWaiting);
        video.addEventListener('playing', onVideoPlaying);
        video.addEventListener('volumechange', onVideoVolumeChange);
        video.addEventListener('seeked', onVideoSeeked);

        return () => {
            video.removeEventListener('play', onVideoPlay);
            video.removeEventListener('pause', onVideoPause);
            video.removeEventListener('timeupdate', onVideoTimeUpdate);
            video.removeEventListener('ended', onVideoEnded);
            video.removeEventListener('waiting', onVideoWaiting);
            video.removeEventListener('playing', onVideoPlaying);
            video.removeEventListener('volumechange', onVideoVolumeChange);
            video.removeEventListener('seeked', onVideoSeeked);
        };
    }, [onPlay, onPause, onSeeked, onEnd]);

    // Control visibility timeout
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
        return () => document.removeEventListener('mousemove', resetTimeout);
    }, [isPlaying]);

    // Fullscreen handler
    const toggleFullscreen = () => {
        if (!containerRef.current) return;
        if (!document.fullscreenElement) {
            containerRef.current.requestFullscreen();
            setIsFullscreen(true);
        } else {
            document.exitFullscreen();
            setIsFullscreen(false);
        }
    };

    const safePlay = async () => {
        try {
            if (videoRef.current) {
                await videoRef.current.play();
            }
        } catch (err) {
            console.warn('Playback intercepted/aborted:', err);
        }
    };

    return (
        <div
            ref={containerRef}
            className={cn(
                "relative w-full h-full bg-black flex items-center justify-center overflow-hidden group rounded-xl",
                className
            )}
            onDoubleClick={toggleFullscreen}
        >
            <video
                ref={videoRef}
                poster={poster}
                className="w-full h-full object-contain"
                playsInline
                onClick={() => {
                    if (isLive) return; // Disable click-to-pause for live
                    isPlaying ? videoRef.current?.pause() : safePlay();
                }}
            />

            {/* Overlays */}
            {isLoading && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-50">
                    <Loader2 className="w-12 h-12 text-emerald-500 animate-spin drop-shadow-lg" />
                </div>
            )}

            {error && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-md z-50 p-6 text-center">
                    <div className="max-w-xs">
                        <Info className="w-12 h-12 text-amber-500 mx-auto mb-4" />
                        <p className="text-white font-semibold text-lg mb-2">Playback Issue</p>
                        <p className="text-zinc-400 text-sm">{error}</p>
                    </div>
                </div>
            )}

            {/* Stats for Nerds */}
            {showStats && (
                <div className="absolute top-4 left-4 p-4 rounded-xl bg-black/80 backdrop-blur-xl border border-white/10 z-50 font-mono text-[10px] text-emerald-400 min-w-[200px] shadow-2xl animate-in fade-in zoom-in-95 duration-300">
                    <div className="flex items-center justify-between mb-2 border-b border-white/5 pb-2">
                        <span className="font-bold text-white uppercase tracking-widest flex items-center gap-1.5">
                            <Activity className="w-3 h-3" /> Stats
                        </span>
                        <span className="text-zinc-500 uppercase">HLS.JS {Hls.version}</span>
                    </div>
                    <div className="space-y-1.5">
                        <div className="flex justify-between">
                            <span className="text-zinc-500">Latency</span>
                            <span className="text-right text-zinc-300">{liveLatency.toFixed(2)}s</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-zinc-500">Bandwidth</span>
                            <span className="text-right text-zinc-300">{(stats.bandwidth / 1000000).toFixed(2)} Mbps</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-zinc-500">Buffer</span>
                            <span className="text-right text-emerald-400">{stats.bufferForward.toFixed(1)}s</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-zinc-500">Video</span>
                            <span className="text-right text-zinc-300 truncate pl-4" title={stats.videoCodec}>{stats.videoCodec || 'unknown'}</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-zinc-500">Audio</span>
                            <span className="text-right text-zinc-300 truncate pl-4" title={stats.audioCodec}>{stats.audioCodec || 'unknown'}</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-zinc-500">Dropped</span>
                            <span className="text-right text-zinc-300">{stats.dropped}</span>
                        </div>
                    </div>
                </div>
            )}

            {/* Premium Controls */}
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
                onPlayToggle={() => {
                    if (isLive && isPlaying) return; // Prevent pausing live
                    isPlaying ? videoRef.current?.pause() : videoRef.current?.play();
                }}
                onMuteToggle={() => videoRef.current && (videoRef.current.muted = !videoRef.current.muted)}
                onVolumeChange={(val) => videoRef.current && (videoRef.current.volume = val)}
                onFullscreenToggle={toggleFullscreen}
                onPiPToggle={() => videoRef.current?.requestPictureInPicture()}
                onSettingsToggle={() => setShowSettings(!showSettings)}
                onStatsToggle={() => setShowStats(!showStats)}
                onQualityChange={(index) => {
                    if (hlsRef.current) hlsRef.current.currentLevel = index;
                    setShowSettings(false);
                }}
                onSeek={(time) => videoRef.current && (videoRef.current.currentTime = time)}
                onGoToLive={() => {
                    if (videoRef.current && seekableRange.end) {
                        videoRef.current.currentTime = seekableRange.end - 2;
                    }
                }}
                isLive={isLive}
            />
        </div>
    );
}
