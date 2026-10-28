'use client';

import { useEffect, useId, useState, type CSSProperties, type ReactNode } from 'react';
import { Check, Copy, Download, ExternalLink, Home, Lock, Palette, UserRound, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { ColorModeToggle } from '@/components/color-mode-toggle';
import { SETTINGS_BUTTON, SETTINGS_PRIMARY_BUTTON, SettingRow, SettingsGroup, Switch } from '@/components/settings-ui';
import {
    extensionDownloadUrl, getExtensionToken, regenerateExtensionToken,
    type CookieStatus, type ExtensionToken, type UserSettings,
} from '@/lib/api';
import {
    COOKIE_MEMORY_TTL_MINUTES, COPY_FEEDBACK_DURATION_MS, EXTENSION_SOURCE_URL, EXTENSION_STORE_URL,
    FONT_SIZE_MAX, FONT_SIZE_MIN,
} from '@/lib/constants';
import { SPONSORBLOCK_CATEGORIES, SPONSOR_CATEGORY_LABELS, type SponsorBlockSettings } from '@/lib/sponsorblock';
import { CUSTOM_THEME_ID, THEMES, createCustomTheme, type Theme } from '@/lib/themes';
import { cn, getErrorMessage } from '@/lib/utils';

export type RoomSettingsSection = 'room' | 'appearance' | 'account';
type SectionId = RoomSettingsSection;

const SECTIONS: { id: SectionId; label: string; icon: typeof Home; adminOnly?: boolean }[] = [
    { id: 'room', label: 'Room', icon: Home, adminOnly: true },
    { id: 'appearance', label: 'Appearance', icon: Palette },
    { id: 'account', label: 'Account', icon: UserRound },
];

export interface RoomSettingsDialogProps {
    onClose: () => void;
    /** Open on this section instead of the viewer's default. */
    initialSection?: RoomSettingsSection;
    isAdmin: boolean;
    /** Whether the viewer has an identity (a guest has no account settings). */
    signedIn: boolean;
    roomId: string;
    roomName: string;
    onRename: (name: string) => void;
    isPermanent: boolean;
    onTogglePermanent: () => void;
    sponsorBlock: SponsorBlockSettings;
    onSponsorBlockChange: (settings: SponsorBlockSettings) => void;
    activeTheme: Theme;
    onThemeChange: (theme: Theme) => void;
    fontSize: number;
    onFontSizeChange: (size: number) => void;
    useProxy: boolean;
    onProxyChange: (enabled: boolean) => void;
    isLoadingCookies: boolean;
    hasSavedCookies: boolean;
    cookieStatus: CookieStatus | null;
    onForgetCookies: () => Promise<void>;
    userSettings: UserSettings | null;
    onUserSettingsChange: (patch: Partial<UserSettings>) => Promise<void>;
}

/**
 * Room settings: one section at a time, chosen from a list on the left (a row
 * of tabs on a phone). A room admin opens on the room's own settings; anyone
 * else on appearance.
 */
export function RoomSettingsDialog(props: RoomSettingsDialogProps) {
    const { onClose, isAdmin, initialSection } = props;
    const sections = SECTIONS.filter((section) => isAdmin || !section.adminOnly);
    const [section, setSection] = useState<SectionId>(initialSection ?? sections[0].id);
    const titleId = useId();
    const current = sections.find((s) => s.id === section) ?? sections[0];

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-3 sm:p-6">
            <button
                type="button"
                aria-label="Close settings"
                tabIndex={-1}
                className="absolute inset-0 cursor-default bg-black/70 backdrop-blur-sm"
                onClick={onClose}
            />
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                className="relative flex h-[min(40rem,92dvh)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[color:var(--bg-elevated)] shadow-2xl sm:flex-row"
            >
                <nav aria-label="Settings sections" className="flex shrink-0 gap-1 overflow-x-auto border-b border-white/10 p-2 sm:w-52 sm:flex-col sm:border-b-0 sm:border-r sm:p-3">
                    <h2 id={titleId} className="ui-heading hidden px-2.5 pb-3 pt-1 sm:block">Settings</h2>
                    {sections.map(({ id, label, icon: Icon }) => (
                        <button
                            key={id}
                            type="button"
                            aria-current={id === current.id ? 'page' : undefined}
                            onClick={() => setSection(id)}
                            className={cn(
                                'flex h-9 shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium transition-colors',
                                id === current.id
                                    ? 'bg-white/10 text-white'
                                    : 'text-neutral-400 hover:bg-white/5 hover:text-neutral-100',
                            )}
                        >
                            <Icon aria-hidden="true" className="h-4 w-4" />
                            {label}
                        </button>
                    ))}
                </nav>
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-white/10 px-5">
                        <p className="ui-heading">{current.label}</p>
                        <button
                            type="button"
                            onClick={onClose}
                            aria-label="Close settings"
                            className="-mr-1.5 flex h-8 w-8 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-white/5 hover:text-white"
                        >
                            <X aria-hidden="true" className="h-4 w-4" />
                        </button>
                    </header>
                    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
                        {current.id === 'room' && <RoomSection {...props} />}
                        {current.id === 'appearance' && <AppearanceSection {...props} />}
                        {current.id === 'account' && <AccountSection {...props} />}
                    </div>
                </div>
            </div>
        </div>
    );
}

