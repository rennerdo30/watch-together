'use client';

import { useCallback, useEffect, useMemo } from 'react';
import {
    CUSTOM_THEME_ID, CUSTOM_THEME_STORAGE_KEY, DEFAULT_THEME, THEME_STORAGE_KEY,
    applyAccentTheme, getThemeById, isTheme, type Theme,
} from '@/lib/themes';
import { parseStoredString, useLocalStorageState } from './useLocalStorageState';

/**
 * The persisted accent theme, applied to the document whenever it changes —
 * here and in other tabs (the storage event updates the stored value).
 */
export function useStoredTheme() {
    const [themeId, setThemeId] = useLocalStorageState(THEME_STORAGE_KEY, DEFAULT_THEME.id, parseStoredString);
    const [customTheme, setCustomTheme] = useLocalStorageState(CUSTOM_THEME_STORAGE_KEY, '', parseStoredString);
    const activeTheme = useMemo(() => {
        if (themeId !== CUSTOM_THEME_ID) return getThemeById(themeId) ?? DEFAULT_THEME;
        try {
            const theme: unknown = JSON.parse(customTheme);
            return isTheme(theme) ? theme : DEFAULT_THEME;
        } catch {
            return DEFAULT_THEME;
        }
    }, [themeId, customTheme]);
    useEffect(() => applyAccentTheme(activeTheme), [activeTheme]);
    const setActiveTheme = useCallback((theme: Theme) => {
        if (theme.id === CUSTOM_THEME_ID) setCustomTheme(JSON.stringify(theme));
        setThemeId(theme.id);
    }, [setCustomTheme, setThemeId]);
    return { activeTheme, setActiveTheme };
}
