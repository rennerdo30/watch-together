import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Trash2, ListVideo, Pin, Play, Loader2 } from 'lucide-react';

interface ResolveResponse {
    original_url: string;
    title: string;
    duration?: number;
    thumbnail?: string;
    is_live?: boolean;
    extractor_key?: string;
    pinned?: boolean;
}

const LIVE_BADGE_CLASSES =
    'absolute top-1 left-1 px-1 py-0.5 bg-red-600 text-[8px] font-bold on-accent-light rounded uppercase';

/** Host name for display, tolerating anything the resolver hands back. */
function displayHost(url: string): string {
    try {
        return new URL(url).hostname.replace('www.', '');
    } catch {
        return url;
    }
}

interface SortableQueueItemProps {
    id: string;
    item: ResolveResponse;
    index: number;
    isActive: boolean;
    isLoading?: boolean;
    onRemove: (index: number) => void;
    onPlay: (index: number) => void;
    onPin?: (index: number) => void;
    fontSize: number;
}

export function SortableQueueItem({
    id,
    item,
    index,
    isActive,
    isLoading,
    onRemove,
    onPlay,
    onPin,
    fontSize
}: SortableQueueItemProps) {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging
    } = useSortable({ id });

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
    };

    return (
        <div
            ref={setNodeRef}
            style={style}
            {...attributes}
            {...listeners}
            className={`
                group flex items-center gap-1.5 p-1 rounded-lg border transition-all select-none
                ${isActive
                    ? "bg-white/5 border-white/20"
                    : "bg-transparent border-transparent hover:bg-white/5 hover:border-white/10"
                }
            `}
        >
            {/* Thumbnail */}
            <button
                type="button"
                aria-label={`Play ${item.title}`}
                disabled={isLoading}
                className="on-dark relative w-14 h-9 rounded-lg overflow-hidden bg-neutral-800 shrink-0 cursor-pointer group/thumb"
                onClick={(e) => {
                    e.stopPropagation();
                    if (!isLoading) onPlay(index);
                }}
            >
                {item.thumbnail ? (
                    <img
                        src={item.thumbnail}
                        alt=""
                        className="w-full h-full object-cover"
                    />
                ) : (
                    <span className="w-full h-full flex items-center justify-center">
                        <ListVideo aria-hidden="true" className="w-4 h-4 text-neutral-500" />
                    </span>
                )}
                {/* Play/Load overlay */}
                <span className={`absolute inset-0 bg-black/50 transition-opacity flex items-center justify-center ${isLoading ? 'opacity-100' : 'opacity-0 group-hover/thumb:opacity-100'}`}>
                    {isLoading ? (
                        <Loader2 aria-hidden="true" className="w-4 h-4 text-white animate-spin" />
                    ) : (
                        <Play aria-hidden="true" className="w-4 h-4 text-white fill-white" />
                    )}
                </span>
                {/* Live indicator */}
                {item.is_live && (
                    <span className={LIVE_BADGE_CLASSES}>
                        Live
                    </span>
                )}
                {/* Pin indicator */}
                {item.pinned && (
                    <span className="absolute top-1 right-1">
                        <Pin aria-hidden="true" className="w-2.5 h-2.5 text-amber-400 fill-amber-400" />
                    </span>
                )}
            </button>

            {/* Content - Click to Play */}
            <div
                className="flex-1 min-w-0 cursor-pointer"
                onClick={(e) => {
                    e.stopPropagation();
                    if (!isLoading) onPlay(index);
                }}
            >
                <div className="flex items-center gap-1.5">
                    <p className={`font-medium truncate leading-tight ${isActive ? "text-white" : "text-neutral-300 group-hover:text-white"}`}
                        style={{ fontSize: `${fontSize}px` }}>
                        {item.title}
                    </p>
                    {isLoading && <Loader2 className="w-3 h-3 text-white/40 animate-spin shrink-0" />}
                </div>
                <p className="text-[9px] font-mono text-neutral-500 truncate mt-0.5">
                    {displayHost(item.original_url)}
                </p>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-0.5 shrink-0">
                {onPin && (
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onPin(index);
                        }}
                        className={`p-1 rounded-lg transition-all ${item.pinned
                            ? "text-amber-400 bg-amber-500/10"
                            : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-neutral-400 hover:text-amber-400 hover:bg-amber-500/10"
                            }`}
                        title={item.pinned ? "Unpin (won't auto-remove)" : "Pin (won't auto-remove)"}
                        aria-label={item.pinned ? `Unpin ${item.title}` : `Pin ${item.title}`}
                        aria-pressed={Boolean(item.pinned)}
                    >
                        <Pin className={`w-3 h-3 ${item.pinned ? "fill-amber-400" : ""}`} />
                    </button>
                )}
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        onRemove(index);
                    }}
                    disabled={isActive || isLoading}
                    className={`p-1 rounded-lg transition-all ${isActive
                        ? "opacity-30 cursor-not-allowed text-neutral-600"
                        : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-neutral-400 hover:text-red-400 hover:bg-red-500/10"
                        }`}
                    title={isActive ? "Cannot remove currently playing" : "Remove from queue"}
                    aria-label={`Remove ${item.title} from the queue`}
                >
                    <Trash2 aria-hidden="true" className="w-3 h-3" />
                </button>
            </div>
        </div>
    );
}

// Separate component for DragOverlay (pure visual, no hooks)
export function QueueItemOverlay({ item, isActive, fontSize }: Omit<SortableQueueItemProps, 'id' | 'index' | 'onRemove' | 'onPlay' | 'onPin'>) {
    return (
        <div className={`
             flex items-center gap-1.5 p-1.5 rounded-xl border border-neutral-600 bg-neutral-900 shadow-2xl cursor-grabbing select-none
             ${isActive ? "border-white/30" : ""}
        `}>
            {/* Thumbnail */}
            <div className="on-dark relative w-14 h-9 rounded-lg overflow-hidden bg-neutral-800 shrink-0">
                {item.thumbnail ? (
                    <img
                        src={item.thumbnail}
                        alt=""
                        className="w-full h-full object-cover"
                    />
                ) : (
                    <div className="w-full h-full flex items-center justify-center">
                        <ListVideo className="w-4 h-4 text-neutral-600" />
                    </div>
                )}
                {item.is_live && (
                    <div className={LIVE_BADGE_CLASSES}>
                        Live
                    </div>
                )}
                {item.pinned && (
                    <div className="absolute top-1 right-1">
                        <Pin className="w-2.5 h-2.5 text-amber-400 fill-amber-400" />
                    </div>
                )}
            </div>

            <div className="flex-1 min-w-0">
                <p className={`font-medium truncate leading-tight ${isActive ? "text-white" : "text-neutral-200"}`}
                    style={{ fontSize: `${fontSize}px` }}>
                    {item.title}
                </p>
                <p className="text-[9px] font-mono text-neutral-500 truncate mt-0.5">
                    {displayHost(item.original_url)}
                </p>
            </div>
        </div>
    );
}
