'use client';

import { useId, useState, type ReactNode } from 'react';
import { AudioLines, Check, ChevronLeft, ChevronRight, Film, Languages, Sparkles, Timer } from 'lucide-react';
import { SettingRow, Switch } from '@/components/settings-ui';
import { parseFramegenMode, type FramegenMode } from '@/lib/framegen/policy';
import { parseQualityMode, type QualityMode } from '@/lib/quality-mode';
import { parseUpscaleMode, type UpscaleMode } from '@/lib/upscaling/policy';
import { cn } from '@/lib/utils';
import type { ShakaAudioTrack } from './player/hooks';

/**
 * The player's settings, as a short list that opens sub-pages, the way video
 * players do. The first page shows one row per setting with its current
 * value; the detail and the help text live one level down, where there is
 * room for them.
 *
 * Over a wide player it is a popover above the control bar. On a narrow
 * screen it is a sheet at the bottom of the viewport: a phone-sized player
 * is about 220 px tall, which left room for two rows.
 */

type Page = 'main' | 'quality' | 'audio' | 'sound' | 'picture' | 'sync';

const PAGE_TITLES: Record<Exclude<Page, 'main'>, string> = {
    quality: 'Quality',
    audio: 'Audio track',
    sound: 'Sound',
    picture: 'Picture',
    sync: 'Sync',
};

const QUALITY_MODE_LABELS: Record<QualityMode, string> = {
    balanced: 'Balanced',
    highest: 'Highest',
    saver: 'Data saver',
};

const QUALITY_MODE_HELP: Record<QualityMode, string> = {
    balanced: 'Never fetches more pixels than your player shows, so seeks stay quick.',
    highest: 'Follows your connection alone. Seeks on a large video can take longer.',
    saver: 'Never sharper than the player shows, and one step lower when in doubt.',
};

const ENHANCEMENT_LABELS: Record<UpscaleMode, string> = {
    off: 'Off',
    auto: 'Auto',
    animation: 'Animation',
    general: 'Live action',
};

export interface PlayerSettingsMenuProps {
    onClose: () => void;
    currentQuality: number;
    qualities: { height: number; index: number; bitrate: number; vcodec?: string }[];
    onQualityChange: (index: number) => void;
    autoHeight?: number;
    qualityMode?: QualityMode;
    onQualityModeChange?: (mode: QualityMode) => void;
    audioTracks: ShakaAudioTrack[];
    currentAudioTrack: number;
    onAudioTrackChange?: (index: number) => void;
    normalizationActive?: boolean;
    onToggleNormalization?: () => void;
    normalizationStatus?: string;
    nightModeActive?: boolean;
    onToggleNightMode?: () => void;
    nightModeGain?: number;
    onNightModeGainChange?: (val: number) => void;
    monoAudio?: boolean;
    onToggleMono?: () => void;
    enhancementMode: UpscaleMode;
    onEnhancementModeChange?: (mode: UpscaleMode) => void;
    enhancementStatus?: string;
    framegenMode: FramegenMode;
    onFramegenModeChange?: (mode: FramegenMode) => void;
    framegenStatus?: string;
    syncThreshold?: number;
    onSyncThresholdChange?: (val: number) => void;
}

function codecLabel(vcodec: string): string {
    if (vcodec.includes('vp9') || vcodec.startsWith('vp09')) return 'VP9';
    if (vcodec.includes('av01')) return 'AV1';
    if (vcodec.includes('avc')) return 'H.264';
    return vcodec.split('.')[0];
}

function trackLabel(track: ShakaAudioTrack): string {
    return track.label || `${track.language || 'Unknown language'}${track.isOriginal ? ' · Original' : ''}`;
}

