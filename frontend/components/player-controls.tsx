'use client';

import { Play, Pause, Volume2, VolumeX, Maximize, Minimize, Settings, Activity, PictureInPicture, Ear } from 'lucide-react';
import { cn } from '@/lib/utils';


interface PlayerControlsProps {
    isPlaying: boolean;
    isMuted: boolean;
    volume: number;
    currentTime: number;
    duration?: number;
    liveLatency?: number;
    showSettings: boolean;
    showStats: boolean;
    isFullscreen: boolean;
    currentQuality: number;
    qualities: { height: number; index: number; bitrate: number; vcodec?: string }[];
    seekableForDVR?: { start: number; end: number };
    visible: boolean;
    className?: string;
    onPlayToggle: () => void;
    onMuteToggle: () => void;
    onVolumeChange: (val: number) => void;
    onFullscreenToggle: () => void;
    onPiPToggle: () => void;
    onSettingsToggle: () => void;
    onStatsToggle: () => void;
    onQualityChange: (index: number) => void;
    onSeek: (time: number) => void;
    normalizationActive?: boolean;
    onToggleNormalization?: () => void;
    normalizationGain?: number;
    onNormalizationGainChange?: (val: number) => void;
    isLive?: boolean;
    syncThreshold?: number;
    onSyncThresholdChange?: (val: number) => void;
}

