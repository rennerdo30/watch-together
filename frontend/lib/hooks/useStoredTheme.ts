'use client';

import { useCallback, useMemo } from 'react';
import { DEFAULT_THEME, getThemeById, type Theme } from '@/lib/themes';
import { parseStoredString, useLocalStorageState } from './useLocalStorageState';

/** Read the same persisted theme during hydration and later storage changes. */
export function useStoredTheme() {
    const [themeId, setThemeId] = useLocalStorageState('wt_theme', DEFAULT_THEME.id, parseStoredString);
    const [customTheme, setCustomTheme] = useLocalStorageState('wt_custom_theme', '', parseStoredString);
    const activeTheme = useMemo(() => {
        if (themeId !== 'custom') return getThemeById(themeId) ?? DEFAULT_THEME;
        try {
            const theme = JSON.parse(customTheme) as Theme;
            return theme?.id === 'custom' && theme.colors?.bg && theme.colors?.accent ? theme : DEFAULT_THEME;
        } catch {
            return DEFAULT_THEME;
        }
    }, [themeId, customTheme]);
    const setActiveTheme = useCallback((theme: Theme) => {
        if (theme.id === 'custom') setCustomTheme(JSON.stringify(theme));
        setThemeId(theme.id);
    }, [setCustomTheme, setThemeId]);
    return { activeTheme, setActiveTheme };
}