function RoomSection({ roomId, roomName, onRename, isPermanent, onTogglePermanent, sponsorBlock, onSponsorBlockChange }: RoomSettingsDialogProps) {
    const nameId = useId();
    return (
        <>
            <SettingsGroup title="General">
                <SettingRow title="Room name" htmlFor={nameId} description={`Shown instead of the room id. The link stays /room/${roomId}.`}>
                    <form
                        className="flex gap-2"
                        onSubmit={(event) => {
                            event.preventDefault();
                            onRename(String(new FormData(event.currentTarget).get('roomName') ?? '').trim());
                        }}
                    >
                        <input
                            id={nameId}
                            name="roomName"
                            key={roomName}
                            defaultValue={roomName}
                            maxLength={60}
                            placeholder={roomId}
                            className="h-8 min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-3 text-sm text-white placeholder:text-neutral-500 focus:outline-none"
                        />
                        <button type="submit" className={SETTINGS_PRIMARY_BUTTON}>Save</button>
                    </form>
                </SettingRow>
                <SettingRow
                    title="Keep this room"
                    description="The room stays when everyone has left, instead of closing after five minutes."
                    control={<Switch checked={isPermanent} onChange={onTogglePermanent} label="Keep this room" />}
                />
            </SettingsGroup>
            <SettingsGroup title="SponsorBlock">
                <SettingRow
                    testId="sponsorblock-settings"
                    title="Skip SponsorBlock segments"
                    description="Segments the community marked in YouTube videos are skipped for everyone in the room."
                    control={(
                        <Switch
                            checked={sponsorBlock.enabled}
                            onChange={(enabled) => onSponsorBlockChange({ ...sponsorBlock, enabled })}
                            label="Skip SponsorBlock segments"
                        />
                    )}
                >
                    <fieldset disabled={!sponsorBlock.enabled} className="disabled:opacity-50">
                        <legend className="sr-only">Segments to skip</legend>
                        <div className="flex flex-wrap gap-1.5">
                            {SPONSORBLOCK_CATEGORIES.map((category) => {
                                const checked = sponsorBlock.categories.includes(category);
                                return (
                                    <label
                                        key={category}
                                        className={cn(
                                            'relative inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors has-[:disabled]:cursor-not-allowed has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[color:var(--accent-primary)]',
                                            checked
                                                ? 'border-[color:var(--accent-primary)]/50 bg-[color:var(--accent-glow)] text-white'
                                                : 'border-white/10 text-neutral-400 hover:text-neutral-100',
                                        )}
                                    >
                                        <input
                                            type="checkbox"
                                            className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-not-allowed"
                                            checked={checked}
                                            onChange={() => onSponsorBlockChange({
                                                ...sponsorBlock,
                                                categories: checked
                                                    ? sponsorBlock.categories.filter((c) => c !== category)
                                                    : [...sponsorBlock.categories, category],
                                            })}
                                        />
                                        {checked && <Check aria-hidden="true" className="h-3 w-3" />}
                                        {SPONSOR_CATEGORY_LABELS[category]}
                                    </label>
                                );
                            })}
                        </div>
                    </fieldset>
                </SettingRow>
            </SettingsGroup>
        </>
    );
}

