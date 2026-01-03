"use client";

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
    Loader2, Users, Link as LinkIcon,
    Plus, Trash2, SkipForward,
    Play, ListVideo, Settings, X, Palette, ShieldCheck, Home, GripVertical, Pin, Bug,
    Crown, Shield, User as UserIcon, ChevronUp, ChevronDown
} from 'lucide-react';
import { resolveUrl, ResolveResponse } from '@/lib/api';
import { CustomPlayer } from '@/components/custom-player';
import { ErrorBoundary } from '@/components/error-boundary';
import { THEMES, DEFAULT_THEME, type Theme } from '@/lib/themes';
import toast, { Toaster } from 'react-hot-toast';

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

    // WS & Player Refs
    const wsRef = useRef<WebSocket | null>(null);
    const playerRef = useRef<any>(null);
    const internalUpdateCount = useRef(0); // Counter to prevent feedback loops during sync
    const reconnectTimer = useRef<NodeJS.Timeout | null>(null);

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

    const handleWsMessage = (msg: any) => {
        const { type, payload } = msg;
        internalUpdateCount.current += 1; // Increment counter to block local events

        switch (type) {
            case 'sync':
                if (payload.video_data) setVideoData(payload.video_data);
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
                        if (diff > 2) playerRef.current.currentTime(payload.timestamp);
                    }
                }
                break;
            case 'user_joined': if (payload.members) setMembers(payload.members); break;
            case 'user_left': if (payload.members) setMembers(payload.members); break;
            case 'set_video':
                setVideoData(payload.video_data);
                setLoadingQueueIndex(null); // Clear loading state
                // Don't seek to 0 - let the player start naturally to avoid loop
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
                        {videoData ? (
                            <ErrorBoundary>
                                <CustomPlayer
                                    key={`${videoData.stream_url}-${useProxy}`}
                                    url={getFinalVideoUrl()}
                                    isLive={videoData.is_live}
                                    poster={videoData.thumbnail}
                                    autoPlay={true}
                                    onPlay={() => { if (internalUpdateCount.current === 0) sendMsg('play', { timestamp: playerRef.current?.currentTime() || 0 }); }}
                                    onPause={() => { if (internalUpdateCount.current === 0) sendMsg('pause', { timestamp: playerRef.current?.currentTime() || 0 }); }}
                                    onSeeked={(time: number) => { if (internalUpdateCount.current === 0) sendMsg('seek', { timestamp: time }); }}
                                    onEnd={() => { if (internalUpdateCount.current === 0) sendMsg('video_ended'); }}
                                    playerRef={playerRef}
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
                        <div className="bg-black/80 backdrop-blur-xl border border-emerald-500/20 rounded-lg p-3 font-mono text-[10px] text-emerald-400 shrink-0">
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
                            <div className="h-full flex flex-col">
                                <div className="flex-1 overflow-y-auto p-2 space-y-1.5 custom-scrollbar">
                                    {queue.map((item, index) => {
                                        const isPlaying = index === playingIndex;
                                        const isDragging = draggedIndex === index;
                                        const isDragOver = dragOverIndex === index && draggedIndex !== index;
                                        const isPinned = (item as any).pinned === true;

                                        return (
                                            <div
                                                key={index}
                                                draggable={!isPlaying}
                                                onDragStart={(e) => {
                                                    if (isPlaying) {
                                                        e.preventDefault();
                                                        return;
                                                    }
                                                    setDraggedIndex(index);
                                                    e.dataTransfer.effectAllowed = 'move';
                                                }}
                                                onDragEnd={() => {
                                                    if (draggedIndex !== null && dragOverIndex !== null && draggedIndex !== dragOverIndex) {
                                                        sendMsg('queue_reorder', { old_index: draggedIndex, new_index: dragOverIndex });
                                                    }
                                                    setDraggedIndex(null);
                                                    setDragOverIndex(null);
                                                }}
                                                onDragOver={(e) => {
                                                    e.preventDefault();
                                                    if (draggedIndex !== null && !isPlaying) {
                                                        setDragOverIndex(index);
                                                    }
                                                }}
                                                onDragLeave={() => {
                                                    if (dragOverIndex === index) {
                                                        setDragOverIndex(null);
                                                    }
                                                }}
                                                className={`group relative rounded-lg border transition-all overflow-hidden ${isPlaying
                                                    ? "bg-neutral-800 border-green-500/30"
                                                    : isPinned
                                                        ? "bg-amber-500/5 border-amber-500/20"
                                                        : isDragging
                                                            ? "bg-neutral-700 border-neutral-600 opacity-50"
                                                            : isDragOver
                                                                ? "bg-neutral-700 border-blue-500/50 scale-[1.01]"
                                                                : "bg-neutral-800/20 border-neutral-800/50 hover:border-neutral-700"
                                                    } ${!isPlaying ? 'cursor-grab active:cursor-grabbing' : ''}`}
                                            >
                                                <div className="p-2 flex gap-2">
                                                    <div className="relative w-14 aspect-video rounded-md bg-black/40 flex-shrink-0 overflow-hidden border border-white/5">
                                                        {item.thumbnail ? (
                                                            <img src={item.thumbnail} className="w-full h-full object-cover" alt="" draggable={false} />
                                                        ) : (
                                                            <div className="w-full h-full flex items-center justify-center">
                                                                <Play className="w-3 h-3 text-neutral-800 fill-current" />
                                                            </div>
                                                        )}
                                                        {isPlaying && <div className="absolute inset-0 bg-green-500/10 flex items-center justify-center"><div className="w-1 h-3 bg-green-500 rounded-full animate-pulse" /></div>}
                                                    </div>
                                                    <div className="flex-1 min-w-0 flex flex-col justify-center">
                                                        <h4 className="text-[12px] font-bold text-white/70 truncate">{item.title}</h4>
                                                        <span className="text-[9px] text-neutral-600 font-bold uppercase tracking-widest mt-0.5">{item.backend_engine}</span>
                                                    </div>

                                                    {/* Compact Actions */}
                                                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
                                                        <button
                                                            onClick={(e) => { e.stopPropagation(); sendMsg('queue_pin', { index }); }}
                                                            className={`w-6 h-6 flex items-center justify-center rounded-md transition-all ${isPinned ? "bg-amber-500 text-white shadow-[0_0_10px_rgba(245,158,11,0.5)]" : "bg-neutral-800 text-neutral-600 hover:text-amber-500"
                                                                }`}
                                                            title="Pin"
                                                        >
                                                            <Pin className="w-3 h-3" />
                                                        </button>
                                                        {!isPlaying && (
                                                            <>
                                                                <button
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        if (loadingQueueIndex !== index) {
                                                                            setLoadingQueueIndex(index);
                                                                            sendMsg('queue_play', { index });
                                                                        }
                                                                    }}
                                                                    className={`w-6 h-6 flex items-center justify-center rounded-md ${activeTheme.text} ${activeTheme.accent} shadow-lg cursor-pointer hover:brightness-110 active:scale-95 transition-all`}
                                                                    disabled={loadingQueueIndex !== null}
                                                                >
                                                                    {loadingQueueIndex === index ? (
                                                                        <Loader2 className="w-3 h-3 animate-spin" />
                                                                    ) : (
                                                                        <Play className="w-3 h-3 fill-current" />
                                                                    )}
                                                                </button>
                                                                <button
                                                                    onClick={(e) => { e.stopPropagation(); sendMsg('queue_remove', { index }); }}
                                                                    className="w-6 h-6 flex items-center justify-center bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white rounded-md transition-all"
                                                                >
                                                                    <Trash2 className="w-3 h-3" />
                                                                </button>
                                                            </>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
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
                        )}
                    </div>
                </aside>
            </div>

            {/* Settings Overlay - Compact */}
            {showSettings && (
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
                        </div>
                    </div>
                </div>
            )}

            <style jsx global>{`
                .custom-scrollbar::-webkit-scrollbar { width: 3px; }
                .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
                .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.05); border-radius: 10px; }
                .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.1); }
            `}</style>
        </main>
    );
}