export function PlayerSettingsMenu(props: PlayerSettingsMenuProps) {
    const { onClose } = props;
    const [page, setPage] = useState<Page>('main');
    return (
        <>
            {/* On a phone the sheet covers the page; a tap beside it closes it. */}
            <button
                type="button"
                aria-label="Close player settings"
                tabIndex={-1}
                onClick={onClose}
                className="fixed inset-0 z-[60] cursor-default bg-black/50 sm:hidden"
            />
            <div
                role="dialog"
                aria-label="Player settings"
                className={cn(
                    'z-[61] flex flex-col overflow-hidden border border-white/10 bg-neutral-900/95 text-white shadow-2xl backdrop-blur-xl',
                    'fixed inset-x-2 bottom-2 max-h-[75dvh] rounded-2xl',
                    'sm:absolute sm:inset-x-auto sm:bottom-[4.5rem] sm:right-3 sm:w-72 sm:max-h-[calc(100%-5.5rem)] sm:rounded-xl',
                )}
            >
                <div className="flex h-11 shrink-0 items-center gap-1 border-b border-white/10 px-2">
                    {page === 'main' ? (
                        <p className="px-2 text-sm font-semibold">Settings</p>
                    ) : (
                        <button
                            type="button"
                            onClick={() => setPage('main')}
                            className="flex h-8 items-center gap-1 rounded-lg pl-1 pr-2 text-sm font-semibold hover:bg-white/10"
                        >
                            <ChevronLeft aria-hidden="true" className="h-4 w-4 text-neutral-400" />
                            <span>{PAGE_TITLES[page]}</span>
                            <span className="sr-only">, back to all settings</span>
                        </button>
                    )}
                </div>
                <div className="min-h-0 overflow-y-auto overscroll-contain p-1.5">
                    {page === 'main' && <MainPage {...props} onOpen={setPage} />}
                    {page === 'quality' && <QualityPage {...props} />}
                    {page === 'audio' && <AudioPage {...props} />}
                    {page === 'sound' && <SoundPage {...props} />}
                    {page === 'picture' && <PicturePage {...props} />}
                    {page === 'sync' && <SyncPage {...props} />}
                </div>
            </div>
        </>
    );
}

function MainPage(props: PlayerSettingsMenuProps & { onOpen: (page: Page) => void }) {
    const { onOpen, qualities, currentQuality, autoHeight, qualityMode, audioTracks, currentAudioTrack } = props;
    const current = qualities.find((q) => q.index === currentQuality);
    const qualityValue = currentQuality === -1
        ? `Auto${autoHeight ? ` · ${autoHeight}p` : ''}`
        : current ? `${current.height}p` : 'Auto';
    const sound = [
        props.normalizationActive && 'Normalized',
        props.nightModeActive && 'Night',
        props.monoAudio && 'Mono',
    ].filter(Boolean).join(', ') || 'Standard';
    const picture = [
        props.enhancementMode !== 'off' && ENHANCEMENT_LABELS[props.enhancementMode],
        props.framegenMode !== 'off' && `${props.framegenMode} fps`,
    ].filter(Boolean).join(' · ') || 'Off';
    const track = audioTracks.find((t) => t.index === currentAudioTrack);

    return (
        <ul>
            {(qualities.length > 0 || qualityMode) && (
                <MenuRow icon={<Film />} label="Quality" value={qualityValue} onClick={() => onOpen('quality')} />
            )}
            {props.onAudioTrackChange && audioTracks.length > 1 && (
                <MenuRow icon={<Languages />} label="Audio track" value={track ? trackLabel(track) : '—'} onClick={() => onOpen('audio')} />
            )}
            {(props.onToggleNormalization || props.onToggleNightMode || props.onToggleMono) && (
                <MenuRow icon={<AudioLines />} label="Sound" value={sound} onClick={() => onOpen('sound')} />
            )}
            {(props.onEnhancementModeChange || props.onFramegenModeChange) && (
                <MenuRow icon={<Sparkles />} label="Picture" value={picture} beta onClick={() => onOpen('picture')} />
            )}
            {props.onSyncThresholdChange && props.syncThreshold !== undefined && (
                <MenuRow icon={<Timer />} label="Sync" value={`${props.syncThreshold} s`} onClick={() => onOpen('sync')} />
            )}
        </ul>
    );
}

function MenuRow({ icon, label, value, beta, onClick }: {
    icon: ReactNode; label: string; value: string; beta?: boolean; onClick: () => void;
}) {
    return (
        <li>
            <button
                type="button"
                onClick={onClick}
                className="flex h-10 w-full items-center gap-3 rounded-lg px-2.5 text-left hover:bg-white/10 [&_svg]:h-4 [&_svg]:w-4"
            >
                <span aria-hidden="true" className="text-neutral-400">{icon}</span>
                <span className="text-sm">{label}</span>
                {beta && <BetaBadge />}
                <span className="ml-auto min-w-0 truncate text-xs text-neutral-400">{value}</span>
                <ChevronRight aria-hidden="true" className="shrink-0 text-neutral-500" />
            </button>
        </li>
    );
}

function BetaBadge() {
    return <span className="rounded bg-white/10 px-1.5 text-2xs font-medium text-neutral-300">Beta</span>;
}

