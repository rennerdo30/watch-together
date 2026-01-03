import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Trash2, ListVideo, Pin, Play, Loader2 } from 'lucide-react';

interface ResolveResponse {
    original_url: string;
    title: string;
    duration?: number;
    thumbnail?: string;
    is_live?: boolean;
    extractor_key?: string;
    pinned?: boolean;
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
    accentColor: string;
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
    fontSize,
    accentColor
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
            className={`
                group flex items-center gap-2 p-2 rounded-xl border transition-all select-none
                ${isActive
                    ? "bg-white/5 border-white/20"
                    : "bg-neutral-800/20 border-transparent hover:bg-neutral-800/40 hover:border-neutral-700"
                }
            `}
        >
            {/* Drag Handle */}
            <div
                {...attributes}
                {...listeners}
                className="cursor-grab active:cursor-grabbing text-neutral-600 hover:text-neutral-400 p-0.5 rounded transition-colors touch-none shrink-0"
            >
                <GripVertical className="w-3.5 h-3.5" />
            </div>

            {/* Thumbnail */}
            <div
                className="relative w-16 h-10 rounded-lg overflow-hidden bg-neutral-800 shrink-0 cursor-pointer group/thumb"
                onClick={() => !isLoading && onPlay(index)}
            >
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
                {/* Play/Load overlay */}
                <div className={`absolute inset-0 bg-black/50 transition-opacity flex items-center justify-center ${isLoading ? 'opacity-100' : 'opacity-0 group-hover/thumb:opacity-100'}`}>
                    {isLoading ? (
                        <Loader2 className="w-4 h-4 text-white animate-spin" />
                    ) : (
                        <Play className="w-4 h-4 text-white fill-white" />
                    )}
                </div>
                {/* Live indicator */}
                {item.is_live && (
                    <div className="absolute top-1 left-1 px-1 py-0.5 bg-red-600 text-[8px] font-bold text-white rounded uppercase">
                        Live
                    </div>
                )}
                {/* Pin indicator */}
                {item.pinned && (
                    <div className="absolute top-1 right-1">
                        <Pin className="w-2.5 h-2.5 text-amber-400 fill-amber-400" />
                    </div>
                )}
            </div>

            {/* Content - Click to Play */}
            <div
                className="flex-1 min-w-0 cursor-pointer"
                onClick={() => !isLoading && onPlay(index)}
            >
                <div className="flex items-center gap-1.5">
                    <p className={`font-medium truncate leading-tight ${isActive ? "text-white" : "text-neutral-300 group-hover:text-white"}`}
                        style={{ fontSize: `${fontSize}px` }}>
                        {item.title}
                    </p>
                    {isLoading && <Loader2 className="w-3 h-3 text-white/40 animate-spin shrink-0" />}
                </div>
                <p className="text-[9px] font-mono text-neutral-500 truncate mt-0.5">
                    {new URL(item.original_url).hostname.replace('www.', '')}
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
                        className={`p-1.5 rounded-lg transition-all ${item.pinned
                                ? "text-amber-400 bg-amber-500/10"
                                : "opacity-0 group-hover:opacity-100 text-neutral-500 hover:text-amber-400 hover:bg-amber-500/10"
                            }`}
                        title={item.pinned ? "Unpin (won't auto-remove)" : "Pin (won't auto-remove)"}
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
                    className={`p-1.5 rounded-lg transition-all ${isActive
                            ? "opacity-30 cursor-not-allowed text-neutral-600"
                            : "opacity-0 group-hover:opacity-100 text-neutral-500 hover:text-red-400 hover:bg-red-500/10"
                        }`}
                    title={isActive ? "Cannot remove currently playing" : "Remove from queue"}
                >
                    <Trash2 className="w-3 h-3" />
                </button>
            </div>
        </div>
    );
}

// Separate component for DragOverlay (pure visual, no hooks)
export function QueueItemOverlay({ item, isActive, fontSize, accentColor }: Omit<SortableQueueItemProps, 'id' | 'index' | 'onRemove' | 'onPlay' | 'onPin'>) {
    return (
        <div className={`
             flex items-center gap-2 p-2 rounded-xl border border-neutral-600 bg-neutral-900 shadow-2xl cursor-grabbing select-none
             ${isActive ? "border-white/30" : ""}
        `}>
            <div className="text-neutral-400 p-0.5 shrink-0">
                <GripVertical className="w-3.5 h-3.5" />
            </div>

            {/* Thumbnail */}
            <div className="relative w-16 h-10 rounded-lg overflow-hidden bg-neutral-800 shrink-0">
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
                    <div className="absolute top-1 left-1 px-1 py-0.5 bg-red-600 text-[8px] font-bold text-white rounded uppercase">
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
                    {new URL(item.original_url).hostname.replace('www.', '')}
                </p>
            </div>
        </div>
    );
}
