'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import Hls from 'hls.js';
import { cn } from '@/lib/utils';
import { Loader2, Info, Activity, Ear } from 'lucide-react';
import { PlayerControls } from './player-controls';
import { QualityOption, AudioOption } from '@/lib/api';

interface CustomPlayerProps {
    url: string | { src: string; type: string };
    poster?: string;
    title?: string;
    autoPlay?: boolean;
    className?: string;
    isLive?: boolean;
    initialTime?: number; // Add initialTime prop
    onPlay?: () => void;
    onPause?: () => void;
    onSeeked?: (time: number) => void;
    onEnd?: () => void;
    playerRef?: React.MutableRefObject<any>;
    onTimeUpdate?: (time: number, isPlaying: boolean) => void;
    syncThreshold?: number;
    onSyncThresholdChange?: (val: number) => void;
    // DASH-specific props for separate video/audio streams
    streamType?: 'hls' | 'dash' | 'combined' | 'video_only' | 'default' | 'unknown';
    videoUrl?: string;
    audioUrl?: string;
    availableQualities?: QualityOption[];
    audioOptions?: AudioOption[];
}

export function CustomPlayer({
    url,
    poster,
    title,
    autoPlay = false,
    className,
    isLive,
    initialTime = 0, // Default to 0
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
    audioOptions
}: CustomPlayerProps) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const audioRef = useRef<HTMLAudioElement>(null); // For DASH separate audio
    const containerRef = useRef<HTMLDivElement>(null);
    const hlsRef = useRef<Hls | null>(null);
    const isAutoPlaying = useRef(false);
    const dashInitialized = useRef<string | null>(null); // Track which DASH URL we initialized
    const isDashMode = streamType === 'dash' && videoUrl && audioUrl;

    // Debug: Log stream type detection (only on actual changes)
    const lastLoggedConfig = useRef<string>('');
    useEffect(() => {
        const configKey = `${streamType}-${!!videoUrl}-${!!audioUrl}`;
        if (configKey !== lastLoggedConfig.current) {
            lastLoggedConfig.current = configKey;
            console.log('[CustomPlayer] Stream config:', {
                streamType,
                hasVideoUrl: !!videoUrl,
                hasAudioUrl: !!audioUrl,
                isDashMode
            });
        }
    }, [streamType, videoUrl, audioUrl, isDashMode]);

    // State
    const [isPlaying, setIsPlaying] = useState(false);
    const [isMuted, setIsMuted] = useState(() => {
        if (typeof window !== 'undefined') {
            return localStorage.getItem('w2g-player-muted') === 'true';
        }
        return false;
    });
    const [volume, setVolume] = useState(() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('w2g-player-volume');
            return saved !== null ? parseFloat(saved) : 1.0;
        }
        return 1.0;
    });
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [showControls, setShowControls] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [currentQuality, setCurrentQuality] = useState<number>(-1);
    const [qualities, setQualities] = useState<{ height: number; index: number; bitrate: number }[]>([]);
    const [currentDashQuality, setCurrentDashQuality] = useState<number>(0); // Index into availableQualities
    const [currentAudioOption, setCurrentAudioOption] = useState<number>(0); // Index into audioOptions
    const [showStats, setShowStats] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [liveLatency, setLiveLatency] = useState(0);
    const [seekableRange, setSeekableRange] = useState({ start: 0, end: 0 });
    const [isNormalizationEnabled, setIsNormalizationEnabled] = useState(() => {
        if (typeof window !== 'undefined') {
            return localStorage.getItem('w2g-player-normalization') !== 'false'; // Default true
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

    // Apply initial volume/mute settings to video/audio refs
    useEffect(() => {
        if (isDashMode) {
            // In DASH mode, video is always muted, audio element handles sound
            if (audioRef.current) {
                audioRef.current.volume = volume;
                audioRef.current.muted = isMuted;
            }
            if (videoRef.current) {
                videoRef.current.muted = true; // Always muted in DASH
            }
        } else {
            if (videoRef.current) {
                videoRef.current.volume = volume;
                videoRef.current.muted = isMuted;
                videoRef.current.defaultMuted = isMuted;
            }
        }
    }, [volume, isMuted, isDashMode]); // Run whenever volume/mute state changes to sync ref

    // Note: Removed aggressive auto-unmute logic that fought with browser autoplay policy.
    // Users must click the unmute button or interact with the page to enable audio.
    // This is required by Chrome/Safari autoplay policies.

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
                    gainNodeRef.current.gain.value = normalizationGain;

                    // Connect graph: Source -> Compressor -> Gain -> Destination
                    sourceNodeRef.current.connect(compressorNodeRef.current);
                    compressorNodeRef.current.connect(gainNodeRef.current);
                    gainNodeRef.current.connect(audioContextRef.current.destination);
                }
            } else if (audioContextRef.current.state === 'suspended') {
                audioContextRef.current.resume();
            }

            // Apply current gain dynamically
            if (gainNodeRef.current) {
                const currentTime = audioContextRef.current?.currentTime || 0;
                gainNodeRef.current.gain.setTargetAtTime(normalizationGain, currentTime, 0.1);
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
    }, [isNormalizationEnabled, normalizationGain]);

    const toggleNormalization = () => {
        const newVal = !isNormalizationEnabled;
        setIsNormalizationEnabled(newVal);
        localStorage.setItem('w2g-player-normalization', String(newVal));
    };

    const updateNormalizationGain = (val: number) => {
        setNormalizationGain(val);
        localStorage.setItem('w2g-player-normalization-gain', String(val));
    };

    // Initialize DASH with separate video/audio streams
    useEffect(() => {
        if (!isDashMode) {
            dashInitialized.current = null;
            return;
        }

        const video = videoRef.current;
        const audio = audioRef.current;
        if (!video || !audio || !videoUrl || !audioUrl) return;

        // Prevent re-initialization if already initialized with same URLs
        const initKey = `${videoUrl}|${audioUrl}`;
        if (dashInitialized.current === initKey) {
            return;
        }
        dashInitialized.current = initKey;

        console.log('[DASH] Initializing with separate video/audio streams');
        console.log('[DASH] Video URL:', videoUrl.substring(0, 100) + '...');
        console.log('[DASH] Audio URL:', audioUrl.substring(0, 100) + '...');
        setError(null);
        setIsLoading(true);

        // Set up video (will be muted, audio comes from audio element)
        video.src = videoUrl;
        video.muted = true; // Video element ALWAYS muted in DASH mode
        video.load();

        // Set up audio - apply user's saved preferences
        audio.src = audioUrl;
        const savedMuted = localStorage.getItem('w2g-player-muted') === 'true';
        const savedVolume = localStorage.getItem('w2g-player-volume');
        audio.muted = savedMuted;
        audio.volume = savedVolume !== null ? parseFloat(savedVolume) : 1.0;
        console.log('[DASH] Audio muted:', savedMuted, 'volume:', audio.volume);
        audio.load();

        // Set up qualities from availableQualities
        if (availableQualities && availableQualities.length > 0) {
            const dashQualities = availableQualities.map((q, index) => ({
                height: q.height,
                bitrate: q.tbr ? q.tbr * 1000 : (q.height * 5000), // Estimate bitrate if not provided
                index,
            }));
            console.log('[DASH] Available qualities:', dashQualities);
            setQualities(dashQualities);
            setCurrentQuality(0); // Start with best quality
        }

        const onVideoLoaded = () => {
            console.log('[DASH] Video loaded, duration:', video.duration);
        };

        const onAudioLoaded = () => {
            console.log('[DASH] Audio loaded, duration:', audio.duration);
        };

        const onBothLoaded = () => {
            setIsLoading(false);
            setDuration(video.duration || audio.duration);

            if (initialTime > 0 && Number.isFinite(initialTime) && !isLive) {
                video.currentTime = initialTime;
                audio.currentTime = initialTime;
                setCurrentTime(initialTime);
            }

            if (autoPlay) {
                isAutoPlaying.current = true;
                console.log('[DASH] Attempting autoplay...');
                // Play both - video is muted, audio handles sound
                // Try to play video first (muted), then audio
                video.play()
                    .then(() => {
                        console.log('[DASH] Video playing');
                        return audio.play();
                    })
                    .then(() => {
                        console.log('[DASH] Audio playing');
                        setIsPlaying(true);
                    })
                    .catch((err) => {
                        console.warn('[DASH] Autoplay blocked:', err);
                        // Try with audio muted too
                        audio.muted = true;
                        setIsMuted(true);
                        Promise.all([video.play(), audio.play()])
                            .then(() => setIsPlaying(true))
                            .catch(() => setIsPlaying(false));
                    })
                    .finally(() => {
                        setTimeout(() => { isAutoPlaying.current = false; }, 1000);
                    });
            }
        };

        let videoLoaded = false;
        let audioLoaded = false;

        const checkBothLoaded = () => {
            if (videoLoaded && audioLoaded) {
                onBothLoaded();
            }
        };

        const onVideoLoadedMeta = () => {
            onVideoLoaded();
            videoLoaded = true;
            checkBothLoaded();
        };

        const onAudioLoadedMeta = () => {
            onAudioLoaded();
            audioLoaded = true;
            checkBothLoaded();
        };

        const onVideoError = (e: Event) => {
            console.error('[DASH] Video error:', video.error);
            setError(`Video load failed: ${video.error?.message || 'Unknown error'}`);
        };

        const onAudioError = (e: Event) => {
            console.error('[DASH] Audio error:', audio.error);
            setError(`Audio load failed: ${audio.error?.message || 'Unknown error'}`);
        };

        video.addEventListener('loadedmetadata', onVideoLoadedMeta, { once: true });
        audio.addEventListener('loadedmetadata', onAudioLoadedMeta, { once: true });
        video.addEventListener('error', onVideoError, { once: true });
        audio.addEventListener('error', onAudioError, { once: true });

        // Sync audio with video on seek
        const syncAudioToVideo = () => {
            if (audio && video && Math.abs(audio.currentTime - video.currentTime) > 0.3) {
                audio.currentTime = video.currentTime;
            }
        };

        video.addEventListener('seeked', syncAudioToVideo);
        video.addEventListener('seeking', () => {
            if (audio) audio.currentTime = video.currentTime;
        });

        // Handle play/pause sync
        const onVideoPlay = () => {
            audio?.play().catch(console.warn);
        };
        const onVideoPause = () => {
            audio?.pause();
        };

        video.addEventListener('play', onVideoPlay);
        video.addEventListener('pause', onVideoPause);

        // Periodic sync to prevent drift
        const syncInterval = setInterval(() => {
            if (video && audio && !video.paused) {
                const drift = Math.abs(audio.currentTime - video.currentTime);
                if (drift > 0.2) {
                    console.log(`[DASH] Correcting drift: ${drift.toFixed(3)}s`);
                    audio.currentTime = video.currentTime;
                }
            }
        }, 1000);

        return () => {
            clearInterval(syncInterval);
            video.removeEventListener('play', onVideoPlay);
            video.removeEventListener('pause', onVideoPause);
            // Reset init tracking on cleanup
            dashInitialized.current = null;
        };
        // Only depend on URL changes - other props are read from refs or current values
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [videoUrl, audioUrl]);

    // ... (HLS init logic)
    // Initialize HLS (skip if DASH mode)
    useEffect(() => {
        if (isDashMode) return; // Skip HLS init when using DASH

        const video = videoRef.current;
        if (!video || !src) return;

        setError(null);
        setIsLoading(true);

        const initPlayer = () => {
            const isHlsSource = (typeof url === 'object' && url.type === 'application/x-mpegurl') ||
                (typeof src === 'string' && (src.includes('.m3u8') || src.includes('.m3u') || src.includes('manifest')));

            // Determine if we should attempt HLS.js
            // If it's Safari (native HLS), Hls.isSupported() might be true but we might prefer native or vice-versa.
            // Usually check Hls.isSupported() first.
            if (isHlsSource && Hls.isSupported()) {
                if (hlsRef.current) hlsRef.current.destroy();

                const hls = new Hls({
                    enableWorker: true,
                    lowLatencyMode: true,
                    backBufferLength: 90,
                    liveSyncDurationCount: 3,
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
                    console.log('HLS Manifest Parsed:', data.levels.length, 'levels', data.levels);

                    const levels = data.levels.map((level, index) => ({
                        height: level.height || 0,
                        bitrate: level.bitrate || 0,
                        index,
                    }));

                    // More permissive filter: Just ensure we have distinct levels. 
                    // Sometimes audio-only or low-res streams have height=0.
                    // We want to show them if they are distinct bitrates.
                    const uniqueLevels = levels.filter((l, i, self) =>
                        i === self.findIndex((t) => (
                            t.height === l.height && t.bitrate === l.bitrate
                        ))
                    );

                    // Sort by bitrate desc
                    uniqueLevels.sort((a, b) => b.bitrate - a.bitrate);

                    setQualities(uniqueLevels);

                    // Set initial time if provided
                    if (initialTime > 0 && Number.isFinite(initialTime) && !isLive) {
                        video.currentTime = initialTime;
                        setCurrentTime(initialTime);
                    }

                    if (autoPlay) {
                        const savedMuted = localStorage.getItem('w2g-player-muted') === 'true';
                        video.muted = savedMuted;
                        setIsMuted(savedMuted);

                        isAutoPlaying.current = true;
                        video.play().catch(() => {
                            console.log('Autoplay blocked, falling back to muted');
                            video.muted = true;
                            setIsMuted(true);
                            video.play().catch(() => setIsPlaying(false));
                        }).finally(() => {
                            setTimeout(() => { isAutoPlaying.current = false; }, 1000);
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
                    if (level) {
                        setStats(prev => ({
                            ...prev,
                            videoCodec: level.videoCodec || '',
                            audioCodec: level.audioCodec || '',
                        }));
                    }
                });

                hlsRef.current = hls;
            } else {
                // Standard Native Playback (MP4 / Native HLS on Safari)
                video.src = src;
                video.load();

                const onLoadedMetadata = () => {
                    setIsLoading(false);

                    if (initialTime > 0 && Number.isFinite(initialTime) && !isLive) {
                        video.currentTime = initialTime;
                        setCurrentTime(initialTime);
                    }

                    if (autoPlay) {
                        const savedMuted = localStorage.getItem('w2g-player-muted') === 'true';
                        video.muted = savedMuted;
                        setIsMuted(savedMuted);

                        isAutoPlaying.current = true;
                        video.play().catch(() => {
                            console.log('Autoplay blocked, falling back to muted');
                            video.muted = true;
                            setIsMuted(true);
                            video.play().catch(() => setIsPlaying(false));
                        }).finally(() => {
                            setTimeout(() => { isAutoPlaying.current = false; }, 1000);
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
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [src, autoPlay, isLive]);

    // Video Event Handlers
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        const onVideoPlay = () => {
            setIsPlaying(true);
            if (!isAutoPlaying.current) onPlay?.();
        };
        const onVideoPause = () => {
            setIsPlaying(false);
            onPause?.();
        };
        const onVideoSeeked = () => {
            if (!isAutoPlaying.current) onSeeked?.(video.currentTime);
        };
        const onVideoEnded = () => {
            setIsPlaying(false);
            onEnd?.();
        };
        const onVideoTimeUpdate = () => {
            setCurrentTime(video.currentTime);
            onTimeUpdate?.(video.currentTime, !video.paused);
            if (video.duration) setDuration(video.duration);

            if (isLive && video.seekable.length > 0) {
                const end = video.seekable.end(video.seekable.length - 1);
                setLiveLatency(Math.max(0, end - video.currentTime));
                setSeekableRange({ start: video.seekable.start(0), end });
            }
        };

        video.addEventListener('play', onVideoPlay);
        video.addEventListener('pause', onVideoPause);
        video.addEventListener('seeked', onVideoSeeked);
        video.addEventListener('ended', onVideoEnded);
        video.addEventListener('timeupdate', onVideoTimeUpdate);

        return () => {
            video.removeEventListener('play', onVideoPlay);
            video.removeEventListener('pause', onVideoPause);
            video.removeEventListener('seeked', onVideoSeeked);
            video.removeEventListener('ended', onVideoEnded);
            video.removeEventListener('timeupdate', onVideoTimeUpdate);
        };
    }, [isLive, onPlay, onPause, onSeeked, onEnd, onTimeUpdate]);


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

    const handleQualityChange = (index: number) => {
        if (isDashMode && availableQualities && availableQualities[index]) {
            // DASH quality change - switch video URL while maintaining playback position
            const video = videoRef.current;
            const audio = audioRef.current;
            if (!video) return;

            const currentTime = video.currentTime;
            const wasPlaying = !video.paused;

            console.log(`[DASH] Switching to quality ${index}: ${availableQualities[index].height}p`);

            video.src = availableQualities[index].video_url;
            video.load();

            video.addEventListener('loadedmetadata', () => {
                video.currentTime = currentTime;
                if (audio) audio.currentTime = currentTime;
                if (wasPlaying) {
                    video.play().catch(console.warn);
                    audio?.play().catch(console.warn);
                }
            }, { once: true });

            setCurrentQuality(index);
            setCurrentDashQuality(index);
        } else if (hlsRef.current) {
            hlsRef.current.currentLevel = index;
            setCurrentQuality(index);
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

            {/* Hidden audio element for DASH mode (separate video/audio streams) */}
            {/* Always render but hide - ensures ref is available when DASH mode activates */}
            <audio
                ref={audioRef}
                style={{ display: 'none' }}
                preload="auto"
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
                normalizationGain={normalizationGain}
                onNormalizationGainChange={updateNormalizationGain}
                syncThreshold={syncThreshold}
                onSyncThresholdChange={onSyncThresholdChange}
                onPlayToggle={() => {
                    // Start AudioContext on user gesture
                    if (audioContextRef.current?.state === 'suspended') {
                        audioContextRef.current.resume();
                    }
                    if (isLive && isPlaying) return; // Prevent pausing live

                    if (isDashMode) {
                        // In DASH mode, sync both video and audio
                        if (isPlaying) {
                            videoRef.current?.pause();
                            audioRef.current?.pause();
                        } else {
                            videoRef.current?.play();
                            audioRef.current?.play();
                        }
                    } else {
                        isPlaying ? videoRef.current?.pause() : videoRef.current?.play();
                    }
                }}
                onMuteToggle={() => {
                    if (isDashMode && audioRef.current) {
                        // In DASH mode, control the audio element
                        const newMuted = !audioRef.current.muted;
                        audioRef.current.muted = newMuted;
                        setIsMuted(newMuted);
                        localStorage.setItem('w2g-player-muted', String(newMuted));
                        console.log('[DASH] Mute toggled to:', newMuted);
                    } else if (videoRef.current) {
                        // Resume AudioContext if needed (often required for audio to start/unmute in some browsers)
                        if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
                            audioContextRef.current.resume();
                        }

                        const newMuted = !videoRef.current.muted;
                        videoRef.current.muted = newMuted;
                        setIsMuted(newMuted);
                        localStorage.setItem('w2g-player-muted', String(newMuted));
                        console.log('[CustomPlayer] Mute toggled to:', newMuted);
                    }
                }}
                onVolumeChange={(val) => {
                    if (isDashMode && audioRef.current) {
                        // In DASH mode, control the audio element
                        audioRef.current.volume = val;
                        setVolume(val);
                        localStorage.setItem('w2g-player-volume', String(val));
                        // Unmute if dragging volume slider
                        if (val > 0 && isMuted) {
                            audioRef.current.muted = false;
                            setIsMuted(false);
                            localStorage.setItem('w2g-player-muted', 'false');
                        }
                    } else if (videoRef.current) {
                        videoRef.current.volume = val;
                        setVolume(val);
                        localStorage.setItem('w2g-player-volume', String(val));
                        // Unmute if dragging volume slider
                        if (val > 0 && isMuted) {
                            videoRef.current.muted = false;
                            setIsMuted(false);
                            localStorage.setItem('w2g-player-muted', 'false');
                        }
                    }
                }}
                onFullscreenToggle={toggleFullscreen}
                onPiPToggle={() => videoRef.current?.requestPictureInPicture()}
                onSettingsToggle={() => setShowSettings(!showSettings)}
                onStatsToggle={() => setShowStats(!showStats)}
                onQualityChange={handleQualityChange}
                onSeek={(time) => {
                    if (videoRef.current) {
                        videoRef.current.currentTime = time;
                    }
                    if (isDashMode && audioRef.current) {
                        audioRef.current.currentTime = time;
                    }
                }}
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