/** One choice in a list: a check marks the selected one. */
function OptionButton({ selected, onClick, children, meta, testId }: {
    selected: boolean; onClick: () => void; children: ReactNode; meta?: ReactNode; testId?: string;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={selected}
            className={cn(
                'flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm hover:bg-white/10',
                selected ? 'text-white' : 'text-neutral-300',
            )}
        >
            <span aria-hidden="true" className="flex w-4 shrink-0 justify-center">
                {selected && <Check className="h-4 w-4 text-[color:var(--accent-primary)]" />}
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
            {meta !== undefined && <span data-testid={testId} className="ui-numeric shrink-0 text-xs text-neutral-500">{meta}</span>}
        </button>
    );
}

const SELECT_CLASS =
    'h-8 w-full rounded-lg border border-white/10 bg-neutral-800 px-2 text-sm text-white focus-visible:outline-2 focus-visible:outline-[color:var(--accent-primary)]';

/** Help and status text under a control, inside the menu. */
function Help({ children }: { children: ReactNode }) {
    return <p className="mt-1.5 text-xs leading-relaxed text-neutral-400">{children}</p>;
}

function Status({ label, children }: { label: string; children: ReactNode }) {
    return <p role="status" aria-label={label} className="mt-1.5 text-xs leading-relaxed text-neutral-200">{children}</p>;
}

function Section({ children }: { children: ReactNode }) {
    return <div className="border-t border-white/10 px-2.5 pt-1 first:border-t-0">{children}</div>;
}

function QualityPage({ qualities, currentQuality, onQualityChange, autoHeight, qualityMode, onQualityModeChange }: PlayerSettingsMenuProps) {
    const modeId = useId();
    return (
        <>
            {/* A source with no ladder (a member's screen, a single-rendition
                stream) offers nothing to choose between. */}
            {qualities.length > 0 && (
                <div className="pb-1.5">
                    <OptionButton
                        selected={currentQuality === -1}
                        onClick={() => onQualityChange(-1)}
                        meta={currentQuality === -1 && autoHeight ? `${autoHeight}p` : undefined}
                        testId="auto-rung"
                    >
                        Auto
                    </OptionButton>
                    {qualities.map((q) => (
                        <OptionButton
                            key={q.index}
                            selected={currentQuality === q.index}
                            onClick={() => onQualityChange(q.index)}
                            meta={`${(q.bitrate / 1000).toFixed(0)}k`}
                        >
                            <span>{q.height ? `${q.height}p` : `Level ${q.index}`}</span>
                            {q.vcodec && <span className="rounded bg-white/10 px-1.5 text-2xs font-medium text-neutral-400"> {codecLabel(q.vcodec)}</span>}
                        </OptionButton>
                    ))}
                </div>
            )}
            {onQualityModeChange && qualityMode && (
                <Section>
                    <SettingRow
                        title="Auto aims for"
                        htmlFor={modeId}
                        className="py-2"
                    >
                        <select
                            id={modeId}
                            aria-label="Auto quality"
                            value={qualityMode}
                            onChange={(event) => onQualityModeChange(parseQualityMode(event.target.value))}
                            className={SELECT_CLASS}
                        >
                            {(Object.keys(QUALITY_MODE_LABELS) as QualityMode[]).map((mode) => (
                                <option key={mode} value={mode}>{QUALITY_MODE_LABELS[mode]}</option>
                            ))}
                        </select>
                        <Help>{QUALITY_MODE_HELP[qualityMode]} Applies to this browser only.</Help>
                    </SettingRow>
                </Section>
            )}
        </>
    );
}

function AudioPage({ audioTracks, currentAudioTrack, onAudioTrackChange }: PlayerSettingsMenuProps) {
    if (!onAudioTrackChange) return null;
    return (
        <>
            <div role="group" aria-label="Audio track">
                {audioTracks.map((track) => (
                    <OptionButton
                        key={track.index}
                        selected={track.index === currentAudioTrack}
                        onClick={() => onAudioTrackChange(track.index)}
                    >
                        {trackLabel(track)}
                    </OptionButton>
                ))}
            </div>
            <div className="px-2.5 pb-1.5"><Help>Your choice applies to this video only.</Help></div>
        </>
    );
}