export function PlayerControls({
    isPlaying,
    isMuted,
    volume,
    currentTime,
    duration,
    liveLatency,
    showSettings,
    showStats,
    isFullscreen,
    currentQuality,
    qualities,
    seekableForDVR,
    visible,
    className,
    onPlayToggle,
    onMuteToggle,
    onVolumeChange,
    onFullscreenToggle,
    onPiPToggle,
    onSettingsToggle,
    onStatsToggle,
    onQualityChange,
    onSeek,
    normalizationActive,
    onToggleNormalization,
    normalizationGain,
    onNormalizationGainChange,
    isLive,
    syncThreshold,
    onSyncThresholdChange
}: PlayerControlsProps) {

    const formatTime = (seconds: number) => {
        if (!seconds || isNaN(seconds)) return '0:00';
        const hrs = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        if (hrs > 0) return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    };

    const handleSeekChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        onSeek(parseFloat(e.target.value));
    };

    const displayDuration = seekableForDVR ? seekableForDVR.end - seekableForDVR.start : (duration || 0);
    const displayCurrentTime = seekableForDVR ? currentTime - seekableForDVR.start : currentTime;
    const progress = displayDuration > 0 ? (displayCurrentTime / displayDuration) * 100 : 0;

    return (
        <div className={cn(
            "absolute bottom-0 left-0 right-0 transition-all duration-300 z-40",
            visible ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0 pointer-events-none",
            className
        )}>
            {/* Gradient Background */}
            <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent pointer-events-none" />

            <div className="relative px-4 pb-4 pt-12">
                {/* Progress Bar */}
                {!isLive && (
                    <div className="group/progress relative h-1 w-full mb-3 cursor-pointer">
                        {/* Track Background */}
                        <div className="absolute inset-0 bg-white/20 rounded-full overflow-hidden">
                            {/* Progress Fill */}
                            <div
                                className="h-full bg-violet-500 rounded-full transition-all duration-100"
                                style={{ width: `${progress}%` }}
                            />
                        </div>
                        {/* Scrubber Handle */}
                        <div
                            className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full shadow-lg opacity-0 group-hover/progress:opacity-100 transition-opacity pointer-events-none"
                            style={{ left: `calc(${progress}% - 6px)` }}
                        />
                        {/* Hidden Range Input */}
                        <input
                            type="range"
                            min={seekableForDVR ? seekableForDVR.start : 0}
                            max={seekableForDVR ? seekableForDVR.end : duration || 100}
                            step="0.1"
                            value={currentTime}
                            onChange={handleSeekChange}
                            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                        />
                    </div>
                )}

                {/* Live Indicator */}
                {isLive && (
                    <div className="flex items-center gap-2 mb-3">
                        <div className="h-1 flex-1 bg-white/20 rounded-full overflow-hidden">
                            <div className="h-full w-full bg-red-500/60 animate-pulse" />
                        </div>
                        <span className="text-[10px] font-semibold text-red-500 bg-red-500/10 px-2 py-0.5 rounded-full border border-red-500/20">
                            LIVE
                        </span>
                    </div>
                )}

                {/* Controls Row */}
                <div className="flex items-center justify-between gap-3">
                    {/* Left Side */}
                    <div className="flex items-center gap-2">
                        {/* Play/Pause */}
                        <button
                            onClick={onPlayToggle}
                            className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-all hover:scale-105 active:scale-95"
                        >
                            {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5 ml-0.5" />}
                        </button>

                        {/* Volume */}
                        <div className="flex items-center gap-1 group">
                            <button
                                onClick={onMuteToggle}
                                className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/80 hover:text-white transition-all"
                            >
                                {isMuted || volume === 0 ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                            </button>
                            <div className="w-0 group-hover:w-20 overflow-hidden transition-all duration-300">
                                <input
                                    type="range"
                                    min="0"
                                    max="1"
                                    step="0.01"
                                    value={isMuted ? 0 : volume}
                                    onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
                                    className="w-full h-1 bg-white/20 rounded-full appearance-none cursor-pointer accent-white"
                                />
                            </div>
                        </div>

                        {/* Time Display */}
                        <div className="text-xs text-white/80 font-medium tabular-nums ml-1">
                            {isLive ? (
                                <span className="text-red-400">LIVE</span>
                            ) : (
                                <span>{formatTime(currentTime)} / {formatTime(duration || 0)}</span>
                            )}
                        </div>

                        {/* Live Latency */}
                        {liveLatency !== undefined && (
                            <div className="flex items-center gap-1 ml-2 px-2 py-0.5 rounded-full bg-white/5">
                                <span className={cn(
                                    "w-1.5 h-1.5 rounded-full animate-pulse",
                                    liveLatency < 5 ? "bg-emerald-500" : "bg-amber-500"
                                )} />
                                <span className="text-[10px] text-white/60">
                                    {liveLatency < 5 ? "Live" : `-${Math.round(liveLatency)}s`}
                                </span>
                            </div>
                        )}
                    </div>

                    {/* Right Side */}
                    <div className="flex items-center gap-1">
                        {/* Audio Normalization */}
                        {onToggleNormalization && (
                            <button
                                onClick={onToggleNormalization}
                                title="Audio Normalization"
                                className={cn(
                                    "w-8 h-8 rounded-full flex items-center justify-center transition-all",
                                    normalizationActive
                                        ? "bg-violet-500/20 text-violet-400"
                                        : "hover:bg-white/10 text-white/60 hover:text-white"
                                )}
                            >
                                <Ear className="w-4 h-4" />
                            </button>
                        )}

                        {/* Stats */}
                        <button
                            onClick={onStatsToggle}
                            title="Stats"
                            className={cn(
                                "w-8 h-8 rounded-full flex items-center justify-center transition-all",
                                showStats
                                    ? "bg-emerald-500/20 text-emerald-400"
                                    : "hover:bg-white/10 text-white/60 hover:text-white"
                            )}
                        >
                            <Activity className="w-4 h-4" />
                        </button>

                        {/* Settings */}
                        <button
                            onClick={onSettingsToggle}
                            title="Quality"
                            className={cn(
                                "w-8 h-8 rounded-full flex items-center justify-center transition-all",
                                showSettings
                                    ? "bg-white/20 text-white"
                                    : "hover:bg-white/10 text-white/60 hover:text-white"
                            )}
                        >
                            <Settings className={cn("w-4 h-4 transition-transform", showSettings && "rotate-90")} />
                        </button>

                        {/* PiP */}
                        <button
                            onClick={onPiPToggle}
                            title="Picture in Picture"
                            className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                        >
                            <PictureInPicture className="w-4 h-4" />
                        </button>

                        {/* Fullscreen */}
                        <button
                            onClick={onFullscreenToggle}
                            title="Fullscreen"
                            className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                        >
                            {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
                        </button>
                    </div>
                </div>
            </div>

            {/* Quality Settings Panel */}
            {showSettings && (
                <div className="absolute bottom-full right-4 mb-2 w-56 bg-zinc-900/95 backdrop-blur-xl border border-white/10 rounded-xl overflow-hidden shadow-2xl">
                    <div className="px-4 py-3 border-b border-white/5">
                        <span className="text-xs font-medium text-white">Quality</span>
                    </div>

                    <div className="p-2 max-h-64 overflow-y-auto">
                        {/* Normalization Gain */}
                        {normalizationActive && onNormalizationGainChange && typeof normalizationGain === 'number' && (
                            <div className="px-3 py-2 border-b border-white/5 mb-2">
                                <div className="flex justify-between items-center mb-2">
                                    <span className="text-[10px] font-medium text-violet-400 flex items-center gap-1">
                                        <Ear className="w-3 h-3" /> Gain
                                    </span>
                                    <span className="text-[10px] text-zinc-400">
                                        {(20 * Math.log10(normalizationGain)).toFixed(1)} dB
                                    </span>
                                </div>
                                <input
                                    type="range"
                                    min="0.5"
                                    max="3.0"
                                    step="0.1"
                                    value={normalizationGain}
                                    onChange={(e) => onNormalizationGainChange(parseFloat(e.target.value))}
                                    className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-violet-500"
                                />
                            </div>
                        )}

                        {/* Sync Threshold */}
                        {onSyncThresholdChange && syncThreshold !== undefined && (
                            <div className="px-3 py-2 border-b border-white/5 mb-2">
                                <div className="flex justify-between items-center mb-2">
                                    <span className="text-[10px] font-medium text-emerald-400 flex items-center gap-1">
                                        <Activity className="w-3 h-3" /> Sync
                                    </span>
                                    <span className="text-[10px] text-zinc-400">
                                        {syncThreshold}s
                                    </span>
                                </div>
                                <input
                                    type="range"
                                    min="1"
                                    max="10"
                                    step="0.5"
                                    value={syncThreshold}
                                    onChange={(e) => onSyncThresholdChange(parseFloat(e.target.value))}
                                    className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-emerald-500"
                                />
                            </div>
                        )}

                        {/* Quality Options */}
                        <button
                            onClick={() => onQualityChange(-1)}
                            className={cn(
                                "w-full px-3 py-2 rounded-lg text-left text-xs font-medium transition-all",
                                currentQuality === -1
                                    ? "bg-violet-500/20 text-violet-400"
                                    : "text-zinc-400 hover:bg-white/5 hover:text-white"
                            )}
                        >
                            Auto
                        </button>
                        {qualities.map((q) => (
                            <button
                                key={q.index}
                                onClick={() => onQualityChange(q.index)}
                                className={cn(
                                    "w-full px-3 py-2 rounded-lg text-left text-xs font-medium transition-all flex items-center justify-between",
                                    currentQuality === q.index
                                        ? "bg-violet-500/20 text-violet-400"
                                        : "text-zinc-400 hover:bg-white/5 hover:text-white"
                                )}
                            >
                                <div className="flex items-center gap-2">
                                    <span>{q.height ? `${q.height}p` : `Level ${q.index}`}</span>
                                    {q.vcodec && (
                                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-white/5 text-zinc-500 uppercase">
                                            {q.vcodec.includes('vp9') ? 'VP9' : q.vcodec.includes('av01') ? 'AV1' : q.vcodec.includes('avc') ? 'H264' : q.vcodec.split('.')[0]}
                                        </span>
                                    )}
                                </div>
                                <span className="text-[10px] text-zinc-500">{(q.bitrate / 1000).toFixed(0)}k</span>
                            </button>
                        ))}
                    </div>
                </div>
            )}

            <style jsx global>{`
                input[type='range'] {
                    -webkit-appearance: none;
                    background: transparent;
                }
                input[type='range']::-webkit-slider-thumb {
                    -webkit-appearance: none;
                    height: 12px;
                    width: 12px;
                    border-radius: 50%;
                    background: white;
                    cursor: pointer;
                    margin-top: -4px;
                }
                input[type='range']::-webkit-slider-runnable-track {
                    width: 100%;
                    height: 4px;
                    background: rgba(255,255,255,0.2);
                    border-radius: 4px;
                }
            `}</style>
        </div>
    );
}
