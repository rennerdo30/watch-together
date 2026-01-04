'use client';

import React from 'react';
import { X, Palette, ListVideo, ShieldCheck, Lock, ChevronDown, Infinity } from 'lucide-react';
import { THEMES, type Theme, createCustomTheme, saveCustomTheme } from '@/lib/themes';
import toast from 'react-hot-toast';

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    // Theme
    activeTheme: Theme;
    onThemeChange: (theme: Theme) => void;
    customBgColor: string;
    setCustomBgColor: (color: string) => void;
    customAccentColor: string;
    setCustomAccentColor: (color: string) => void;
    showCustomTheme: boolean;
    setShowCustomTheme: (show: boolean) => void;
    // Display
    fontSize: number;
    setFontSize: (size: number) => void;
    // Proxy
    useProxy: boolean;
    setUseProxy: (use: boolean) => void;
    // Cookies
    cookieContent: string;
    setCookieContent: (content: string) => void;
    isLoadingCookies: boolean;
    isSavingCookies: boolean;
    onSaveCookies: () => void;
    currentUser: string;
    // Permanent room
    isPermanent: boolean;
    onTogglePermanent: () => void;
    isAdmin: boolean;
}

export function SettingsModal({
    isOpen,
    onClose,
    activeTheme,
    onThemeChange,
    customBgColor,
    setCustomBgColor,
    customAccentColor,
    setCustomAccentColor,
    showCustomTheme,
    setShowCustomTheme,
    fontSize,
    setFontSize,
    useProxy,
    setUseProxy,
    cookieContent,
    setCookieContent,
    isLoadingCookies,
    isSavingCookies,
    onSaveCookies,
    currentUser,
    isPermanent,
    onTogglePermanent,
    isAdmin,
}: SettingsModalProps) {
    if (!isOpen) return null;

    const handleApplyCustomTheme = () => {
        const custom = createCustomTheme('Custom', customBgColor, customAccentColor);
        onThemeChange(custom);
        saveCustomTheme(custom);
        localStorage.setItem('wt_theme', 'custom');
        toast.success('Custom theme applied!');
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/90 backdrop-blur-sm" onClick={onClose} />
            <div className="relative w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden shadow-2xl max-h-[90vh] flex flex-col">
                <div className="p-5 border-b border-zinc-800 flex items-center justify-between shrink-0">
                    <h2 className="text-base font-semibold text-white">Settings</h2>
                    <button onClick={onClose} className="text-zinc-500 hover:text-white transition-colors p-1 rounded-lg hover:bg-white/5">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <div className="p-5 space-y-6 overflow-y-auto flex-1">
                    {/* Permanent Room (Admin Only) */}
                    {isAdmin && (
                        <button
                            onClick={onTogglePermanent}
                            className={`w-full p-4 rounded-xl border flex items-center justify-between transition-all ${isPermanent ? 'bg-amber-500/10 border-amber-500/20' : 'bg-zinc-800/30 border-zinc-800'
                                }`}
                        >
                            <div className="text-left flex items-center gap-3">
                                <Infinity className={`w-5 h-5 ${isPermanent ? 'text-amber-500' : 'text-zinc-500'}`} />
                                <div>
                                    <span className="font-medium text-white text-sm">Permanent Room</span>
                                    <p className="text-xs text-zinc-500 mt-0.5">Room won&apos;t be deleted when empty</p>
                                </div>
                            </div>
                            <div className={`w-10 h-5 rounded-full transition-all flex items-center px-0.5 ${isPermanent ? 'bg-amber-500' : 'bg-zinc-700'}`}>
                                <div className={`w-4 h-4 bg-white rounded-full transition-all shadow-sm ${isPermanent ? 'translate-x-5' : 'translate-x-0'}`} />
                            </div>
                        </button>
                    )}

                    {/* Theme Selection */}
                    <div className="space-y-3">
                        <label className="text-xs font-medium text-zinc-400 flex items-center gap-2">
                            <Palette className="w-4 h-4" /> Theme
                        </label>
                        <div className="grid grid-cols-3 gap-2">
                            {THEMES.map(t => (
                                <button
                                    key={t.id}
                                    onClick={() => { onThemeChange(t); localStorage.setItem('wt_theme', t.id); setShowCustomTheme(false); }}
                                    className={`p-3 rounded-xl border text-xs font-medium transition-all ${activeTheme.id === t.id && !showCustomTheme
                                            ? 'bg-white/10 border-white/20 text-white'
                                            : 'bg-white/5 border-white/5 text-zinc-500 hover:border-white/10 hover:text-zinc-300'
                                        }`}
                                >
                                    <div className={`h-2 w-full rounded-full mb-2 ${t.accent}`} />
                                    {t.name}
                                </button>
                            ))}
                        </div>

                        {/* Custom Theme Toggle */}
                        <button
                            onClick={() => setShowCustomTheme(!showCustomTheme)}
                            className={`w-full p-2 rounded-lg border text-[10px] font-bold transition-all flex items-center justify-between ${showCustomTheme
                                    ? 'bg-violet-500/10 border-violet-500/20 text-violet-400'
                                    : 'bg-white/5 border-white/5 text-zinc-500 hover:border-white/10'
                                }`}
                        >
                            <span>Custom Theme</span>
                            <ChevronDown className={`w-3 h-3 transition-transform ${showCustomTheme ? 'rotate-180' : ''}`} />
                        </button>

                        {/* Custom Theme Editor */}
                        {showCustomTheme && (
                            <div className="space-y-3 p-3 rounded-lg bg-white/5 border border-white/5">
                                <div className="flex items-center gap-3">
                                    <div className="flex-1">
                                        <label className="text-[9px] text-zinc-500 uppercase">Background</label>
                                        <div className="flex items-center gap-2 mt-1">
                                            <input
                                                type="color"
                                                value={customBgColor}
                                                onChange={(e) => setCustomBgColor(e.target.value)}
                                                className="w-8 h-8 rounded-lg border border-white/10 cursor-pointer bg-transparent"
                                            />
                                            <input
                                                type="text"
                                                value={customBgColor}
                                                onChange={(e) => setCustomBgColor(e.target.value)}
                                                className="flex-1 h-8 bg-white/5 border border-white/10 rounded-lg px-2 text-[10px] font-mono text-white focus:outline-none focus:border-violet-500/50"
                                            />
                                        </div>
                                    </div>
                                    <div className="flex-1">
                                        <label className="text-[9px] text-zinc-500 uppercase">Accent</label>
                                        <div className="flex items-center gap-2 mt-1">
                                            <input
                                                type="color"
                                                value={customAccentColor}
                                                onChange={(e) => setCustomAccentColor(e.target.value)}
                                                className="w-8 h-8 rounded-lg border border-white/10 cursor-pointer bg-transparent"
                                            />
                                            <input
                                                type="text"
                                                value={customAccentColor}
                                                onChange={(e) => setCustomAccentColor(e.target.value)}
                                                className="flex-1 h-8 bg-white/5 border border-white/10 rounded-lg px-2 text-[10px] font-mono text-white focus:outline-none focus:border-violet-500/50"
                                            />
                                        </div>
                                    </div>
                                </div>
                                <button
                                    onClick={handleApplyCustomTheme}
                                    className="w-full h-8 bg-violet-600 hover:bg-violet-500 text-white text-[10px] font-bold rounded-lg transition-colors"
                                >
                                    Apply Custom Theme
                                </button>
                            </div>
                        )}
                    </div>

                    {/* Typography Scale */}
                    <div className="space-y-3">
                        <label className="text-xs font-medium text-zinc-400 flex items-center gap-2">
                            <ListVideo className="w-4 h-4" /> Text Size ({fontSize}px)
                        </label>
                        <input
                            type="range"
                            min="12"
                            max="24"
                            value={fontSize}
                            onChange={(e) => {
                                const val = parseInt(e.target.value);
                                setFontSize(val);
                                localStorage.setItem('wt_font_size', val.toString());
                            }}
                            className="w-full h-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-violet-500"
                        />
                    </div>

                    {/* Proxy Toggle */}
                    <button
                        onClick={() => { setUseProxy(!useProxy); localStorage.setItem('wt_proxy', String(!useProxy)); }}
                        className={`w-full p-4 rounded-xl border flex items-center justify-between transition-all ${useProxy ? 'bg-violet-500/10 border-violet-500/20' : 'bg-zinc-800/30 border-zinc-800'
                            }`}
                    >
                        <div className="text-left">
                            <span className="font-medium text-white text-sm">Proxy Mode</span>
                            <p className="text-xs text-zinc-500 mt-0.5">Bypass regional restrictions</p>
                        </div>
                        <div className={`w-10 h-5 rounded-full transition-all flex items-center px-0.5 ${useProxy ? 'bg-violet-500' : 'bg-zinc-700'}`}>
                            <div className={`w-4 h-4 bg-white rounded-full transition-all shadow-sm ${useProxy ? 'translate-x-5' : 'translate-x-0'}`} />
                        </div>
                    </button>

                    {/* Cookie Manager */}
                    <div className="pt-4 border-t border-zinc-800">
                        <label className="text-xs font-medium text-zinc-400 flex items-center gap-2 mb-3">
                            <ShieldCheck className="w-4 h-4" /> Cookie Authentication
                        </label>
                        <div className="bg-zinc-800/30 rounded-xl border border-zinc-800 p-4 space-y-3">
                            <p className="text-xs text-zinc-400 leading-relaxed">
                                Upload YouTube cookies (Netscape format) to access age-restricted content.
                            </p>
                            <textarea
                                placeholder={isLoadingCookies ? 'Loading saved cookies...' : '# Netscape HTTP Cookie File...'}
                                className="w-full h-48 bg-zinc-900 border border-zinc-700 rounded-lg p-3 text-xs font-mono text-zinc-300 focus:outline-none focus:border-violet-500/50 resize-y placeholder:text-zinc-600"
                                value={cookieContent}
                                onChange={(e) => setCookieContent(e.target.value)}
                                disabled={isLoadingCookies}
                            />
                            <div className="flex justify-between items-center">
                                <div className="flex items-center gap-2 text-xs text-zinc-500">
                                    <Lock className="w-3 h-3" />
                                    <span>Stored on server</span>
                                </div>
                                <button
                                    onClick={onSaveCookies}
                                    disabled={isSavingCookies || !cookieContent || !currentUser || currentUser === 'Guest'}
                                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {isSavingCookies ? 'Saving...' : 'Save Cookies'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