function SoundPage(props: PlayerSettingsMenuProps) {
    const { normalizationActive, onToggleNormalization, normalizationStatus, nightModeActive, onToggleNightMode,
        nightModeGain, onNightModeGainChange, monoAudio, onToggleMono } = props;
    return (
        <div className="divide-y divide-white/10 px-2.5">
            {onToggleNormalization && (
                <SettingRow
                    className="py-3"
                    title="Normalize volume"
                    description="Evens out loudness between videos, gradually. Runs on your device."
                    control={<Switch checked={Boolean(normalizationActive)} onChange={onToggleNormalization} label="Normalize volume" />}
                >
                    {normalizationActive && normalizationStatus && <Status label="Volume normalization status">{normalizationStatus}</Status>}
                </SettingRow>
            )}
            {onToggleNightMode && (
                <SettingRow
                    className="py-3"
                    title="Night mode"
                    description="Quiet dialogue gets louder and loud action quieter."
                    control={<Switch checked={Boolean(nightModeActive)} onChange={onToggleNightMode} label="Night mode" />}
                >
                    {nightModeActive && onNightModeGainChange && typeof nightModeGain === 'number' && (
                        <div className="flex items-center gap-3">
                            <span className="text-xs text-neutral-400">Boost</span>
                            <input
                                type="range"
                                min="0.5"
                                max="3.0"
                                step="0.1"
                                aria-label="Night mode gain"
                                value={nightModeGain}
                                onChange={(event) => onNightModeGainChange(parseFloat(event.target.value))}
                                className="h-1 flex-1 cursor-pointer accent-[color:var(--accent-primary)]"
                            />
                            <span className="ui-numeric w-14 text-right text-xs text-neutral-400">
                                {(20 * Math.log10(nightModeGain)).toFixed(1)} dB
                            </span>
                        </div>
                    )}
                </SettingRow>
            )}
            {onToggleMono && (
                <SettingRow
                    className="py-3"
                    title="Mono audio"
                    description="Both speakers play the same mix, so nothing is lost on one side."
                    control={<Switch checked={Boolean(monoAudio)} onChange={onToggleMono} label="Mono audio" />}
                />
            )}
        </div>
    );
}

function PicturePage({ enhancementMode, onEnhancementModeChange, enhancementStatus, framegenMode, onFramegenModeChange, framegenStatus }: PlayerSettingsMenuProps) {
    const enhancementId = useId();
    const framegenId = useId();
    return (
        <div className="divide-y divide-white/10 px-2.5">
            {onEnhancementModeChange && (
                <SettingRow className="py-3" title={<>Video enhancement <BetaBadge /></>} htmlFor={enhancementId}>
                    <select
                        id={enhancementId}
                        aria-label="Video enhancement (beta)"
                        value={enhancementMode}
                        onChange={(event) => onEnhancementModeChange(parseUpscaleMode(event.target.value))}
                        className={SELECT_CLASS}
                    >
                        <option value="off">Off</option>
                        <option value="auto">Auto: detect the content</option>
                        <option value="animation">Animation</option>
                        <option value="general">Live action</option>
                    </select>
                    <Help>Sharpens the picture on your device only. May use more battery.</Help>
                    {enhancementMode !== 'off' && <Status label="Video enhancement status">{enhancementStatus}</Status>}
                </SettingRow>
            )}
            {onFramegenModeChange && (
                <SettingRow className="py-3" title={<>Motion smoothing <BetaBadge /></>} htmlFor={framegenId}>
                    <select
                        id={framegenId}
                        aria-label="Motion smoothing (beta)"
                        value={framegenMode}
                        onChange={(event) => onFramegenModeChange(parseFramegenMode(event.target.value))}
                        className={SELECT_CLASS}
                    >
                        <option value="off">Off</option>
                        <option value="30">30 fps</option>
                        <option value="60">60 fps</option>
                    </select>
                    <Help>Adds in-between frames with a local AI model, for personal, non-commercial use. Delays picture and sound by 120 ms and pauses video enhancement.</Help>
                    {framegenMode !== 'off' && <Status label="Motion smoothing status">{framegenStatus}</Status>}
                </SettingRow>
            )}
        </div>
    );
}

function SyncPage({ syncThreshold, onSyncThresholdChange }: PlayerSettingsMenuProps) {
    if (!onSyncThresholdChange || syncThreshold === undefined) return null;
    return (
        <div className="px-2.5 py-3">
            <div className="flex items-center gap-3">
                <input
                    type="range"
                    min="1"
                    max="10"
                    step="0.5"
                    aria-label="Sync threshold in seconds"
                    value={syncThreshold}
                    onChange={(event) => onSyncThresholdChange(parseFloat(event.target.value))}
                    className="h-1 flex-1 cursor-pointer accent-[color:var(--accent-primary)]"
                />
                <span className="ui-numeric w-10 text-right text-sm">{syncThreshold} s</span>
            </div>
            <Help>How far you may drift from the room before you are moved back to it. Lower keeps everyone closer; higher jumps less often.</Help>
        </div>
    );
}
