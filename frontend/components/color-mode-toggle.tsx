'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import {
    COLOR_MODES,
    DARK_SCHEME_QUERY,
    applyColorMode,
    getServerColorMode,
    readStoredColorMode,
    storeColorMode,
    subscribeColorMode,
    type ColorMode,
} from '@/lib/color-mode';

const MODE_ICONS = { system: Monitor, light: Sun, dark: Moon } as const;
const MODE_LABELS: Record<ColorMode, string> = {
    system: 'Match system appearance',
    light: 'Light appearance',
    dark: 'Dark appearance',
};
const MODE_SHORT_LABELS: Record<ColorMode, string> = {
    system: 'System',
    light: 'Light',
    dark: 'Dark',
};

/**
 * Keeps the `data-theme` attribute in sync with the stored preference and, when
 * the preference is "system", with the OS setting.
 */
export function useColorMode() {
    const mode = useSyncExternalStore(
        subscribeColorMode,
        readStoredColorMode,
        getServerColorMode
    );

    useEffect(() => {
        applyColorMode(mode);
    }, [mode]);

    useEffect(() => {
        if (mode !== 'system' || typeof window === 'undefined' || !window.matchMedia) return;
        const query = window.matchMedia(DARK_SCHEME_QUERY);
        const onChange = () => applyColorMode('system');
        query.addEventListener('change', onChange);
        return () => query.removeEventListener('change', onChange);
    }, [mode]);

    const selectMode = useCallback((next: ColorMode) => {
        storeColorMode(next);
        applyColorMode(next);
    }, []);

    return { mode, selectMode };
}

/** Layout-only base classes; callers supply size and colour so the toggle can
 *  blend into whichever bar it sits in. */
const ICON_BUTTON_BASE = 'inline-flex items-center justify-center rounded-lg';
const ICON_BUTTON_DEFAULT =
    'h-9 w-9 border border-white/10 text-neutral-400 hover:bg-white/5 hover:text-white';

interface ColorModeToggleProps {
    /** `icon` cycles through the modes, `segmented` shows all three options. */
    variant?: 'icon' | 'segmented';
    className?: string;
}

export function ColorModeToggle({ variant = 'icon', className }: ColorModeToggleProps) {
    const { mode, selectMode } = useColorMode();

    if (variant === 'segmented') {
        return (
            <div
                role="radiogroup"
                aria-label="Appearance"
                className={`flex gap-1 rounded-xl border border-white/5 bg-white/5 p-1 ${className ?? ''}`}
            >
                {COLOR_MODES.map((option) => {
                    const Icon = MODE_ICONS[option];
                    const selected = mode === option;
                    return (
                        <button
                            key={option}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            onClick={() => selectMode(option)}
                            className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium ${selected
                                ? 'bg-white/10 text-white'
                                : 'text-zinc-500 hover:bg-white/5 hover:text-zinc-300'
                                }`}
                        >
                            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                            {MODE_SHORT_LABELS[option]}
                        </button>
                    );
                })}
            </div>
        );
    }

    const nextMode = COLOR_MODES[(COLOR_MODES.indexOf(mode) + 1) % COLOR_MODES.length];
    const Icon = MODE_ICONS[mode];

    return (
        <button
            type="button"
            onClick={() => selectMode(nextMode)}
            title={MODE_LABELS[mode]}
            aria-label={`${MODE_LABELS[mode]}. Switch to: ${MODE_LABELS[nextMode]}`}
            className={`${ICON_BUTTON_BASE} ${className ?? ICON_BUTTON_DEFAULT}`}
        >
            <Icon className="h-4 w-4" aria-hidden="true" />
        </button>
    );
}
