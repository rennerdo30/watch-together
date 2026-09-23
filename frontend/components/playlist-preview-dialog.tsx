'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';

import { importPlaylist, previewPlaylist, type PlaylistPreview } from '@/lib/api';

interface PlaylistPreviewDialogProps {
    roomId: string;
    url: string;
    onClose: () => void;
    onImported: (added: number, skipped: number) => void;
}

function durationLabel(seconds: number | null): string {
    if (seconds === null || !Number.isFinite(seconds)) return 'Duration unavailable';
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${minutes}:${remainder}`;
}

export function PlaylistPreviewDialog({ roomId, url, onClose, onImported }: PlaylistPreviewDialogProps) {
    const dialogRef = useRef<HTMLDivElement>(null);
    const closeRef = useRef<HTMLButtonElement>(null);
    const [preview, setPreview] = useState<PlaylistPreview | null>(null);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        closeRef.current?.focus();
        return () => previousFocus?.focus();
    }, []);

    useEffect(() => {
        const controller = new AbortController();
        setLoading(true);
        setError('');
        setPreview(null);
        void previewPlaylist(roomId, url, controller.signal).then((result) => {
            if (controller.signal.aborted) return;
            setPreview(result);
            setSelected(new Set(result.entries.filter((entry) => entry.available && !entry.already_queued)
                .map((entry) => entry.id)));
        }).catch((reason: unknown) => {
            if (controller.signal.aborted) return;
            setError(reason instanceof Error ? reason.message : 'Could not preview this playlist.');
        }).finally(() => {
            if (!controller.signal.aborted) setLoading(false);
        });
        return () => controller.abort();
    }, [roomId, url]);

    useEffect(() => {
        const handleKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                if (!submitting) onClose();
                event.preventDefault();
                return;
            }
            if (event.key !== 'Tab') return;
            const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
                'button:not([disabled]), input:not([disabled])') ?? [])];
            if (focusable.length === 0) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                last.focus();
                event.preventDefault();
            } else if (!event.shiftKey && document.activeElement === last) {
                first.focus();
                event.preventDefault();
            }
        };
        document.addEventListener('keydown', handleKey);
        return () => document.removeEventListener('keydown', handleKey);
    }, [onClose, submitting]);

    const available = preview?.entries.filter((entry) => entry.available && !entry.already_queued) ?? [];
    const selectedIds = preview?.entries.filter((entry) => selected.has(entry.id)).map((entry) => entry.id) ?? [];

    const submit = async () => {
        if (!preview || selectedIds.length === 0 || submitting) return;
        setSubmitting(true);
        setError('');
        try {
            const result = await importPlaylist(roomId, preview.preview_id, selectedIds);
            onImported(result.added, result.skipped);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Could not import this playlist.');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 p-3 backdrop-blur-sm sm:p-6"
            onMouseDown={(event) => { if (event.target === event.currentTarget && !submitting) onClose(); }}>
            <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="playlist-dialog-title"
                aria-describedby="playlist-dialog-help"
                className="flex max-h-[min(44rem,90vh)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-neutral-700 bg-neutral-900 text-white shadow-2xl">
                <div className="flex items-start justify-between gap-3 border-b border-neutral-800 p-4 sm:p-5">
                    <div>
                        <h2 id="playlist-dialog-title" className="text-base font-semibold">{preview?.title || 'Preview playlist'}</h2>
                        <p id="playlist-dialog-help" className="mt-1 text-xs text-neutral-400">
                            Review the videos, then choose which ones to add. Nothing enters the queue until you confirm.
                        </p>
                    </div>
                    <button ref={closeRef} type="button" aria-label="Close playlist preview" disabled={submitting}
                        onClick={onClose} className="rounded-md p-1.5 text-neutral-400 hover:bg-white/10 hover:text-white disabled:opacity-40">
                        <X aria-hidden="true" className="h-4 w-4" />
                    </button>
                </div>

                {loading ? (
                    <div role="status" className="flex min-h-48 items-center justify-center gap-2 text-sm text-neutral-300">
                        <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> Loading playlist…
                    </div>
                ) : preview ? (
                    <>
                        <div className="flex items-center justify-between gap-3 border-b border-neutral-800 px-4 py-2.5 text-xs sm:px-5">
                            <span className="text-neutral-300">{selectedIds.length} selected · {preview.total} videos</span>
                            <div className="flex gap-3">
                                <button type="button" disabled={submitting || available.length === 0}
                                    onClick={() => setSelected(new Set(available.map((entry) => entry.id)))}
                                    className="text-sky-300 hover:text-sky-200 disabled:opacity-40">Select all</button>
                                <button type="button" disabled={submitting || selectedIds.length === 0}
                                    onClick={() => setSelected(new Set())}
                                    className="text-sky-300 hover:text-sky-200 disabled:opacity-40">Clear selection</button>
                            </div>
                        </div>
                        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2 sm:px-5" aria-label="Playlist videos">
                            {preview.entries.map((entry) => {
                                const disabled = !entry.available || entry.already_queued || submitting;
                                return (
                                    <label key={entry.id} className={`flex items-center gap-3 rounded-lg px-2 py-2.5 ${disabled ? 'opacity-55' : 'cursor-pointer hover:bg-white/5'}`}>
                                        <input type="checkbox" aria-label={`Select video ${entry.index}: ${entry.title}`} checked={selected.has(entry.id)}
                                            disabled={disabled}
                                            onChange={() => setSelected((current) => {
                                                const next = new Set(current);
                                                if (next.has(entry.id)) next.delete(entry.id);
                                                else next.add(entry.id);
                                                return next;
                                            })}
                                            className="h-4 w-4 shrink-0 accent-sky-400" />
                                        <span className="w-6 shrink-0 text-right text-xs text-neutral-500">{entry.index}</span>
                                        {entry.thumbnail ? (
                                            // eslint-disable-next-line @next/next/no-img-element
                                            <img src={entry.thumbnail} alt="" loading="lazy" className="h-12 w-[5.3rem] shrink-0 rounded bg-neutral-800 object-cover" />
                                        ) : <span className="h-12 w-[5.3rem] shrink-0 rounded bg-neutral-800" />}
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate text-sm text-neutral-100">{entry.title}</span>
                                            <span className="block text-xs text-neutral-400">
                                                {entry.already_queued ? 'Already in queue' : entry.available ? durationLabel(entry.duration) : entry.reason || 'Unavailable'}
                                            </span>
                                        </span>
                                    </label>
                                );
                            })}
                        </div>
                    </>
                ) : null}

                <div className="border-t border-neutral-800 p-4 sm:px-5">
                    {error && <p role="alert" className="mb-3 text-xs text-red-300">{error}</p>}
                    <div className="flex justify-end gap-2">
                        <button type="button" disabled={submitting} onClick={onClose}
                            className="h-9 rounded-lg px-3 text-sm text-neutral-300 hover:bg-white/5 disabled:opacity-40">Cancel</button>
                        <button type="button" disabled={!preview || selectedIds.length === 0 || submitting} onClick={() => void submit()}
                            className="flex h-9 items-center gap-2 rounded-lg bg-sky-500 px-4 text-sm font-medium text-neutral-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40">
                            {submitting && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}
                            Add {selectedIds.length} video{selectedIds.length === 1 ? '' : 's'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
