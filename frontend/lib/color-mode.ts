/**
 * Light / dark colour scheme handling.
 *
 * The scheme is expressed as a `data-theme` attribute on `<html>` and consumed
 * by the token overrides in `app/globals.css`. The stored preference is applied
 * by a blocking inline script in the root layout so there is no flash of the
 * wrong scheme before hydration; this module keeps the client in sync
 * afterwards.
 */

export const COLOR_MODES = ['system', 'light', 'dark'] as const;

export type ColorMode = (typeof COLOR_MODES)[number];

/** Resolved scheme actually painted on screen. */
export type ResolvedColorMode = 'light' | 'dark';

export const COLOR_MODE_STORAGE_KEY = 'wt_color_mode';
export const COLOR_MODE_ATTRIBUTE = 'data-theme';
export const DEFAULT_COLOR_MODE: ColorMode = 'system';
export const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';

export function isColorMode(value: unknown): value is ColorMode {
    return typeof value === 'string' && (COLOR_MODES as readonly string[]).includes(value);
}

export function prefersDark(): boolean {
    if (typeof window === 'undefined' || !window.matchMedia) return true;
    return window.matchMedia(DARK_SCHEME_QUERY).matches;
}

export function resolveColorMode(mode: ColorMode): ResolvedColorMode {
    if (mode === 'system') return prefersDark() ? 'dark' : 'light';
    return mode;
}

export function readStoredColorMode(): ColorMode {
    if (typeof window === 'undefined') return DEFAULT_COLOR_MODE;
    try {
        const stored = window.localStorage.getItem(COLOR_MODE_STORAGE_KEY);
        return isColorMode(stored) ? stored : DEFAULT_COLOR_MODE;
    } catch (error) {
        console.warn('[color-mode] Could not read the stored preference:', error);
        return DEFAULT_COLOR_MODE;
    }
}

export function applyColorMode(mode: ColorMode): ResolvedColorMode {
    const resolved = resolveColorMode(mode);
    if (typeof document !== 'undefined') {
        document.documentElement.setAttribute(COLOR_MODE_ATTRIBUTE, resolved);
    }
    return resolved;
}

/**
 * Minimal store so components can read the preference with
 * `useSyncExternalStore` instead of mirroring it into component state.
 */
const listeners = new Set<() => void>();

export function subscribeColorMode(listener: () => void): () => void {
    listeners.add(listener);
    const onStorage = (event: StorageEvent) => {
        if (event.key === COLOR_MODE_STORAGE_KEY) listener();
    };
    window.addEventListener('storage', onStorage);
    return () => {
        listeners.delete(listener);
        window.removeEventListener('storage', onStorage);
    };
}

export function storeColorMode(mode: ColorMode): void {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(COLOR_MODE_STORAGE_KEY, mode);
    } catch (error) {
        console.warn('[color-mode] Could not persist the preference:', error);
    }
    listeners.forEach((listener) => listener());
}

export function getServerColorMode(): ColorMode {
    return DEFAULT_COLOR_MODE;
}

/**
 * Runs before first paint, so it is inlined as a string rather than imported.
 * Kept deliberately tiny and failure-tolerant: a throw here would block render.
 */
export const COLOR_MODE_BOOTSTRAP_SCRIPT = `(function(){try{
var m=localStorage.getItem('${COLOR_MODE_STORAGE_KEY}');
if(m!=='light'&&m!=='dark'){m=window.matchMedia('${DARK_SCHEME_QUERY}').matches?'dark':'light';}
document.documentElement.setAttribute('${COLOR_MODE_ATTRIBUTE}',m);
}catch(e){document.documentElement.setAttribute('${COLOR_MODE_ATTRIBUTE}','dark');}})();`;
