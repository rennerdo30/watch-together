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
    qualities: { height: number; index: number; bitrate: number }[];
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
    onGoToLive: () => void;
    // Non-essential but for matching the requested snippet
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
    // onGoToLive, // Unused currently
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

    // Determine display duration and current time based on DVR if applicable
    const displayDuration = seekableForDVR ? seekableForDVR.end - seekableForDVR.start : (duration || 0);
    const displayCurrentTime = seekableForDVR ? currentTime - seekableForDVR.start : currentTime;

    return (
        <div className={cn(
            "absolute bottom-0 left-0 right-0 p-4 transition-all duration-500 ease-out z-40 bg-gradient-to-t from-black/80 to-transparent",
            visible ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0 pointer-events-none",
            className
        )}>
            {/* Progress Bar Container - Hidden for Live Streams */}
            {!isLive && (
                <div className="group/progress relative h-1.5 w-full mb-4 bg-white/10 rounded-full cursor-pointer overflow-hidden transition-all duration-300 hover:h-2">
                    <input
                        type="range"
                        min={seekableForDVR ? seekableForDVR.start : 0}
                        max={seekableForDVR ? seekableForDVR.end : duration || 100}
                        step="0.1"
                        value={currentTime}
                        onChange={handleSeekChange}
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                    />
                    <div
                        className="absolute left-0 top-0 h-full bg-emerald-500/80 transition-all duration-100 ease-linear shadow-[0_0_10px_rgba(16,185,129,0.5)]"
                        style={{ width: `${(displayCurrentTime / (displayDuration || 1)) * 100}%` }}
                    />
                </div>
            )}

            {isLive && (
                <div className="w-full mb-4 flex items-center gap-2">
                    <div className="h-1.5 flex-1 bg-white/10 rounded-full overflow-hidden">
                        <div className="h-full w-full bg-emerald-500/50 animate-pulse" />
                    </div>
                    <span className="text-[10px] font-black text-emerald-500 bg-emerald-500/10 px-2 py-0.5 rounded uppercase tracking-widest border border-emerald-500/20 shadow-[0_0_10px_rgba(16,185,129,0.2)]">
                        LIVE BROADCAST
                    </span>
                </div>
            )}

            <div className="flex items-center justify-between gap-4">
                {/* Left Side: Play/Seek/Time */}
                <div className="flex items-center gap-4">
                    <button
                        onClick={onPlayToggle}
                        className="p-2 rounded-full hover:bg-white/10 text-white transition-all hover:scale-110 active:scale-95"
                    >
                        {isPlaying ? <Pause className="w-6 h-6 fill-white" /> : <Play className="w-6 h-6 fill-white" />}
                    </button>

                    <div className="flex flex-col">
                        <span className="text-white text-xs font-medium tabular-nums shadow-sm">
                            {isLive ? 'LIVE' : `${formatTime(currentTime)} / ${formatTime(duration || 0)}`}
                        </span>
                        {liveLatency !== undefined && (
                            <div className="flex items-center gap-1.5 mt-0.5">
                                <span className={cn(
                                    "w-1.5 h-1.5 rounded-full animate-pulse",
                                    liveLatency < 5 ? "bg-emerald-500" : "bg-amber-500"
                                )} />
                                <span className="text-[10px] text-zinc-400 font-bold uppercase tracking-wider">
                                    {liveLatency < 5 ? "Live" : `-${Math.round(liveLatency)}s`}
                                </span>
                            </div>
                        )}
                    </div>
                </div>

                {/* Right Side: Volume/Stats/Settings/Fullscreen */}
                <div className="flex items-center gap-2">
                    {/* Volume Control */}
                    <div className="flex items-center group">
                        <button
                            onClick={onMuteToggle}
                            className="p-2 rounded-full hover:bg-white/10 text-white transition-all flex-shrink-0"
                            title={isMuted ? "Unmute" : "Mute"}
                        >
                            {isMuted || volume === 0 ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
                        </button>
                        <div className="w-24 px-2 transition-all opacity-100 group-hover:w-28">
                            <input
                                type="range"
                                min="0"
                                max="1"
                                step="0.01"
                                value={isMuted ? 0 : volume}
                                onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
                                className="w-full accent-white h-1 rounded-full cursor-pointer touch-none"
                                aria-label="Volume"
                            />
                        </div>
                    </div>

                    <div className="h-4 w-[1px] bg-white/10 mx-1" />

                    {/* Action Buttons */}
                    <div className="flex items-center gap-1">
                        {onToggleNormalization && (
                            <button
                                onClick={onToggleNormalization}
                                title="Audio Normalization (Night Mode)"
                                className={cn(
                                    "p-2 rounded-full transition-all duration-300",
                                    normalizationActive ? "bg-indigo-500/20 text-indigo-400" : "hover:bg-white/10 text-zinc-400 hover:text-white"
                                )}
                            >
                                <Ear className="w-5 h-5" />
                            </button>
                        )}

                        <button
                            onClick={onStatsToggle}
                            title="Stats for Nerds"
                            className={cn(
                                "p-2 rounded-full transition-all duration-300",
                                showStats ? "bg-emerald-500/20 text-emerald-400" : "hover:bg-white/10 text-zinc-400 hover:text-white"
                            )}
                        >
                            <Activity className="w-5 h-5" />
                        </button>

                        <button
                            onClick={onSettingsToggle}
                            title="Quality Settings"
                            className={cn(
                                "p-2 rounded-full transition-all duration-300",
                                showSettings ? "bg-blue-500/20 text-blue-400 rotate-45" : "hover:bg-white/10 text-zinc-400 hover:text-white"
                            )}
                        >
                            <Settings className="w-5 h-5" />
                        </button>

                        <button
                            onClick={onPiPToggle}
                            title="Picture in Picture"
                            className="p-2 rounded-full hover:bg-white/10 text-zinc-400 hover:text-white transition-all"
                        >
                            <PictureInPicture className="w-5 h-5" />
                        </button>

                        <button
                            onClick={onFullscreenToggle}
                            title="Toggle Fullscreen"
                            className="p-2 rounded-full hover:bg-white/10 text-zinc-400 hover:text-white transition-all"
                        >
                            {isFullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
                        </button>
                    </div>
                </div>
            </div>

            {/* Quality Context Menu */}
            {showSettings && (
                <div className="absolute bottom-20 right-4 min-w-[160px] bg-black/80 backdrop-blur-xl border border-white/10 rounded-xl p-2 shadow-2xl animate-in fade-in slide-in-from-bottom-4 duration-300">
                    <div className="px-3 py-2 border-b border-white/5 mb-1">
                        <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Quality Settings</span>
                    </div>
                    <div className="space-y-1">

                        {normalizationActive && onNormalizationGainChange && typeof normalizationGain === 'number' && (
                            <div className="px-3 py-2 border-b border-white/5 mb-1">
                                <div className="flex justify-between items-center mb-2">
                                    <span className="text-[10px] font-bold text-indigo-400 uppercase tracking-widest flex items-center gap-1">
                                        <Ear className="w-3 h-3" /> Makeup Gain
                                    </span>
                                    <span className="text-[9px] text-zinc-400">
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
                                    className="w-full accent-indigo-500 h-1 rounded-full cursor-pointer touch-none"
                                />
                            </div>
                        )}

                        {onSyncThresholdChange && syncThreshold !== undefined && (
                            <div className="px-3 py-2 border-b border-white/5 mb-1">
                                <div className="flex justify-between items-center mb-2">
                                    <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-widest flex items-center gap-1">
                                        <Activity className="w-3 h-3" /> Sync Threshold
                                    </span>
                                    <span className="text-[9px] text-zinc-400">
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
                                    className="w-full accent-emerald-500 h-1 rounded-full cursor-pointer touch-none"
                                />
                            </div>
                        )}

                        <button
                            onClick={() => onQualityChange(-1)}
                            className={cn(
                                "w-full px-3 py-2 rounded-lg text-left text-xs font-medium transition-all",
                                currentQuality === -1 ? "bg-emerald-500/20 text-emerald-400" : "text-zinc-400 hover:bg-white/5 hover:text-white"
                            )}
                        >
                            Auto
                        </button>
                        {qualities.map((q) => (
                            <button
                                key={q.index}
                                onClick={() => onQualityChange(q.index)}
                                className={cn(
                                    "w-full px-3 py-2 rounded-lg text-left text-xs font-medium transition-all group flex items-center justify-between",
                                    currentQuality === q.index ? "bg-emerald-500/20 text-emerald-400" : "text-zinc-400 hover:bg-white/5 hover:text-white"
                                )}
                            >
                                <span>{q.height ? `${q.height}p` : `Level ${q.index}`}</span>
                                <span className="text-[9px] text-zinc-600 group-hover:text-zinc-500">{(q.bitrate / 1000).toFixed(0)} kbps</span>
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
          background: #10b981;
          cursor: pointer;
          margin-top: -4px;
          box-shadow: 0 0 10px rgba(16,185,129,0.5);
        }
        input[type='range']::-webkit-slider-runnable-track {
          width: 100%;
          height: 4px;
          background: rgba(255,255,255,0.1);
          border-radius: 4px;
        }
      `}</style>
        </div>
    );
}
