'use client';

import type { FramegenMode } from '@/lib/framegen/policy';

import { useEffect, useRef, useState } from 'react';
import { Play, Pause, Volume2, VolumeX, Maximize, Minimize, Settings, Activity, PictureInPicture, Ear } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { UpscaleMode } from '@/lib/upscaling/policy';
import type { QualityMode } from '@/lib/quality-mode';
import { sponsorCategoryColor, sponsorCategoryLabel, type SponsorSegment } from '@/lib/sponsorblock';
import { chapterAt, type VideoChapter } from '@/lib/chapters';
import { storyboardFrame, type Storyboard } from '@/lib/storyboard';
import { HOVER_PREWARM_DELAY_MS } from '@/lib/constants';
import type { ShakaAudioTrack } from './player/hooks';
import { PlayerSettingsMenu } from './player-settings-menu';


/** Every button in the control bar: one size, one hover, icons at 20 px. */
const CONTROL_BUTTON = 'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10 hover:text-white [&_svg]:h-5 [&_svg]:w-5';
/** The same button while its feature is on. */
const CONTROL_BUTTON_ON = 'flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[color:var(--accent-glow)] text-[color:var(--accent-primary)] transition-colors [&_svg]:h-5 [&_svg]:w-5';

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
    nightModeActive?: boolean;
    onToggleNightMode?: () => void;
    normalizationStatus?: string;
    nightModeGain?: number;
    onNightModeGainChange?: (val: number) => void;
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
    framegenMode?: FramegenMode;
    onFramegenModeChange?: (mode: FramegenMode) => void;
    framegenStatus?: string;
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
    nightModeActive,
    onToggleNightMode,
    normalizationStatus,
    nightModeGain,
    onNightModeGainChange,
    monoAudio,
    onToggleMono,
    qualityMode,
    onQualityModeChange,
    autoHeight,
    isLive,
    syncThreshold,
    onSyncThresholdChange,
    framegenMode = 'off',
    onFramegenModeChange,
    framegenStatus,
    enhancementMode = 'off',
    onEnhancementModeChange,
    enhancementStatus,
    sponsorSegments = [],
    storyboard,
    chapters = [],
    onPointerOverChange,
}: PlayerControlsProps) {
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
        <>
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
                                            className="max-w-[14rem] truncate px-1.5 py-0.5 rounded bg-black/80 text-xs text-white"
                                        >
                                            {hoverChapter.title}
                                        </span>
                                    )}
                                    <span className="px-1.5 py-0.5 rounded bg-black/80 text-xs text-white tabular-nums">
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
                        <span className="text-2xs font-semibold text-red-500 bg-red-500/10 px-2 py-0.5 rounded-full border border-red-500/20">
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
                            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25"
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
                                className={CONTROL_BUTTON}
                            >
                                {isMuted || volume === 0 ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}
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
                        <div className="ml-1 text-sm font-medium tabular-nums text-white/90">
                            {isLive ? (
                                <span className="text-red-400">LIVE</span>
                            ) : (
                                <>
                                    <span className="whitespace-nowrap">{formatTime(currentTime)} / {formatTime(duration || 0)}</span>
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
                                <span className="text-xs text-white/60">
                                    {liveLatency < 5 ? "Live" : `-${Math.round(liveLatency)}s`}
                                </span>
                            </div>
                        )}
                    </div>

                    {/* Right Side */}
                    <div className="flex items-center gap-0.5">
                        {/* Audio Normalization */}
                        {onToggleNormalization && (
                            <button
                                type="button"
                                onClick={onToggleNormalization}
                                title="Normalize volume"
                                aria-label="Normalize volume shortcut"
                                aria-pressed={Boolean(normalizationActive)}
                                // A shortcut for the switch in Settings > Sound; a phone's bar
                                // has room for the essentials only.
                                className={cn(normalizationActive ? CONTROL_BUTTON_ON : CONTROL_BUTTON, "max-sm:hidden")}
                            >
                                <Ear aria-hidden="true" />
                            </button>
                        )}

                        {/* Stats */}
                        <button
                            type="button"
                            onClick={onStatsToggle}
                            title="Playback statistics"
                            aria-label="Playback statistics"
                            aria-pressed={showStats}
                            className={showStats ? CONTROL_BUTTON_ON : CONTROL_BUTTON}
                        >
                            <Activity aria-hidden="true" />
                        </button>

                        {/* Settings */}
                        <button
                            type="button"
                            onClick={onSettingsToggle}
                            title="Player settings"
                            aria-label="Player settings"
                            aria-expanded={showSettings}
                            className={cn(CONTROL_BUTTON, showSettings && "bg-white/15 text-white")}
                        >
                            <Settings aria-hidden="true" className={cn("transition-transform", showSettings && "rotate-90")} />
                        </button>

                        {/* PiP */}
                        <button
                            type="button"
                            onClick={onPiPToggle}
                            title="Picture in picture"
                            aria-label="Picture in picture"
                            className={cn(CONTROL_BUTTON, "max-sm:hidden")}
                        >
                            <PictureInPicture aria-hidden="true" />
                        </button>

                        {/* Fullscreen */}
                        <button
                            type="button"
                            onClick={onFullscreenToggle}
                            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                            aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                            className={CONTROL_BUTTON}
                        >
                            {isFullscreen ? <Minimize aria-hidden="true" /> : <Maximize aria-hidden="true" />}
                        </button>
                    </div>
                </div>
            </div>
            </div>

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
        {/* Outside the bar: its fade uses a transform, which would trap the
            phone sheet's fixed position inside the player. */}
        {showSettings && (
            <PlayerSettingsMenu
                onClose={onSettingsToggle}
                currentQuality={currentQuality}
                qualities={qualities}
                onQualityChange={onQualityChange}
                autoHeight={autoHeight}
                qualityMode={qualityMode}
                onQualityModeChange={onQualityModeChange}
                audioTracks={audioTracks}
                currentAudioTrack={currentAudioTrack}
                onAudioTrackChange={onAudioTrackChange}
                normalizationActive={normalizationActive}
                onToggleNormalization={onToggleNormalization}
                normalizationStatus={normalizationStatus}
                nightModeActive={nightModeActive}
                onToggleNightMode={onToggleNightMode}
                nightModeGain={nightModeGain}
                onNightModeGainChange={onNightModeGainChange}
                monoAudio={monoAudio}
                onToggleMono={onToggleMono}
                enhancementMode={enhancementMode}
                onEnhancementModeChange={onEnhancementModeChange}
                enhancementStatus={enhancementStatus}
                framegenMode={framegenMode}
                onFramegenModeChange={onFramegenModeChange}
                framegenStatus={framegenStatus}
                syncThreshold={syncThreshold}
                onSyncThresholdChange={onSyncThresholdChange}
            />
        )}
        </>
    );
}
