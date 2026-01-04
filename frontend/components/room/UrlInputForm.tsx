'use client';

import React, { useState } from 'react';
import { Loader2, Plus, Play } from 'lucide-react';
import { resolveUrl } from '@/lib/api';
import toast from 'react-hot-toast';

interface UrlInputFormProps {
    onPlayNow: (videoData: any) => void;
    onAddToQueue: (videoData: any) => void;
    accentColor: string;
    disabled?: boolean;
}

export function UrlInputForm({
    onPlayNow,
    onAddToQueue,
    accentColor,
    disabled = false
}: UrlInputFormProps) {
    const [inputUrl, setInputUrl] = useState('');
    const [loading, setLoading] = useState(false);

    const handlePlayNow = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!inputUrl || loading || disabled) return;
        setLoading(true);
        try {
            const data = await resolveUrl(inputUrl);
            onPlayNow(data);
            setInputUrl('');
            toast.success(`Playing: ${data.title}`);
        } catch (err: any) {
            console.error(err);
            toast.error(err.message || 'Failed to resolve video');
        } finally {
            setLoading(false);
        }
    };

    const handleAddToQueue = async () => {
        if (!inputUrl || loading || disabled) return;
        setLoading(true);
        try {
            const data = await resolveUrl(inputUrl);
            onAddToQueue(data);
            setInputUrl('');
            toast.success(`Added to queue: ${data.title}`);
        } catch (err: any) {
            console.error(err);
            toast.error(err.message || 'Failed to resolve video');
        } finally {
            setLoading(false);
        }
    };

    return (
        <form onSubmit={handlePlayNow} className="flex gap-2 shrink-0">
            <div className="relative flex-1">
                <input
                    type="text"
                    placeholder="Paste URL..."
                    value={inputUrl}
                    onChange={(e) => setInputUrl(e.target.value)}
                    disabled={loading || disabled}
                    className="w-full h-10 bg-neutral-800/50 border border-neutral-700/50 rounded-xl px-4 text-sm placeholder:text-neutral-500 focus:outline-none focus:border-white/20 transition-colors disabled:opacity-50"
                />
            </div>
            <button
                type="submit"
                disabled={!inputUrl || loading || disabled}
                className={`h-10 px-4 text-xs font-bold uppercase tracking-wider rounded-xl transition-all flex items-center gap-2 ${accentColor} text-white disabled:opacity-40`}
            >
                {loading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                    <>
                        <Play className="w-3.5 h-3.5" /> Play
                    </>
                )}
            </button>
            <button
                type="button"
                onClick={handleAddToQueue}
                disabled={!inputUrl || loading || disabled}
                className="h-10 px-3 bg-neutral-800 hover:bg-neutral-700 text-neutral-400 hover:text-white text-xs font-bold uppercase tracking-wider rounded-xl transition-all flex items-center gap-1 disabled:opacity-40"
            >
                <Plus className="w-4 h-4" />
            </button>
        </form>
    );
}