function AppearanceSection({ activeTheme, onThemeChange, fontSize, onFontSizeChange }: RoomSettingsDialogProps) {
    const sizeId = useId();
    const customId = useId();
    const isCustom = activeTheme.id === CUSTOM_THEME_ID;
    return (
        <SettingsGroup>
            <SettingRow title="Color mode" control={<ColorModeToggle variant="segmented" />} />
            <SettingRow title="Accent color" description="Buttons, links, the progress bar and selections.">
                <div role="radiogroup" aria-label="Accent color" className="flex flex-wrap items-center gap-2.5">
                    {THEMES.map((theme) => (
                        <SwatchButton
                            key={theme.id}
                            theme={theme}
                            selected={activeTheme.id === theme.id}
                            onSelect={() => onThemeChange(theme)}
                        />
                    ))}
                    {/* The last swatch is a color picker; a picked color applies at once. */}
                    <label
                        htmlFor={customId}
                        title="Custom color"
                        className={cn(
                            'relative flex h-8 w-8 cursor-pointer items-center justify-center rounded-full ring-offset-2 ring-offset-[color:var(--bg-elevated)] [background:conic-gradient(#f06262,#f0c04b,#2fc4b2,#8b8ff0,#f06262)]',
                            isCustom && 'ring-2 ring-white',
                        )}
                    >
                        <span className="sr-only">Custom color</span>
                        <input
                            id={customId}
                            type="color"
                            role="radio"
                            aria-checked={isCustom}
                            aria-label="Custom color"
                            value={isCustom ? activeTheme.dark.accent : THEMES[0].dark.accent}
                            onChange={(event) => onThemeChange(createCustomTheme(event.target.value))}
                            className="absolute inset-0 cursor-pointer opacity-0"
                        />
                        {isCustom && <span className="theme-swatch h-4 w-4 rounded-full" style={swatchStyle(activeTheme)} />}
                    </label>
                </div>
            </SettingRow>
            <SettingRow
                title="Text size"
                htmlFor={sizeId}
                description="Chat, queue and member names."
                control={(
                    <>
                        <input
                            id={sizeId}
                            type="range"
                            min={FONT_SIZE_MIN}
                            max={FONT_SIZE_MAX}
                            value={fontSize}
                            onChange={(event) => onFontSizeChange(Number(event.target.value))}
                            className="w-32 cursor-pointer accent-[color:var(--accent-primary)]"
                        />
                        <span className="ui-meta ui-numeric w-10 text-right">{fontSize} px</span>
                    </>
                )}
            />
        </SettingsGroup>
    );
}

function swatchStyle(theme: Theme) {
    return { '--swatch-dark': theme.dark.accent, '--swatch-light': theme.light.accent } as CSSProperties;
}

function SwatchButton({ theme, selected, onSelect }: { theme: Theme; selected: boolean; onSelect: () => void }) {
    return (
        <button
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={theme.name}
            title={theme.name}
            onClick={onSelect}
            data-theme-swatch={theme.id}
            style={swatchStyle(theme)}
            className={cn(
                'theme-swatch flex h-8 w-8 items-center justify-center rounded-full ring-offset-2 ring-offset-[color:var(--bg-elevated)] transition-shadow',
                selected ? 'ring-2 ring-white' : 'hover:ring-2 hover:ring-white/30',
            )}
        />
    );
}

