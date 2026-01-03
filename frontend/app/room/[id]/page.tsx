"use client";

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
    Loader2, Users, Link as LinkIcon,
    Plus, Trash2, SkipForward,
    Play, ListVideo, Settings, X, Palette, ShieldCheck, Home, GripVertical, Pin, Bug,
    Crown, Shield, User as UserIcon, ChevronUp, ChevronDown, Lock, Copy, Check
} from 'lucide-react';
import { ResolveResponse, resolveUrl } from '@/lib/api';
import { CustomPlayer } from '@/components/custom-player';
import { ErrorBoundary } from '@/components/error-boundary';
import { THEMES, DEFAULT_THEME, type Theme } from '@/lib/themes';
import toast, { Toaster } from 'react-hot-toast';

import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragEndEvent, DragStartEvent, DragOverlay } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { SortableQueueItem, QueueItemOverlay } from '@/components/sortable-queue-item';

function getWsUrl(roomId: string) {
    if (typeof window === "undefined") return "";
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    return `${protocol}//${host}/ws/${roomId}`;
}

export default function RoomPage() {
    const { id: roomId } = useParams() as { id: string };
    const router = useRouter();

    // UI State
    const [videoData, setVideoData] = useState<ResolveResponse | null>(null);
    const [queue, setQueue] = useState<ResolveResponse[]>([]);
    const [playingIndex, setPlayingIndex] = useState<number>(-1);
    const [inputUrl, setInputUrl] = useState('');
    const [loading, setLoading] = useState(false);
    const [members, setMembers] = useState<{ email: string }[]>([]);
    const [roles, setRoles] = useState<Record<string, string>>({});
    const [currentUser, setCurrentUser] = useState<string>("");
    const [connected, setConnected] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [activeTheme, setActiveTheme] = useState(DEFAULT_THEME);
    const [useProxy, setUseProxy] = useState(true);
    const [sidebarTab, setSidebarTab] = useState<'queue' | 'users'>('queue');
    const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
    const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
    const [showDebug, setShowDebug] = useState(false);
    const [syncState, setSyncState] = useState({ isPlaying: false, timestamp: 0, lastSync: '' });
    const [loadingQueueIndex, setLoadingQueueIndex] = useState<number | null>(null);

    // Layout resizing
    const [sidebarWidth, setSidebarWidth] = useState(320); // Default width
    const isResizing = useRef(false);
    const [fontSize, setFontSize] = useState(15);
    const [cookieContent, setCookieContent] = useState('');
    const [isSavingCookies, setIsSavingCookies] = useState(false);
    const [isCopyingDebug, setIsCopyingDebug] = useState(false);

    // DnD Sensors
    const sensors = useSensors(
        useSensor(PointerSensor),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        })
    );
    const [activeDragId, setActiveDragId] = useState<string | null>(null);

    // WS & Player Refs
    const wsRef = useRef<WebSocket | null>(null);
    const playerRef = useRef<any>(null);
    const internalUpdateCount = useRef(0); // Counter to prevent feedback loops during sync
    const reconnectTimer = useRef<NodeJS.Timeout | null>(null);

    const syncThresholdRef = useRef(4);
    const [syncThreshold, setSyncThresholdState] = useState(4);

    const setSyncThreshold = (val: number) => {
        setSyncThresholdState(val);
        syncThresholdRef.current = val;
        localStorage.setItem('w2g-sync-threshold', val.toString());
    };

    useEffect(() => {
        const saved = localStorage.getItem('w2g-sync-threshold');
        if (saved) {
            const val = parseFloat(saved);
            setSyncThresholdState(val);
            syncThresholdRef.current = val;
        }
    }, []);

    const startResizing = (e: React.MouseEvent) => {
        isResizing.current = true;
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', stopResizing);
        document.body.style.cursor = 'col-resize';
    };

    const stopResizing = () => {
        isResizing.current = false;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', stopResizing);
        document.body.style.cursor = 'default';
        localStorage.setItem('wt_sidebar_width', sidebarWidth.toString());
    };

    const handleMouseMove = (e: MouseEvent) => {
        if (!isResizing.current) return;
        const width = window.innerWidth - e.clientX;
        if (width >= 240 && width <= 600) {
            setSidebarWidth(width);
        }
    };

    const handleDragStart = (event: DragStartEvent) => {
        setActiveDragId(event.active.id as string);
    };

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;

        if (over && active.id !== over.id) {
            setQueue((items) => {
                const oldIndex = items.findIndex((item) => item.original_url === active.id);
                const newIndex = items.findIndex((item) => item.original_url === over.id);
                const newQueue = arrayMove(items, oldIndex, newIndex);

                // Optimistic update + Send to server
                sendMsg('replace_queue', { queue: newQueue }); // Assuming 'replace_queue' or similar. 
                // Wait, typically 'queue_add' or similar exists. I should check 'update_queue' implementation or reuse existing one. 
                // I'll check 'sendMsg' usage.
                return newQueue;
            });
        }
        setActiveDragId(null);
    };

    const connect = () => {
        if (!roomId || typeof window === "undefined") return;
        let url = getWsUrl(roomId);
        const searchParams = new URLSearchParams(window.location.search);
        const mockUser = searchParams.get('user');
        if (mockUser) url += `?user=${encodeURIComponent(mockUser)}`;

        if (wsRef.current) wsRef.current.close();
        const ws = new WebSocket(url);
        wsRef.current = ws;

        ws.onopen = () => {
            setConnected(true);
            if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
        };
        ws.onmessage = (event) => {
            try { handleWsMessage(JSON.parse(event.data)); }
            catch (e) { console.error("Failed to parse WS message", e); }
        };
        ws.onclose = () => {
            setConnected(false);
            reconnectTimer.current = setTimeout(connect, 3000);
        };
        ws.onerror = () => ws.close();
    };

    useEffect(() => {
        connect();
        const savedTheme = localStorage.getItem('wt_theme');
        if (savedTheme) {
            const t = THEMES.find(th => th.id === savedTheme);
            if (t) setActiveTheme(t);
        }
        const savedProxy = localStorage.getItem('wt_proxy');
        if (savedProxy !== null) {
            setUseProxy(savedProxy === 'true');
        } else {
            setUseProxy(true); // Default to true
        }

        return () => {
            if (wsRef.current) wsRef.current.close();
            if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
        };
    }, [roomId]);

    useEffect(() => {
        let interval: NodeJS.Timeout;
        if (syncState.isPlaying) {
            interval = setInterval(() => {
                setSyncState(prev => ({
                    ...prev,
                    timestamp: prev.timestamp + 1
                }));
            }, 1000);
        }
        return () => clearInterval(interval);
    }, [syncState.isPlaying]);

    const handleWsMessage = (msg: any) => {
        const { type, payload } = msg;
        internalUpdateCount.current += 1; // Increment counter to block local events

        switch (type) {
            case 'sync':
                // On sync (initial load or reconnect), set video data and re-resolve for fresh DASH URLs
                if (payload.video_data) {
                    const isSameVideo = videoData?.original_url === payload.video_data.original_url;

                    if (!videoData || !isSameVideo) {
                        // New video or first load: Re-resolve for fresh stream URLs
                        if (payload.video_data.original_url) {
                            console.log('[Room] Sync: Re-resolving video for fresh stream URLs...');
                            resolveUrl(payload.video_data.original_url)
                                .then((freshData) => {
                                    console.log('[Room] Sync: Got fresh stream:', freshData.stream_type, freshData.quality);
                                    setVideoData(freshData);
                                })
                                .catch((err) => {
                                    console.warn('[Room] Sync: Re-resolve failed, using cached data:', err.message);
                                    setVideoData(payload.video_data);
                                });
                        } else {
                            setVideoData(payload.video_data);
                        }
                    } else {
                        // Same video already loaded, just update state if needed
                        console.log('[Room] Sync: Same video already loaded, skip re-resolve');
                    }
                }
                if (payload.members) setMembers(payload.members);
                if (payload.queue) setQueue(payload.queue);
                if (payload.roles) setRoles(payload.roles);
                if (payload.your_email) setCurrentUser(payload.your_email);
                if (typeof payload.playing_index === 'number') setPlayingIndex(payload.playing_index);

                if (playerRef.current && payload.video_data) {
                    if (payload.is_playing) playerRef.current.play?.().catch(() => { });
                    else playerRef.current.pause?.();

                    const isLive = payload.video_data.is_live;
                    if (isLive && payload.timestamp === 0) {
                        // Stay at live edge
                    } else if (playerRef.current) {
                        const playerTime = playerRef.current.currentTime();
                        const diff = Math.abs(playerTime - payload.timestamp);
                        if (diff > syncThresholdRef.current) playerRef.current.currentTime(payload.timestamp);
                    }
                }
                break;
            case 'user_joined': if (payload.members) setMembers(payload.members); break;
            case 'user_left': if (payload.members) setMembers(payload.members); break;
            case 'set_video':
                setLoadingQueueIndex(null); // Clear loading state
                // Reset sync state for new video
                setSyncState(prev => ({ ...prev, timestamp: 0, isPlaying: true }));

                // ALWAYS re-resolve when playing a video to get fresh stream URLs
                // YouTube URLs expire, so we can't cache them
                if (payload.video_data?.original_url) {
                    console.log('[Room] Re-resolving video for fresh stream URLs...');
                    // Show cached data immediately as placeholder
                    setVideoData(payload.video_data);

                    resolveUrl(payload.video_data.original_url)
                        .then((freshData) => {
                            console.log('[Room] Got fresh stream:', freshData.stream_type, freshData.quality);
                            setVideoData(freshData);
                        })
                        .catch((err) => {
                            console.warn('[Room] Re-resolve failed:', err.message);
                            // Keep showing cached data, might still work if not expired
                        });
                } else {
                    setVideoData(payload.video_data);
                }
                break;
            case 'play':
                if (playerRef.current) {
                    if (!(payload.video_data?.is_live && payload.timestamp === 0)) {
                        playerRef.current.currentTime(payload.timestamp);
                    }
                    playerRef.current.play();
                }
                break;
            case 'pause':
                if (playerRef.current) {
                    playerRef.current.pause();
                    if (!(payload.video_data?.is_live && payload.timestamp === 0)) {
                        playerRef.current.currentTime(payload.timestamp);
                    }
                }
                break;
            case 'seek':
                if (playerRef.current) playerRef.current.currentTime(payload.timestamp);
                break;
            case 'queue_update':
                setQueue(payload.queue);
                if (typeof payload.playing_index === 'number') setPlayingIndex(payload.playing_index);
                break;
            case 'roles_update':
                if (payload.roles) setRoles(payload.roles);
                break;
        }

        // Update sync state from server - this is the authoritative state
        // Only update fields that are actually in the payload
        if (type === 'sync' || type === 'play' || type === 'pause' || type === 'seek') {
            setSyncState(prev => ({
                isPlaying: type === 'play' ? true : type === 'pause' ? false : (payload.is_playing ?? prev.isPlaying),
                timestamp: payload.timestamp ?? prev.timestamp,
                lastSync: new Date().toLocaleTimeString()
            }));
        }

        // Decrement counter after a short delay to allow player events to settle
        setTimeout(() => { internalUpdateCount.current = Math.max(0, internalUpdateCount.current - 1); }, 300);
    };

    const sendMsg = (type: string, payload?: any) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type, payload }));
        }
    };

    const handleLoadNow = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!inputUrl || loading) return;
        setLoading(true);
        try {
            const data = await resolveUrl(inputUrl);
            sendMsg('set_video', { video_data: data });
            setInputUrl('');
            toast.success(`Playing: ${data.title}`);
        } catch (err: any) {
            console.error(err);
            toast.error(err.message || 'Failed to resolve video');
        } finally { setLoading(false); }
    };

    const handleAddToQueue = async () => {
        if (!inputUrl || loading) return;
        setLoading(true);
        try {
            const data = await resolveUrl(inputUrl);
            sendMsg('queue_add', { video_data: data });
            setInputUrl('');
            toast.success(`Added to queue: ${data.title}`);
        } catch (err: any) {
            console.error(err);
            toast.error(err.message || 'Failed to resolve video');
        } finally { setLoading(false); }
    };

    const getFinalVideoUrl = () => {
        if (!videoData) return "";
        const rawUrl = videoData.stream_url;
        const proxiedUrl = useProxy ? `/api/proxy?url=${encodeURIComponent(rawUrl)}` : rawUrl;

        // Help hls.js identify HLS streams by providing explicit MIME type
        const isHls = rawUrl.includes('.m3u8') || rawUrl.includes('playlist') || rawUrl.includes('manifest');
        if (isHls) {
            return { src: proxiedUrl, type: 'application/x-mpegurl' };
        }
        return proxiedUrl;
    };

    // Get DASH-specific URLs (proxied if needed)
    const getDashUrls = () => {
        if (!videoData || videoData.stream_type !== 'dash') return null;
        return {
            videoUrl: useProxy && videoData.video_url
                ? `/api/proxy?url=${encodeURIComponent(videoData.video_url)}`
                : videoData.video_url,
            audioUrl: useProxy && videoData.audio_url
                ? `/api/proxy?url=${encodeURIComponent(videoData.audio_url)}`
                : videoData.audio_url,
            availableQualities: videoData.available_qualities?.map(q => ({
                ...q,
                video_url: useProxy ? `/api/proxy?url=${encodeURIComponent(q.video_url)}` : q.video_url
            })),
            audioOptions: videoData.audio_options?.map(a => ({
                ...a,
                audio_url: useProxy ? `/api/proxy?url=${encodeURIComponent(a.audio_url)}` : a.audio_url
            }))
        };
    };

    return (
        <main className={`h-screen w-screen flex flex-col ${activeTheme.bg} text-neutral-300 overflow-hidden font-sans uppercase tracking-tight`}>
            <Toaster position="bottom-center" toastOptions={{
                style: {
                    background: '#171717',
                    color: '#fff',
                    border: '1px solid #262626',
                    fontSize: `${fontSize - 1}px`,
                    fontWeight: 'bold',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em'
                }
            }} />
            {/* Header - Slimbed to h-11 */}
            <header className={`h-11 border-b ${activeTheme.border} flex items-center px-4 shrink-0 ${activeTheme.header} backdrop-blur-md z-50`}>
                <div className="flex items-center gap-3">
                    <button
                        onClick={() => router.push('/')}
                        className="w-7 h-7 rounded-lg bg-neutral-800 hover:bg-neutral-700 flex items-center justify-center transition-colors"
                    >
                        <Home className="w-4 h-4 text-neutral-400" />
                    </button>
                    <div className="flex flex-col">
                        <h1 className="font-black text-white leading-none" style={{ fontSize: `${fontSize}px` }}>Watch Together</h1>
                        <div className="flex items-center gap-1.5 mt-0.5">
                            <span className="font-bold text-neutral-600" style={{ fontSize: `${fontSize - 2}px` }}>{roomId}</span>
                            <div className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-green-500" : "bg-red-500 animate-pulse"}`} />
                        </div>
                    </div>
                </div>

                <div className="ml-auto flex items-center gap-3">
                    {/* Playback State Indicator */}
                    {videoData && (
                        <div className="hidden sm:flex items-center gap-2 px-2.5 py-1 bg-neutral-800/80 rounded-md border border-neutral-700/50">
                            <div className={`w-2 h-2 rounded-full ${syncState.isPlaying ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`} />
                            <span className="text-[10px] font-bold text-neutral-300 uppercase">
                                {syncState.isPlaying ? 'Playing' : 'Paused'}
                            </span>
                            <span className="text-[10px] font-mono text-neutral-500">
                                {Math.floor(syncState.timestamp / 60)}:{Math.floor(syncState.timestamp % 60).toString().padStart(2, '0')}
                            </span>
                        </div>
                    )}
                    <div className="hidden sm:flex items-center gap-1.5 px-2 py-1 bg-neutral-800 rounded-md">
                        <Users className="w-3 h-3 text-neutral-500" />
                        <span className="text-[11px] font-black text-neutral-400">{members.length}</span>
                    </div>
                    <button
                        onClick={() => setShowDebug(!showDebug)}
                        className={`w-7 h-7 flex items-center justify-center rounded-lg transition-colors ${showDebug ? 'bg-emerald-500/20 text-emerald-400' : 'hover:bg-neutral-800 text-neutral-500 hover:text-white'}`}
                        title="Debug Panel"
                    >
                        <Bug className="w-4 h-4" />
                    </button>
                    <button
                        onClick={() => setShowSettings(true)}
                        className="w-7 h-7 flex items-center justify-center hover:bg-neutral-800 rounded-lg transition-colors text-neutral-500 hover:text-white"
                        title="Settings"
                    >
                        <Settings className="w-4 h-4" />
                    </button>
                </div>
            </header>

            {/* Main Content */}
            <div className="flex-1 flex min-h-0 overflow-hidden relative">
                {/* Player Area */}
                <div className="flex-1 flex flex-col p-3 min-w-0 overflow-hidden gap-2.5">
                    {/* Video Player */}
                    <div className="flex-1 min-h-0 relative rounded-xl overflow-hidden bg-black border border-neutral-800 shadow-2xl">
                        {(loading || loadingQueueIndex !== null) && (
                            <div className="absolute inset-0 z-10 bg-black/40 flex flex-col items-center justify-center gap-2 animate-in fade-in duration-300">
                                <Loader2 className="w-5 h-5 text-white animate-spin opacity-80" />
                                <span className="text-[10px] font-black text-white/80 uppercase tracking-widest">Resolving...</span>
                            </div>
                        )}
                        {videoData ? (
                            <ErrorBoundary>
                                <CustomPlayer
                                    key={`${videoData.stream_url}-${useProxy}-${videoData.stream_type}`}
                                    url={getFinalVideoUrl()}
                                    isLive={videoData.is_live}
                                    poster={videoData.thumbnail}
                                    autoPlay={true}
                                    initialTime={syncState.timestamp} // Pass initial sync timestamp
                                    // DASH-specific props
                                    streamType={videoData.stream_type}
                                    videoUrl={getDashUrls()?.videoUrl}
                                    audioUrl={getDashUrls()?.audioUrl}
                                    availableQualities={getDashUrls()?.availableQualities}
                                    audioOptions={getDashUrls()?.audioOptions}
                                    onPlay={() => {
                                        if (internalUpdateCount.current === 0) {
                                            const t = playerRef.current?.currentTime() || 0;
                                            sendMsg('play', { timestamp: t });
                                            setSyncState(prev => ({ ...prev, isPlaying: true, timestamp: t, lastSync: new Date().toLocaleTimeString() }));
                                        }
                                    }}
                                    onPause={() => {
                                        if (internalUpdateCount.current === 0) {
                                            const t = playerRef.current?.currentTime() || 0;
                                            sendMsg('pause', { timestamp: t });
                                            setSyncState(prev => ({ ...prev, isPlaying: false, timestamp: t, lastSync: new Date().toLocaleTimeString() }));
                                        }
                                    }}
                                    onSeeked={(time: number) => {
                                        if (internalUpdateCount.current === 0) {
                                            sendMsg('seek', { timestamp: time });
                                            setSyncState(prev => ({ ...prev, timestamp: time, lastSync: new Date().toLocaleTimeString() }));
                                        }
                                    }}
                                    onEnd={() => { if (internalUpdateCount.current === 0) sendMsg('video_ended'); }}
                                    playerRef={playerRef}
                                    syncThreshold={syncThreshold}
                                    onSyncThresholdChange={setSyncThreshold}
                                />
                            </ErrorBoundary>
                        ) : (
                            <div className="h-full w-full flex flex-col items-center justify-center gap-3 text-center opacity-20">
                                <div className="w-12 h-12 rounded-xl bg-neutral-900 flex items-center justify-center">
                                    <Play className="w-5 h-5 text-neutral-600" />
                                </div>
                                <div>
                                    <h3 className="text-[13px] font-black text-neutral-400">Idle Transmission</h3>
                                    <p className="text-[11px] text-neutral-600 mt-1">Awaiting stream signal</p>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Debug Panel */}
                    {showDebug && (
                        <div className="bg-black/80 backdrop-blur-xl border border-emerald-500/20 rounded-lg p-3 font-mono text-[10px] text-emerald-400 shrink-0 relative group/debug">
                            <button
                                onClick={() => {
                                    const debugInfo = {
                                        roomId,
                                        connected,
                                        syncState,
                                        queueLength: queue.length,
                                        playingIndex,
                                        videoData,
                                        useProxy,
                                        membersCount: members.length,
                                        fontSize,
                                        userAgent: navigator.userAgent
                                    };
                                    navigator.clipboard.writeText(JSON.stringify(debugInfo, null, 2));
                                    setIsCopyingDebug(true);
                                    setTimeout(() => setIsCopyingDebug(false), 2000);
                                    toast.success("Debug info copied");
                                }}
                                className="absolute top-2 right-2 p-1.5 rounded-md bg-neutral-900/50 hover:bg-neutral-800 border border-neutral-800 text-neutral-500 hover:text-white transition-all opacity-0 group-hover/debug:opacity-100 flex items-center gap-1.5"
                                title="Copy Debug Info"
                            >
                                {isCopyingDebug ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                                <span className="text-[9px] font-black uppercase tracking-widest">{isCopyingDebug ? 'COPIED' : 'COPY ALL'}</span>
                            </button>
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                                <div>
                                    <span className="text-neutral-500 uppercase tracking-wider">WebSocket</span>
                                    <div className={`font-bold ${connected ? 'text-emerald-400' : 'text-red-400'}`}>
                                        {connected ? 'CONNECTED' : 'DISCONNECTED'}
                                    </div>
                                </div>
                                <div>
                                    <span className="text-neutral-500 uppercase tracking-wider">Playback</span>
                                    <div className="font-bold text-white">
                                        {syncState.isPlaying ? '▶ PLAYING' : '⏸ PAUSED'}
                                    </div>
                                </div>
                                <div>
                                    <span className="text-neutral-500 uppercase tracking-wider">Timestamp</span>
                                    <div className="font-bold text-white">
                                        {syncState.timestamp.toFixed(2)}s
                                    </div>
                                </div>
                                <div>
                                    <span className="text-neutral-500 uppercase tracking-wider">Last Sync</span>
                                    <div className="font-bold text-white">
                                        {syncState.lastSync || 'N/A'}
                                    </div>
                                </div>
                                <div>
                                    <span className="text-neutral-500 uppercase tracking-wider">Queue</span>
                                    <div className="font-bold text-white">
                                        {queue.length} items (#{playingIndex + 1})
                                    </div>
                                </div>
                                <div>
                                    <span className="text-neutral-500 uppercase tracking-wider">Video</span>
                                    <div className="font-bold text-white truncate" title={videoData?.title}>
                                        {videoData?.title?.slice(0, 20) || 'None'}...
                                    </div>
                                </div>
                                <div>
                                    <span className="text-neutral-500 uppercase tracking-wider">Proxy</span>
                                    <div className={`font-bold ${useProxy ? 'text-emerald-400' : 'text-neutral-500'}`}>
                                        {useProxy ? 'ENABLED' : 'DISABLED'}
                                    </div>
                                </div>
                                <div>
                                    <span className="text-neutral-500 uppercase tracking-wider">Stream Type</span>
                                    <div className={`font-bold ${videoData?.stream_type === 'dash' ? 'text-purple-400' : 'text-emerald-400'}`}>
                                        {videoData?.stream_type?.toUpperCase() || 'N/A'} {videoData?.quality && `(${videoData.quality})`}
                                    </div>
                                </div>
                                <div>
                                    <span className="text-neutral-500 uppercase tracking-wider">Qualities</span>
                                    <div className="font-bold text-white">
                                        {videoData?.available_qualities?.length || 0} options
                                    </div>
                                </div>
                                <div>
                                    <span className="text-neutral-500 uppercase tracking-wider">DASH URLs</span>
                                    <div className={`font-bold ${videoData?.video_url && videoData?.audio_url ? 'text-emerald-400' : 'text-red-400'}`}>
                                        {videoData?.video_url && videoData?.audio_url ? 'V+A OK' : 'N/A'}
                                    </div>
                                </div>
                                <div>
                                    <span className="text-neutral-500 uppercase tracking-wider">Members</span>
                                    <div className="font-bold text-white">
                                        {members.length} online
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Compact URL Input - shrunk to h-8 */}
                    <form onSubmit={handleLoadNow} className="flex gap-2 shrink-0">
                        <div className="relative flex-1">
                            <LinkIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-neutral-600" />
                            <input
                                className="w-full h-8 bg-neutral-900 border border-neutral-800 rounded-lg pl-9 pr-3 text-[13px] text-white focus:outline-none focus:border-neutral-700 transition-colors placeholder:text-neutral-700 font-bold"
                                placeholder="Paste video URL..."
                                value={inputUrl}
                                onChange={e => setInputUrl(e.target.value)}
                            />
                        </div>
                        <button
                            type="submit"
                            disabled={loading || !inputUrl}
                            className={`px-4 h-8 ${activeTheme.text} font-black rounded-lg text-[11px] transition-all disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1.5 ${activeTheme.accent} shadow-lg hover:brightness-110 active:scale-95`}
                        >
                            {loading ? <Loader2 className="animate-spin w-3 h-3" /> : <Play className="w-3 h-3 fill-current" />}
                            PLAY
                        </button>
                        <button
                            type="button"
                            onClick={handleAddToQueue}
                            disabled={loading || !inputUrl}
                            className={`px-4 h-8 bg-neutral-800/50 hover:bg-neutral-800 text-white font-black rounded-lg text-[11px] border ${activeTheme.border} disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1.5 transition-colors`}
                        >
                            <Plus className="w-3 h-3" />
                            QUEUE
                        </button>
                    </form>
                </div>

                {/* Resize Handle */}
                <div
                    onMouseDown={startResizing}
                    className="absolute top-0 bottom-0 right-0 z-10 w-1 px-[1.5px] cursor-col-resize group transition-colors hover:bg-neutral-700"
                    style={{ right: sidebarWidth }}
                >
                    <div className="h-full w-full bg-neutral-800 group-hover:bg-blue-500/50" />
                </div>

                {/* Resizable Sidebar */}
                <aside
                    className="border-l border-neutral-800 flex flex-col shrink-0 bg-neutral-900/30"
                    style={{ width: sidebarWidth }}
                >
                    {/* Compact Tabs */}
                    <div className="flex p-1.5 gap-1.5 border-b border-neutral-800 shrink-0">
                        <button
                            onClick={() => setSidebarTab('queue')}
                            className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[11px] font-black transition-all ${sidebarTab === 'queue'
                                ? "bg-neutral-800 text-white"
                                : "text-neutral-600 hover:text-neutral-400"
                                }`}
                        >
                            <ListVideo className="w-3 h-3" />
                            Queue ({queue.length})
                        </button>
                        <button
                            onClick={() => setSidebarTab('users')}
                            className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[11px] font-black transition-all ${sidebarTab === 'users'
                                ? "bg-neutral-800 text-white"
                                : "text-neutral-600 hover:text-neutral-400"
                                }`}
                        >
                            <Users className="w-3 h-3" />
                            Audience ({members.length})
                        </button>
                    </div>

                    {/* Content */}
                    <div className="flex-1 overflow-hidden relative">
                        {sidebarTab === 'queue' ? (
                            <DndContext
                                sensors={sensors}
                                collisionDetection={closestCenter}
                                onDragStart={handleDragStart}
                                onDragEnd={handleDragEnd}
                            >
                                <div className="h-full flex flex-col">
                                    <div className="flex-1 overflow-y-auto p-2 space-y-1.5 custom-scrollbar">
                                        <SortableContext
                                            items={queue.map(item => item.original_url)}
                                            strategy={verticalListSortingStrategy}
                                        >
                                            {queue.map((item, index) => (
                                                <SortableQueueItem
                                                    key={item.original_url}
                                                    id={item.original_url}
                                                    item={item}
                                                    index={index}
                                                    isActive={playingIndex === index}
                                                    isLoading={loadingQueueIndex === index}
                                                    fontSize={fontSize}
                                                    accentColor={activeTheme.accent}
                                                    onPlay={(i) => {
                                                        if (loadingQueueIndex !== i) {
                                                            setLoadingQueueIndex(i);
                                                            sendMsg('queue_play', { index: i });
                                                        }
                                                    }}
                                                    onRemove={(i) => sendMsg('queue_remove', { index: i })}
                                                    onPin={(i) => sendMsg('queue_pin', { index: i })}
                                                />
                                            ))}
                                        </SortableContext>
                                    </div>
                                    <DragOverlay>
                                        {activeDragId ? (
                                            <QueueItemOverlay
                                                item={queue.find(i => i.original_url === activeDragId)!}
                                                isActive={queue.findIndex(i => i.original_url === activeDragId) === playingIndex}
                                                fontSize={fontSize}
                                                accentColor={activeTheme.accent}
                                            />
                                        ) : null}
                                    </DragOverlay>
                                    <div className="p-2 border-t border-neutral-800 shrink-0 bg-neutral-900/40">
                                        <button
                                            onClick={() => sendMsg('video_ended')}
                                            className="w-full h-9 bg-neutral-800 hover:bg-neutral-700 text-neutral-400 hover:text-white font-black rounded-lg text-[11px] uppercase tracking-[0.2em] transition-all flex items-center justify-center gap-2"
                                        >
                                            <SkipForward className="w-3.5 h-3.5" />
                                            Next Segment
                                        </button>
                                    </div>
                                </div>
                            </DndContext>
                        ) : (

                            <div className="h-full overflow-y-auto p-2 space-y-1 custom-scrollbar">
                                {members.map((m, i) => {
                                    const role = roles[m.email] || 'user';
                                    const myRole = roles[currentUser] || 'user';
                                    const isAdmin = myRole === 'admin';

                                    return (
                                        <div key={i} className={`group flex items-center gap-2 p-1.5 rounded-lg bg-neutral-800/10 border ${activeTheme.border}`}>
                                            <div className={`w-6 h-6 rounded-md flex items-center justify-center text-[10px] font-black ${activeTheme.text} ${activeTheme.accent}`}>
                                                {m.email.charAt(0).toUpperCase()}
                                            </div>
                                            <div className="flex-1 min-w-0 flex flex-col">
                                                <p className="font-bold text-neutral-400 truncate" style={{ fontSize: `${fontSize - 3}px` }}>
                                                    {m.email} {currentUser === m.email && '(You)'}
                                                </p>
                                                <div className="flex items-center gap-1">
                                                    {role === 'admin' && <span className="text-[9px] text-amber-500 font-bold flex items-center gap-0.5"><Crown className="w-2.5 h-2.5" /> ADMIN</span>}
                                                    {role === 'moderator' && <span className="text-[9px] text-blue-400 font-bold flex items-center gap-0.5"><Shield className="w-2.5 h-2.5" /> AGENT</span>}
                                                </div>
                                            </div>

                                            {isAdmin && currentUser !== m.email && (
                                                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                                    {role !== 'admin' && (
                                                        <button
                                                            onClick={() => sendMsg('promote', { target_email: m.email, role: 'admin' })}
                                                            className="p-1 hover:bg-amber-500/20 text-neutral-500 hover:text-amber-500 rounded" title="Promote to Admin"
                                                        >
                                                            <Crown className="w-3 h-3" />
                                                        </button>
                                                    )}
                                                    {role !== 'moderator' && role !== 'admin' && (
                                                        <button
                                                            onClick={() => sendMsg('promote', { target_email: m.email, role: 'moderator' })}
                                                            className="p-1 hover:bg-blue-500/20 text-neutral-500 hover:text-blue-500 rounded" title="Promote to Moderator"
                                                        >
                                                            <Shield className="w-3 h-3" />
                                                        </button>
                                                    )}
                                                    {role !== 'user' && (
                                                        <button
                                                            onClick={() => sendMsg('promote', { target_email: m.email, role: 'user' })}
                                                            className="p-1 hover:bg-neutral-700 text-neutral-500 hover:text-neutral-300 rounded" title="Demote to User"
                                                        >
                                                            <UserIcon className="w-3 h-3" />
                                                        </button>
                                                    )}
                                                </div>
                                            )}

                                            <div className="w-1.5 h-1.5 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]" />
                                        </div>
                                    );
                                })}
                            </div>
                        )
                        }
                    </div >
                </aside >
            </div >

            {/* Settings Overlay - Compact */}
            {
                showSettings && (
                    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
                        <div className="absolute inset-0 bg-black/90 backdrop-blur-sm" onClick={() => setShowSettings(false)} />
                        <div className="relative w-full max-w-sm bg-neutral-900 border border-neutral-800 rounded-2xl overflow-hidden shadow-2xl animate-in zoom-in-95 duration-200">
                            <div className="p-4 border-b border-neutral-800 flex items-center justify-between">
                                <h2 className="text-[11px] font-black text-white/50 uppercase tracking-[0.2em]">Station Config</h2>
                                <button onClick={() => setShowSettings(false)} className="text-neutral-600 hover:text-white transition-colors">
                                    <X className="w-4 h-4" />
                                </button>
                            </div>

                            <div className="p-4 space-y-6">
                                <div className="space-y-3">
                                    <label className="text-[10px] font-black text-neutral-600 uppercase tracking-widest flex items-center gap-2">
                                        <Palette className="w-3 h-3" /> Design Language
                                    </label>
                                    <div className="grid grid-cols-3 gap-1.5">
                                        {THEMES.map(t => (
                                            <button
                                                key={t.id}
                                                onClick={() => { setActiveTheme(t); localStorage.setItem('wt_theme', t.id); }}
                                                className={`p-2 rounded-lg border text-[10px] font-black transition-all ${activeTheme.id === t.id
                                                    ? "bg-neutral-800 border-neutral-600 text-white shadow-lg"
                                                    : "bg-neutral-800/30 border-neutral-800/50 text-neutral-600 hover:border-neutral-700"
                                                    }`}
                                            >
                                                <div className={`h-1 w-full rounded-full mb-1.5 ${t.accent}`} />
                                                {t.name}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                <div className="space-y-3">
                                    <label className="text-[10px] font-black text-neutral-600 uppercase tracking-widest flex items-center gap-2">
                                        <ListVideo className="w-3 h-3" /> Typography Scale ({fontSize}px)
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
                                        className="w-full h-1 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-blue-500"
                                    />
                                </div>

                                <button
                                    onClick={() => { const v = !useProxy; setUseProxy(v); localStorage.setItem('wt_proxy', String(v)); }}
                                    className={`w-full p-3 rounded-xl border flex items-center justify-between transition-all ${useProxy ? "bg-blue-500/10 border-blue-500/20" : "bg-neutral-800/20 border-neutral-800"
                                        }`}
                                >
                                    <div className="text-left">
                                        <span className="font-black text-white/60 uppercase tracking-widest" style={{ fontSize: `${fontSize - 3}px` }}>HLS Tunnel</span>
                                        <p className="uppercase font-bold" style={{ fontSize: `${fontSize - 5}px`, color: 'rgb(80 80 80)' }}>Bypass regional constraints</p>
                                    </div>
                                    <div className={`w-8 h-4 rounded-full transition-all flex items-center px-0.5 ${useProxy ? "bg-blue-500" : "bg-neutral-800"}`}>
                                        <div className={`w-3 h-3 bg-white rounded-full transition-all ${useProxy ? "translate-x-4" : "translate-x-0"}`} />
                                    </div>
                                </button>

                                {/* Cookie Manager Section */}
                                <div className="pt-4 border-t border-neutral-800">
                                    <label className="text-[10px] font-black text-neutral-600 uppercase tracking-widest flex items-center gap-2 mb-3">
                                        <ShieldCheck className="w-3 h-3" /> Age Verification
                                    </label>
                                    <div className="bg-neutral-800/30 rounded-xl border border-neutral-800 p-3 space-y-3">
                                        <p className="text-[10px] text-neutral-500 leading-relaxed">
                                            To play age-restricted videos, upload valid YouTube cookies (Netscape format).
                                        </p>
                                        <textarea
                                            placeholder="# Netscape HTTP Cookie File..."
                                            className="w-full h-[200px] bg-neutral-900 border border-neutral-800 rounded-lg p-2 text-[10px] font-mono text-neutral-300 focus:outline-none focus:border-neutral-700 resize-none placeholder:text-neutral-700"
                                            value={cookieContent}
                                            onChange={(e) => setCookieContent(e.target.value)}
                                        />
                                        <div className="flex justify-between items-center text-[9px] text-neutral-600">
                                            <div className="flex items-center gap-2">
                                                <Lock className="w-2.5 h-2.5" />
                                                <span>Manual upload required</span>
                                            </div>
                                            <button
                                                onClick={async () => {
                                                    if (!cookieContent.trim().includes('# Netscape')) {
                                                        toast.error("Invalid Netscape format");
                                                        return;
                                                    }
                                                    if (!currentUser || currentUser === 'Guest') {
                                                        toast.error("You must be logged in to save cookies");
                                                        return;
                                                    }
                                                    setIsSavingCookies(true);
                                                    try {
                                                        // Pass user identity via query param for dev mode
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
                                                        toast.success("Cookies saved successfully");
                                                        setCookieContent(''); // Clear after save
                                                    } catch (err: any) {
                                                        toast.error(err.message || "Failed to save cookies");
                                                    } finally {
                                                        setIsSavingCookies(false);
                                                    }
                                                }}
                                                disabled={isSavingCookies || !cookieContent || !currentUser || currentUser === 'Guest'}
                                                className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-bold rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                            >
                                                {isSavingCookies ? "Saving..." : "Save Cookies"}
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                )
            }

            <style jsx global>{`
                .custom-scrollbar::-webkit-scrollbar { width: 3px; }
                .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
                .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.05); border-radius: 10px; }
                .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.1); }
            `}</style>
        </main >
    );
}
