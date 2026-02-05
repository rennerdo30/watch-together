'use client';

import React from 'react';
import { Home, Settings, Infinity } from 'lucide-react';
import { useRouter } from 'next/navigation';
import type { ResolveResponse } from '@/lib/api';

interface RoomHeaderProps {
    roomId: string;
    connected: boolean;
    videoData: ResolveResponse | null;
    actualPlayerTime: number;
    isPlaying: boolean;
    isPermanent: boolean;
    isAdmin: boolean;
    onSettingsClick: () => void;
    activeTheme: {
        accent: string;
        text: string;
        border: string;
    };
}

export function RoomHeader({
    roomId,
    connected,
    videoData,
    actualPlayerTime,
    isPlaying,
    isPermanent,
    isAdmin,
    onSettingsClick,
    activeTheme,
}: RoomHeaderProps) {
    const router = useRouter();

    const formatTime = (s: number): string => {
        const mins = Math.floor(s / 60);
        const secs = Math.floor(s % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    };

    return (
        <header className={`h-12 border-b ${activeTheme.border} flex items-center justify-between px-3 shrink-0 bg-neutral-950/30`}>
            <div className="flex items-center gap-3">
                <button
                    onClick={() => router.push('/')}
                    className="p-2 hover:bg-neutral-800/50 rounded-lg transition-colors group"
                >
                    <Home className="w-4 h-4 text-neutral-500 group-hover:text-white transition-colors" />
                </button>
                <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-500 shadow-lg shadow-emerald-500/20' : 'bg-red-500'}`} />
                    <span className="text-[10px] font-black text-neutral-500 uppercase tracking-[0.2em]">
                        {roomId}
                    </span>
                    {isPermanent && (
                        <span className="flex items-center gap-1 text-[9px] font-bold text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded">
                            <Infinity className="w-3 h-3" />
                            Permanent
                        </span>
                    )}
                </div>
            </div>

            <div className="flex items-center gap-2">
                {videoData && (
                    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg ${activeTheme.accent} bg-opacity-10`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${isPlaying ? 'bg-green-400 animate-pulse' : 'bg-neutral-500'}`} />
                        <span className={`text-[10px] font-black ${activeTheme.text} uppercase tracking-wider`}>
                            {isPlaying ? 'Playing' : 'Paused'} {formatTime(actualPlayerTime)}
                        </span>
                    </div>
                )}
                <button
                    onClick={onSettingsClick}
                    className="p-2 hover:bg-neutral-800/50 rounded-lg transition-colors group"
                >
                    <Settings className="w-4 h-4 text-neutral-500 group-hover:text-white transition-colors" />
                </button>
            </div>
        </header>
    );
}
