/**
 * useRoomSettings - Settings and theme management hook
 * 
 * Handles:
 * - Theme selection and custom themes
 * - Proxy mode toggle
 * - Font size preferences
 * - Sidebar width
 * - Cookie management
 */

import { useState, useEffect, useCallback } from 'react';
import {
    Theme,
    DEFAULT_THEME,
    getThemeById,
    loadCustomTheme,
    saveCustomTheme,
    createCustomTheme
} from '@/lib/themes';
import toast from 'react-hot-toast';

export interface UseRoomSettingsReturn {
    // Theme
    activeTheme: Theme;
    setActiveTheme: (theme: Theme) => void;
    customBgColor: string;
    setCustomBgColor: (color: string) => void;
    customAccentColor: string;
    setCustomAccentColor: (color: string) => void;
    showCustomTheme: boolean;
    setShowCustomTheme: (show: boolean) => void;
    applyCustomTheme: () => void;

    // Display
    fontSize: number;
    setFontSize: (size: number) => void;
    sidebarWidth: number;
    setSidebarWidth: (width: number) => void;

    // Proxy
    useProxy: boolean;
    setUseProxy: (use: boolean) => void;

    // Sync threshold
    syncThreshold: number;
    setSyncThreshold: (threshold: number) => void;

    // Cookies
    cookieContent: string;
    setCookieContent: (content: string) => void;
    isLoadingCookies: boolean;
    isSavingCookies: boolean;
    saveCookies: (currentUser: string) => Promise<void>;
}

export function useRoomSettings(): UseRoomSettingsReturn {
    // Theme state
    const [activeTheme, setActiveThemeState] = useState<Theme>(DEFAULT_THEME);
    const [customBgColor, setCustomBgColor] = useState('#09090b');
    const [customAccentColor, setCustomAccentColor] = useState('#8b5cf6');
    const [showCustomTheme, setShowCustomTheme] = useState(false);

    // Display state
    const [fontSize, setFontSizeState] = useState(15);
    const [sidebarWidth, setSidebarWidthState] = useState(320);

    // Proxy state
    const [useProxy, setUseProxyState] = useState(true);

    // Sync threshold
    const [syncThreshold, setSyncThresholdState] = useState(4);

    // Cookie state
    const [cookieContent, setCookieContent] = useState('');
    const [isLoadingCookies, setIsLoadingCookies] = useState(true);
    const [isSavingCookies, setIsSavingCookies] = useState(false);

    // Load saved settings on mount
    useEffect(() => {
        // Theme
        const savedTheme = localStorage.getItem('wt_theme');
        if (savedTheme) {
            if (savedTheme === 'custom') {
                const customTheme = loadCustomTheme();
                if (customTheme) {
                    setActiveThemeState(customTheme);
                    setCustomBgColor(customTheme.colors.bg);
                    setCustomAccentColor(customTheme.colors.accent);
                    setShowCustomTheme(true);
                }
            } else {
                const t = getThemeById(savedTheme);
                if (t) setActiveThemeState(t);
            }
        }

        // Proxy
        const savedProxy = localStorage.getItem('wt_proxy');
        if (savedProxy !== null) {
            setUseProxyState(savedProxy === 'true');
        }

        // Sidebar width
        const savedWidth = localStorage.getItem('wt_sidebar_width');
        if (savedWidth) {
            const width = parseInt(savedWidth);
            if (width >= 240 && width <= 600) setSidebarWidthState(width);
        }

        // Font size
        const savedFontSize = localStorage.getItem('wt_font_size');
        if (savedFontSize) {
            const size = parseInt(savedFontSize);
            if (size >= 12 && size <= 24) setFontSizeState(size);
        }

        // Sync threshold
        const savedThreshold = localStorage.getItem('w2g-sync-threshold');
        if (savedThreshold) {
            setSyncThresholdState(parseFloat(savedThreshold));
        }
    }, []);

    // Setters with persistence
    const setActiveTheme = useCallback((theme: Theme) => {
        setActiveThemeState(theme);
        localStorage.setItem('wt_theme', theme.id);
        setShowCustomTheme(false);
    }, []);

    const setFontSize = useCallback((size: number) => {
        setFontSizeState(size);
        localStorage.setItem('wt_font_size', size.toString());
    }, []);

    const setSidebarWidth = useCallback((width: number) => {
        setSidebarWidthState(width);
        localStorage.setItem('wt_sidebar_width', width.toString());
    }, []);

    const setUseProxy = useCallback((use: boolean) => {
        setUseProxyState(use);
        localStorage.setItem('wt_proxy', String(use));
    }, []);

    const setSyncThreshold = useCallback((threshold: number) => {
        setSyncThresholdState(threshold);
        localStorage.setItem('w2g-sync-threshold', threshold.toString());
    }, []);

    const applyCustomTheme = useCallback(() => {
        const custom = createCustomTheme('Custom', customBgColor, customAccentColor);
        setActiveThemeState(custom);
        saveCustomTheme(custom);
        localStorage.setItem('wt_theme', 'custom');
        toast.success('Custom theme applied!');
    }, [customBgColor, customAccentColor]);

    const saveCookies = useCallback(async (currentUser: string) => {
        if (!cookieContent.trim().includes('# Netscape')) {
            toast.error('Invalid Netscape format');
            return;
        }
        if (!currentUser || currentUser === 'Guest') {
            toast.error('You must be logged in to save cookies');
            return;
        }

        setIsSavingCookies(true);
        try {
            const searchParams = new URLSearchParams(window.location.search);
            const mockUser = searchParams.get('user');
            const userParam = mockUser ? `?user=${encodeURIComponent(mockUser)}` : '';

            const res = await fetch(`/api/cookies${userParam}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: cookieContent })
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({ detail: 'Unknown error' }));
                throw new Error(err.detail || 'Failed to save');
            }

            toast.success('Cookies saved!');
            setCookieContent('');
        } catch (err: any) {
            toast.error(err.message || 'Failed to save cookies');
        } finally {
            setIsSavingCookies(false);
        }
    }, [cookieContent]);

    return {
        activeTheme,
        setActiveTheme,
        customBgColor,
        setCustomBgColor,
        customAccentColor,
        setCustomAccentColor,
        showCustomTheme,
        setShowCustomTheme,
        applyCustomTheme,
        fontSize,
        setFontSize,
        sidebarWidth,
        setSidebarWidth,
        useProxy,
        setUseProxy,
        syncThreshold,
        setSyncThreshold,
        cookieContent,
        setCookieContent,
        isLoadingCookies,
        isSavingCookies,
        saveCookies,
    };
}
