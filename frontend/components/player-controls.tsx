'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Play, Pause, Volume2, VolumeX, Maximize, Minimize, Settings, Activity, PictureInPicture, Ear, Headphones } from 'lucide-react';
import { cn } from '@/lib/utils';
import { parseUpscaleMode, type UpscaleMode } from '@/lib/upscaling/policy';
import { parseQualityMode, type QualityMode } from '@/lib/quality-mode';
import { sponsorCategoryColor, sponsorCategoryLabel, type SponsorSegment } from '@/lib/sponsorblock';
import { chapterAt, type VideoChapter } from '@/lib/chapters';
import { storyboardFrame, type Storyboard } from '@/lib/storyboard';
import { HOVER_PREWARM_DELAY_MS } from '@/lib/constants';
import type { ShakaAudioTrack } from './player/hooks';


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
    audioTracks?: ShakaAudioTrack[];
    currentAudioTrack?: number;
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
    onAudioTrackChange?: (index: number) => void;
    onSeek: (time: number) => void;
    /**
     * The pointer has rested on the seek bar for `HOVER_PREWARM_DELAY_MS`,
     * at this time. A pointer only passing over says nothing.
     */
    onSeekHoverRest?: (time: number) => void;
    normalizationActive?: boolean;
    onToggleNormalization?: () => void;
    normalizationGain?: number;
    onNormalizationGainChange?: (val: number) => void;
    /** Every channel folded into one, so both speakers carry the same mix. */
    monoAudio?: boolean;
    onToggleMono?: () => void;
    /** What auto quality optimises for; absent on engines without a cap. */
    qualityMode?: QualityMode;
    onQualityModeChange?: (mode: QualityMode) => void;
    /** The rung auto settled on, shown on the Auto button. */
    autoHeight?: number;
    isLive?: boolean;
    syncThreshold?: number;
    onSyncThresholdChange?: (val: number) => void;
    enhancementMode?: UpscaleMode;
    onEnhancementModeChange?: (mode: UpscaleMode) => void;
    enhancementStatus?: string;
    /** Segments the room skips (or could skip), drawn on the seek bar. */
    sponsorSegments?: SponsorSegment[];
    /** Preview thumbnails shown while hovering the seek bar. */
    storyboard?: Storyboard;
    /** Chapters: boundaries on the seek bar, the name under the pointer and beside the time. */
    chapters?: VideoChapter[];
    /** The pointer entered or left the control bar; the owner holds the fade while it is over. */
    onPointerOverChange?: (over: boolean) => void;
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
    audioTracks = [],
    currentAudioTrack = -1,
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
    onAudioTrackChange,
    onSeek,
    onSeekHoverRest,
    normalizationActive,
    onToggleNormalization,
    normalizationGain,
    onNormalizationGainChange,
    monoAudio,
    onToggleMono,
    qualityMode,
    onQualityModeChange,
    autoHeight,
    isLive,
    syncThreshold,
    onSyncThresholdChange,
    enhancementMode = 'off',
    onEnhancementModeChange,
    enhancementStatus,
    sponsorSegments = [],
    storyboard,
    chapters = [],
    onPointerOverChange,
}: PlayerControlsProps) {
    const enhancementSelectId = useId();
    const qualityModeSelectId = useId();
    const audioTrackSelectId = useId();
    // Where on the seek bar the pointer is, as a fraction, or null when away.
    const [hoverFraction, setHoverFraction] = useState<number | null>(null);
    const progressRef = useRef<HTMLDivElement>(null);

    const hoverRestTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const clearHoverRest = () => {
        if (hoverRestTimer.current !== null) clearTimeout(hoverRestTimer.current);
        hoverRestTimer.current = null;
    };
    useEffect(() => clearHoverRest, []);

    const displayDuration = seekableForDVR ? seekableForDVR.end - seekableForDVR.start : (duration || 0);

    const updateHover = (clientX: number) => {
        const rect = progressRef.current?.getBoundingClientRect();
        if (!rect || rect.width === 0) return;
        const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
        setHoverFraction(fraction);
        // Every movement restarts the wait: only a pointer that stops counts.
        clearHoverRest();
        if (!onSeekHoverRest || displayDuration <= 0) return;
        const time = (seekableForDVR?.start ?? 0) + fraction * displayDuration;
        hoverRestTimer.current = setTimeout(() => {
            hoverRestTimer.current = null;
            onSeekHoverRest(time);
        }, HOVER_PREWARM_DELAY_MS);
    };

    const leaveHover = () => {
        clearHoverRest();
        setHoverFraction(null);
    };

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

    const displayCurrentTime = seekableForDVR ? currentTime - seekableForDVR.start : currentTime;
    const progress = displayDuration > 0 ? (displayCurrentTime / displayDuration) * 100 : 0;
    const currentChapter = chapterAt(chapters, currentTime);

    return (
        <div className={cn(
            "absolute inset-0 pointer-events-none transition-all duration-300 z-40",
            visible ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0 pointer-events-none",
            className
        )}>
            <div
                className={cn("absolute bottom-0 left-0 right-0", visible && "pointer-events-auto")}
                data-testid="control-bar"
                onPointerEnter={() => onPointerOverChange?.(true)}
                onPointerLeave={() => onPointerOverChange?.(false)}
            >
            {/* Gradient Background */}
            <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent pointer-events-none" />

            <div className="relative px-4 pb-4 pt-12">
                {/* Progress Bar */}
                {!isLive && (
                    <div
                        ref={progressRef}
                        className="group/progress relative h-4 w-full mb-2 cursor-pointer"
                        onPointerMove={(e) => updateHover(e.clientX)}
                        onPointerLeave={leaveHover}
                    >
                        {/* Hover preview: the storyboard frame and time at the pointer */}
                        {hoverFraction !== null && displayDuration > 0 && (() => {
                            const hoverTime = (seekableForDVR?.start ?? 0) + hoverFraction * displayDuration;
                            const frame = storyboard ? storyboardFrame(storyboard, hoverTime) : null;
                            const hoverChapter = chapterAt(chapters, hoverTime);
                            return (
                                <div
                                    data-testid="seek-preview"
                                    className="absolute bottom-5 -translate-x-1/2 flex flex-col items-center gap-1 pointer-events-none"
                                    style={{ left: `${hoverFraction * 100}%` }}
                                >
                                    {frame && (
                                        <div
                                            data-testid="seek-preview-frame"
                                            className="rounded-md border border-white/20 shadow-xl bg-black"
                                            style={{
                                                width: frame.width,
                                                height: frame.height,
                                                backgroundImage: `url("${frame.url}")`,
                                                backgroundPosition: `-${frame.x}px -${frame.y}px`,
                                                backgroundRepeat: 'no-repeat',
                                            }}
                                        />
                                    )}
                                    {hoverChapter && (
                                        <span
                                            data-testid="seek-preview-chapter"
                                            className="max-w-[14rem] truncate px-1.5 py-0.5 rounded bg-black/80 text-[11px] text-white"
                                        >
                                            {hoverChapter.title}
                                        </span>
                                    )}
                                    <span className="px-1.5 py-0.5 rounded bg-black/80 text-[11px] text-white tabular-nums">
                                        {formatTime(hoverTime - (seekableForDVR?.start ?? 0))}
                                    </span>
                                </div>
                            );
                        })()}
                        {/* Track Background */}
                        <div className="absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/20 overflow-hidden transition-[height] duration-150 group-hover/progress:h-1.5">
                            {/* Progress Fill */}
                            <div
                                className="h-full bg-[color:var(--accent-primary)] rounded-full transition-all duration-100"
                                style={{ width: `${progress}%` }}
                            />
                            {/* SponsorBlock segments, in the category colours viewers know from the extension */}
                            {displayDuration > 0 && sponsorSegments.map((segment) => {
                                const start = Math.max(0, Math.min(segment.start, displayDuration));
                                const end = Math.max(start, Math.min(segment.end, displayDuration));
                                if (end <= start) return null;
                                return (
                                    <div
                                        key={segment.uuid ?? `${segment.category}-${segment.start}`}
                                        data-sponsor-segment={segment.category}
                                        title={sponsorCategoryLabel(segment.category)}
                                        className="absolute top-0 h-full opacity-80 pointer-events-none"
                                        style={{
                                            left: `${(start / displayDuration) * 100}%`,
                                            width: `${((end - start) / displayDuration) * 100}%`,
                                            backgroundColor: sponsorCategoryColor(segment.category),
                                        }}
                                    />
                                );
                            })}
                            {/* Chapter boundaries: a notch where each chapter after the first begins */}
                            {displayDuration > 0 && chapters.map((chapter) => {
                                if (chapter.start <= 0 || chapter.start >= displayDuration) return null;
                                return (
                                    <div
                                        key={chapter.start}
                                        data-chapter-marker
                                        title={chapter.title}
                                        className="absolute top-0 h-full w-0.5 bg-black/70 pointer-events-none"
                                        style={{ left: `${(chapter.start / displayDuration) * 100}%` }}
                                    />
                                );
                            })}
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
                            aria-label="Seek"
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
                            type="button"
                            onClick={onPlayToggle}
                            aria-label={isPlaying ? 'Pause' : 'Play'}
                            title={isPlaying ? 'Pause' : 'Play'}
                            className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-all hover:scale-105 active:scale-95"
                        >
                            {isPlaying ? <Pause aria-hidden="true" className="w-5 h-5" /> : <Play aria-hidden="true" className="w-5 h-5 ml-0.5" />}
                        </button>

                        {/* Volume */}
                        <div className="flex items-center gap-1 group">
                            <button
                                type="button"
                                onClick={onMuteToggle}
                                aria-label={isMuted || volume === 0 ? 'Unmute' : 'Mute'}
                                title={isMuted || volume === 0 ? 'Unmute' : 'Mute'}
                                className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/80 hover:text-white transition-all"
                            >
                                {isMuted || volume === 0 ? <VolumeX aria-hidden="true" className="w-4 h-4" /> : <Volume2 aria-hidden="true" className="w-4 h-4" />}
                            </button>
                            <div className="w-0 group-hover:w-20 overflow-hidden transition-all duration-300">
                                <input
                                    type="range"
                                    min="0"
                                    max="1"
                                    step="0.01"
                                    value={isMuted ? 0 : volume}
                                    onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
                                    aria-label="Volume"
                                    className="w-full h-1 bg-white/20 rounded-full appearance-none cursor-pointer accent-white"
                                />
                            </div>
                        </div>

                        {/* Time Display */}
                        <div className="text-xs text-white/80 font-medium tabular-nums ml-1">
                            {isLive ? (
                                <span className="text-red-400">LIVE</span>
                            ) : (
                                <>
                                    <span>{formatTime(currentTime)} / {formatTime(duration || 0)}</span>
                                    {currentChapter && (
                                        <span
                                            data-testid="current-chapter"
                                            title={currentChapter.title}
                                            className="ml-2 inline-block max-w-[14rem] truncate align-bottom text-white/60"
                                        >
                                            · {currentChapter.title}
                                        </span>
                                    )}
                                </>
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
                                type="button"
                                onClick={onToggleNormalization}
                                title="Audio normalization"
                                aria-label="Audio normalization"
                                aria-pressed={Boolean(normalizationActive)}
                                className={cn(
                                    "w-8 h-8 rounded-full flex items-center justify-center transition-all",
                                    normalizationActive
                                        ? "bg-[color:var(--accent-glow)] text-[color:var(--accent-primary)]"
                                        : "hover:bg-white/10 text-white/60 hover:text-white"
                                )}
                            >
                                <Ear aria-hidden="true" className="w-4 h-4" />
                            </button>
                        )}

                        {/* Stats */}
                        <button
                            type="button"
                            onClick={onStatsToggle}
                            title="Playback statistics"
                            aria-label="Playback statistics"
                            aria-pressed={showStats}
                            className={cn(
                                "w-8 h-8 rounded-full flex items-center justify-center transition-all",
                                showStats
                                    ? "bg-emerald-500/20 text-emerald-400"
                                    : "hover:bg-white/10 text-white/60 hover:text-white"
                            )}
                        >
                            <Activity aria-hidden="true" className="w-4 h-4" />
                        </button>

                        {/* Settings */}
                        <button
                            type="button"
                            onClick={onSettingsToggle}
                            title="Quality and sync settings"
                            aria-label="Quality and sync settings"
                            aria-expanded={showSettings}
                            className={cn(
                                "w-8 h-8 rounded-full flex items-center justify-center transition-all",
                                showSettings
                                    ? "bg-white/20 text-white"
                                    : "hover:bg-white/10 text-white/60 hover:text-white"
                            )}
                        >
                            <Settings aria-hidden="true" className={cn("w-4 h-4 transition-transform", showSettings && "rotate-90")} />
                        </button>

                        {/* PiP */}
                        <button
                            type="button"
                            onClick={onPiPToggle}
                            title="Picture in picture"
                            aria-label="Picture in picture"
                            className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                        >
                            <PictureInPicture aria-hidden="true" className="w-4 h-4" />
                        </button>

                        {/* Fullscreen */}
                        <button
                            type="button"
                            onClick={onFullscreenToggle}
                            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                            aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                            className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                        >
                            {isFullscreen ? <Minimize aria-hidden="true" className="w-4 h-4" /> : <Maximize aria-hidden="true" className="w-4 h-4" />}
                        </button>
                    </div>
                </div>
            </div>
            </div>

            {/* Quality Settings Panel */}
            {showSettings && (
                <div aria-label="Quality and sync settings" className="absolute bottom-20 right-2 sm:right-4 w-56 max-w-[calc(100%-1rem)] max-h-[calc(100%-5.5rem)] flex flex-col pointer-events-auto bg-zinc-900/95 backdrop-blur-xl border border-white/10 rounded-xl overflow-hidden shadow-2xl">
                    <div className="px-4 py-3 border-b border-white/5 shrink-0">
                        <span className="text-xs font-medium text-white">Quality</span>
                    </div>

                    <div className="p-2 min-h-0 overflow-y-auto">
                        {onAudioTrackChange && audioTracks.length > 1 && (
                            <div className="px-3 py-2 border-b border-white/5 mb-2">
                                <label htmlFor={audioTrackSelectId} className="block text-xs text-white mb-2">
                                    Audio track
                                </label>
                                <select
                                    id={audioTrackSelectId}
                                    aria-label="Audio track"
                                    value={currentAudioTrack}
                                    onChange={(event) => onAudioTrackChange(Number(event.target.value))}
                                    className="w-full rounded-md border border-white/15 bg-zinc-800 px-2 py-2 text-xs text-white focus-visible:outline-2 focus-visible:outline-[color:var(--accent-primary)]"
                                >
                                    {audioTracks.map((track) => (
                                        <option key={track.index} value={track.index}>
                                            {track.label || `${track.language || 'Unknown language'}${track.isOriginal ? ' · Original' : ''}`}
                                        </option>
                                    ))}
                                </select>
                                <p className="mt-2 text-[10px] leading-relaxed text-zinc-400">
                                    Your audio choice applies to this video only.
                                </p>
                            </div>
                        )}
                        {onEnhancementModeChange && (
                            <div className="px-3 py-2 border-b border-white/5 mb-2">
                                <label htmlFor={enhancementSelectId} className="flex items-center justify-between text-xs text-white mb-2">
                                    Video enhancement
                                    <span className="text-[10px] rounded px-1.5 py-0.5 bg-amber-400/10 text-amber-300">Beta</span>
                                </label>
                                <select id={enhancementSelectId} aria-label="Video enhancement (beta)"
                                    value={enhancementMode}
                                    onChange={event => onEnhancementModeChange(parseUpscaleMode(event.target.value))}
                                    className="w-full rounded-md border border-white/15 bg-zinc-800 px-2 py-2 text-xs text-white focus-visible:outline-2 focus-visible:outline-[color:var(--accent-primary)]">
                                    <option value="off">Off</option>
                                    <option value="auto">Auto — detect content</option>
                                    <option value="animation">Animation</option>
                                    <option value="general">General / live action</option>
                                </select>
                                <p className="mt-2 text-[10px] leading-relaxed text-zinc-400">Runs on your device. Applies only to your picture. May increase battery use.</p>
                                {enhancementMode !== 'off' && (
                                    <p role="status" aria-label="Video enhancement status" className="mt-2 text-[10px] leading-relaxed text-amber-200/90">
                                        {enhancementStatus}
                                    </p>
                                )}
                            </div>
                        )}
                        {/* Mono audio */}
                        {onToggleMono && (
                            <div className="px-3 py-2 border-b border-white/5 mb-2">
                                <button
                                    type="button"
                                    onClick={onToggleMono}
                                    aria-pressed={Boolean(monoAudio)}
                                    className="flex w-full items-center justify-between gap-2 text-xs text-white rounded-md focus-visible:outline-2 focus-visible:outline-[color:var(--accent-primary)]"
                                >
                                    <span className="flex items-center gap-1.5">
                                        <Headphones aria-hidden="true" className="w-3.5 h-3.5" /> Mono audio
                                    </span>
                                    <span className={cn(
                                        "text-[10px] rounded px-1.5 py-0.5",
                                        monoAudio
                                            ? "bg-[color:var(--accent-glow)] text-[color:var(--accent-primary)]"
                                            : "bg-white/10 text-zinc-400"
                                    )}>
                                        {monoAudio ? 'On' : 'Off'}
                                    </span>
                                </button>
                                <p className="mt-2 text-[10px] leading-relaxed text-zinc-400">
                                    Both speakers play the same mix, so nothing is lost on one side. Affects only your audio.
                                </p>
                            </div>
                        )}

                        {/* Normalization Gain */}
                        {normalizationActive && onNormalizationGainChange && typeof normalizationGain === 'number' && (
                            <div className="px-3 py-2 border-b border-white/5 mb-2">
                                <div className="flex justify-between items-center mb-2">
                                    <span className="text-[10px] font-medium text-[color:var(--accent-primary)] flex items-center gap-1">
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
                                    aria-label="Normalization gain"
                                    value={normalizationGain}
                                    onChange={(e) => onNormalizationGainChange(parseFloat(e.target.value))}
                                    className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-[color:var(--accent-primary)]"
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
                                    aria-label="Sync threshold in seconds"
                                    value={syncThreshold}
                                    onChange={(e) => onSyncThresholdChange(parseFloat(e.target.value))}
                                    className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-emerald-500"
                                />
                            </div>
                        )}

                        {/* What auto quality optimises for */}
                        {onQualityModeChange && qualityMode && (
                            <div className="px-3 py-2 border-b border-white/5 mb-2">
                                <label htmlFor={qualityModeSelectId} className="block text-xs text-white mb-2">
                                    Auto quality
                                </label>
                                <select id={qualityModeSelectId} aria-label="Auto quality"
                                    value={qualityMode}
                                    onChange={event => onQualityModeChange(parseQualityMode(event.target.value))}
                                    className="w-full rounded-md border border-white/15 bg-zinc-800 px-2 py-2 text-xs text-white focus-visible:outline-2 focus-visible:outline-[color:var(--accent-primary)]">
                                    <option value="balanced">Balanced — fits your player</option>
                                    <option value="highest">Highest — ignore player size</option>
                                    <option value="saver">Data saver — never sharper than shown</option>
                                </select>
                                <p className="mt-2 text-[10px] leading-relaxed text-zinc-400">
                                    Balanced keeps seeks quick by not fetching more pixels than your
                                    player shows. Highest follows your connection alone, so seeks on a
                                    large video can take longer. Applies to this browser only.
                                </p>
                            </div>
                        )}

                        {/* Quality Options. A source with no ladder — a
                            member's screen, a single-rendition stream —
                            offers nothing to choose between. */}
                        {qualities.length > 0 && (
                        <>
                        <button
                            type="button"
                            onClick={() => onQualityChange(-1)}
                            aria-pressed={currentQuality === -1}
                            className={cn(
                                "w-full px-3 py-2 rounded-lg text-left text-xs font-medium transition-all flex items-center justify-between",
                                currentQuality === -1
                                    ? "bg-[color:var(--accent-glow)] text-[color:var(--accent-primary)]"
                                    : "text-zinc-400 hover:bg-white/5 hover:text-white"
                            )}
                        >
                            <span>Auto</span>
                            {currentQuality === -1 && autoHeight ? (
                                <span data-testid="auto-rung" className="text-[10px] text-zinc-500">{autoHeight}p</span>
                            ) : null}
                        </button>
                        {qualities.map((q) => (
                            <button
                                key={q.index}
                                type="button"
                                onClick={() => onQualityChange(q.index)}
                                aria-pressed={currentQuality === q.index}
                                className={cn(
                                    "w-full px-3 py-2 rounded-lg text-left text-xs font-medium transition-all flex items-center justify-between",
                                    currentQuality === q.index
                                        ? "bg-[color:var(--accent-glow)] text-[color:var(--accent-primary)]"
                                        : "text-zinc-400 hover:bg-white/5 hover:text-white"
                                )}
                            >
                                <div className="flex items-center gap-2">
                                    <span>{q.height ? `${q.height}p` : `Level ${q.index}`}</span>
                                    {q.vcodec && (
                                        <span className="ui-label px-1.5 py-0.5 rounded bg-white/5">
                                            {q.vcodec.includes('vp9') ? 'VP9' : q.vcodec.includes('av01') ? 'AV1' : q.vcodec.includes('avc') ? 'H264' : q.vcodec.split('.')[0]}
                                        </span>
                                    )}
                                </div>
                                <span className="text-[10px] text-zinc-500">{(q.bitrate / 1000).toFixed(0)}k</span>
                            </button>
                        ))}
                        </>
                        )}
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
