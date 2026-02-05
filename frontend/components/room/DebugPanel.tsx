'use client';

import React from 'react';
import { Bug, Copy, Check } from 'lucide-react';
import type { ResolveResponse } from '@/lib/api';

interface DebugPanelProps {
    syncInfo: {
        isPlaying: boolean;
        timestamp: number;
        lastSync: string;
        latency?: number;
    };
    videoData: ResolveResponse | null;
    connected: boolean;
    members: { email: string }[];
    queue: ResolveResponse[];
    playingIndex: number;
    actualPlayerTime: number;
}

export function DebugPanel({
    syncInfo,
    videoData,
    connected,
    members,
    queue,
    playingIndex,
    actualPlayerTime,
}: DebugPanelProps) {
    const [showDebug, setShowDebug] = React.useState(false);
    const [isCopying, setIsCopying] = React.useState(false);

    const formatTime = (s: number): string => {
        const mins = Math.floor(s / 60);
        const secs = Math.floor(s % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    };

    const copyDebugInfo = async () => {
        const debugData = {
            connection: { connected, latency: syncInfo.latency },
            sync: syncInfo,
            video: videoData ? {
                title: videoData.title,
                type: videoData.stream_type
            } : null,
            room: { members: members.length, queue: queue.length, playingIndex },
            player: { actualTime: actualPlayerTime },
        };

        try {
            await navigator.clipboard.writeText(JSON.stringify(debugData, null, 2));
            setIsCopying(true);
            setTimeout(() => setIsCopying(false), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    };

    return (
        <div className="fixed bottom-4 left-4 z-50">
            <button
                onClick={() => setShowDebug(!showDebug)}
                className={`p-2 rounded-lg transition-all ${showDebug ? 'bg-violet-600 text-white' : 'bg-neutral-800/80 text-neutral-400 hover:text-white'
                    }`}
            >
                <Bug className="w-4 h-4" />
            </button>

            {showDebug && (
                <div className="absolute bottom-12 left-0 w-80 bg-neutral-900/95 border border-neutral-700 rounded-lg p-4 backdrop-blur-sm shadow-xl">
                    <div className="flex items-center justify-between mb-3">
                        <h3 className="text-xs font-bold text-white uppercase tracking-wider">Debug Info</h3>
                        <button
                            onClick={copyDebugInfo}
                            className="p-1.5 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-400 hover:text-white transition-colors"
                        >
                            {isCopying ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
                        </button>
                    </div>

                    <div className="space-y-2 text-[10px] font-mono">
                        <div className="flex justify-between">
                            <span className="text-neutral-500">Connected:</span>
                            <span className={connected ? 'text-green-400' : 'text-red-400'}>
                                {connected ? 'Yes' : 'No'}
                            </span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-neutral-500">Latency:</span>
                            <span className="text-neutral-300">{(syncInfo.latency ?? 0).toFixed(0)}ms</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-neutral-500">Sync State:</span>
                            <span className={syncInfo.isPlaying ? 'text-green-400' : 'text-yellow-400'}>
                                {syncInfo.isPlaying ? 'Playing' : 'Paused'}
                            </span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-neutral-500">Server Time:</span>
                            <span className="text-neutral-300">{formatTime(syncInfo.timestamp)}</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-neutral-500">Player Time:</span>
                            <span className="text-neutral-300">{formatTime(actualPlayerTime)}</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-neutral-500">Drift:</span>
                            <span className="text-neutral-300">
                                {((syncInfo.timestamp - actualPlayerTime) * 1000).toFixed(0)}ms
                            </span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-neutral-500">Stream Type:</span>
                            <span className="text-neutral-300">{videoData?.stream_type ?? 'N/A'}</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-neutral-500">Last Sync:</span>
                            <span className="text-neutral-300">{syncInfo.lastSync || 'Never'}</span>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