function AccountSection({
    signedIn, isLoadingCookies, hasSavedCookies, cookieStatus, onForgetCookies,
    userSettings, onUserSettingsChange, useProxy, onProxyChange,
}: RoomSettingsDialogProps) {
    const [isForgetting, setIsForgetting] = useState(false);
    const time = (seconds: number) => new Date(seconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const cookieText = isLoadingCookies
        ? 'Checking…'
        : hasSavedCookies
            ? `In memory${cookieStatus?.synced_at ? `, synced ${time(cookieStatus.synced_at)}` : ''}${cookieStatus?.expires_at ? `, kept until ${time(cookieStatus.expires_at)}` : ''}`
            : 'No cookies on the server';
    return (
        <>
            <SettingsGroup title="Signed-in session">
                <SettingRow
                    testId="cookie-status"
                    title={<span className="flex items-center gap-1.5"><Lock aria-hidden="true" className="h-3.5 w-3.5 text-neutral-400" />{cookieText}</span>}
                    description={`With the browser extension connected, the room can play age-restricted and bot-checked videos with your session. Your cookies stay in the server's memory and are dropped ${COOKIE_MEMORY_TTL_MINUTES} minutes after the last sync. While you're in a room, YouTube, Twitch and Kick links other members paste can use your session.`}
                    control={hasSavedCookies && (
                        <button
                            type="button"
                            disabled={isForgetting}
                            onClick={async () => {
                                setIsForgetting(true);
                                try { await onForgetCookies(); } finally { setIsForgetting(false); }
                            }}
                            className={SETTINGS_BUTTON}
                        >
                            {isForgetting ? 'Forgetting…' : 'Forget now'}
                        </button>
                    )}
                />
                {signedIn && (
                    <SettingRow
                        testId="youtube-history-setting"
                        title="Update my YouTube watch history"
                        description={hasSavedCookies
                            ? 'Videos the room watches appear in your YouTube history and remember where you stopped.'
                            : 'Connect the browser extension first; this uses your session.'}
                        control={(
                            <Switch
                                checked={Boolean(userSettings?.youtube_history)}
                                disabled={!hasSavedCookies || userSettings === null}
                                onChange={(youtube_history) => onUserSettingsChange({ youtube_history })}
                                label="Update my YouTube watch history"
                            />
                        )}
                    />
                )}
            </SettingsGroup>
            <ExtensionGroup signedIn={signedIn} />
            <SettingsGroup title="Network">
                <SettingRow
                    title="Proxy mode"
                    description="Streams load through this server, which most sites need. Off fetches them straight from the source."
                    control={<Switch checked={useProxy} onChange={onProxyChange} label="Proxy mode" />}
                />
            </SettingsGroup>
        </>
    );
}

function ExtensionGroup({ signedIn }: { signedIn: boolean }) {
    const [token, setToken] = useState<ExtensionToken | null>(null);
    const [isLoading, setIsLoading] = useState(signedIn);
    const [isRegenerating, setIsRegenerating] = useState(false);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (!signedIn) return;
        let cancelled = false;
        getExtensionToken()
            .then((response) => { if (!cancelled) setToken(response.token); })
            .catch((err) => console.error('[Settings] Could not load the extension token:', err))
            .finally(() => { if (!cancelled) setIsLoading(false); });
        return () => { cancelled = true; };
    }, [signedIn]);

    return (
        <SettingsGroup title="Browser extension">
            <SettingRow
                title="Install"
                description="It syncs your cookies from YouTube, Twitch, Kick and other sites every few minutes while your browser is open. Connect this site from the extension's popup."
            >
                <div className="flex flex-wrap gap-2">
                    <ExtensionLink href={EXTENSION_STORE_URL} external primary icon={<ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />}>
                        Chrome Web Store
                    </ExtensionLink>
                    <ExtensionLink href={extensionDownloadUrl('firefox')} download icon={<Download aria-hidden="true" className="h-3.5 w-3.5" />}>
                        Firefox
                    </ExtensionLink>
                    <ExtensionLink href={EXTENSION_SOURCE_URL} external icon={<ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />}>
                        Source
                    </ExtensionLink>
                </div>
            </SettingRow>
            {signedIn && (
                <SettingRow
                    title="API token"
                    description={token?.last_sync_at
                        ? `Last sync ${new Date(token.last_sync_at * 1000).toLocaleString()}${token.sync_count > 0 ? ` · ${token.sync_count} sync${token.sync_count === 1 ? '' : 's'}` : ''}`
                        : 'The extension uses it to sync to your account.'}
                >
                    <div className="flex items-center gap-2">
                        <code className="flex h-8 min-w-0 flex-1 items-center truncate rounded-lg border border-white/10 bg-white/5 px-3 font-mono text-xs text-neutral-300">
                            {isLoading ? 'Loading…' : token ? `${token.id.slice(0, 20)}…` : 'No token'}
                        </code>
                        <button
                            type="button"
                            disabled={!token}
                            title="Copy token"
                            aria-label="Copy the API token to the clipboard"
                            onClick={() => {
                                if (!token) return;
                                navigator.clipboard.writeText(token.id);
                                setCopied(true);
                                setTimeout(() => setCopied(false), COPY_FEEDBACK_DURATION_MS);
                                toast.success('Token copied');
                            }}
                            className={cn(SETTINGS_BUTTON, 'w-8 px-0')}
                        >
                            {copied ? <Check aria-hidden="true" className="h-3.5 w-3.5" /> : <Copy aria-hidden="true" className="h-3.5 w-3.5" />}
                        </button>
                        <button
                            type="button"
                            disabled={isRegenerating}
                            onClick={async () => {
                                setIsRegenerating(true);
                                try {
                                    setToken((await regenerateExtensionToken()).token);
                                    toast.success('Token regenerated. Reconnect the extension.');
                                } catch (err: unknown) {
                                    toast.error(getErrorMessage(err, 'Failed to regenerate'));
                                } finally {
                                    setIsRegenerating(false);
                                }
                            }}
                            className={SETTINGS_BUTTON}
                        >
                            {isRegenerating ? 'Regenerating…' : 'Regenerate'}
                        </button>
                    </div>
                </SettingRow>
            )}
        </SettingsGroup>
    );
}

function ExtensionLink({ href, external, download, primary, icon, children }: {
    href: string; external?: boolean; download?: boolean; primary?: boolean; icon: ReactNode; children: ReactNode;
}) {
    return (
        <a
            href={href}
            {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            {...(download ? { download: true } : {})}
            className={primary ? SETTINGS_PRIMARY_BUTTON : SETTINGS_BUTTON}
        >
            {icon}
            {children}
        </a>
    );
}
