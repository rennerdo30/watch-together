"use client";

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
    Loader2, Users, Link as LinkIcon,
    Plus, Trash2, SkipForward,
    Play, ListVideo, Settings, X, Palette, ShieldCheck, Home, GripVertical, Pin, Bug,
    Crown, Shield, User as UserIcon, ChevronUp, ChevronDown, Lock, Copy, Check, Infinity
} from 'lucide-react';
import { ResolveResponse, resolveUrl, getExtensionToken, regenerateExtensionToken, ExtensionToken } from '@/lib/api';
import { CustomPlayer } from '@/components/custom-player';
import { ErrorBoundary } from '@/components/error-boundary';
import { THEMES, DEFAULT_THEME, type Theme, getThemeById, loadCustomTheme, saveCustomTheme, createCustomTheme } from '@/lib/themes';
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

interface RoomPlayer {
    play: () => Promise<void> | void;
    pause: () => void;
    currentTime: (time?: number) => number;
    getDuration: () => number;
    setVolume: (val: number) => void;
    getVideoElement: () => HTMLVideoElement | null;
}

type WsPayload = {
    video_data?: ResolveResponse;
    members?: { email: string }[];
    queue?: ResolveResponse[];
    roles?: Record<string, string>;
    your_email?: string;
    playing_index?: number;
    permanent?: boolean;
    is_playing?: boolean;
    timestamp?: number;
    client_time?: number;
    [key: string]: unknown;
};

interface WsMessage {
    type: string;
    payload?: WsPayload;
}

const getErrorMessage = (error: unknown, fallback: string): string => {
    if (error instanceof Error) return error.message;
    return fallback;
};

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
    const [actualPlayerTime, setActualPlayerTime] = useState(0); // Real player time for badge display
    const [isPermanent, setIsPermanent] = useState(false); // Room permanent status

    // Layout resizing
    const [sidebarWidth, setSidebarWidth] = useState(320); // Default width
    const isResizing = useRef(false);
    const [fontSize, setFontSize] = useState(15);
    const [cookieContent, setCookieContent] = useState('');
    const [isSavingCookies, setIsSavingCookies] = useState(false);
    const [isLoadingCookies, setIsLoadingCookies] = useState(true);
    const [isCopyingDebug, setIsCopyingDebug] = useState(false);

    // Extension token state
    const [extensionToken, setExtensionToken] = useState<ExtensionToken | null>(null);
    const [isLoadingToken, setIsLoadingToken] = useState(false);
    const [isRegeneratingToken, setIsRegeneratingToken] = useState(false);
    const [isCopyingToken, setIsCopyingToken] = useState(false);

    // Custom theme state
    const [customBgColor, setCustomBgColor] = useState('#09090b');
    const [customAccentColor, setCustomAccentColor] = useState('#8b5cf6');
    const [showCustomTheme, setShowCustomTheme] = useState(false);

    // DnD Sensors - require a small movement before dragging to allow clicks
    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: {
                distance: 8, // 8px movement required before drag starts
            },
        }),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        })
    );
    const [activeDragId, setActiveDragId] = useState<string | null>(null);

    // WS & Player Refs
    const wsRef = useRef<WebSocket | null>(null);
    const playerRef = useRef<RoomPlayer | null>(null);
    const internalUpdateCount = useRef(0); // Counter to prevent feedback loops during sync
    const reconnectTimer = useRef<NodeJS.Timeout | null>(null);

    // Latency tracking for sync compensation
    const latencyRef = useRef<number>(0); // Average latency in ms
    const pingIntervalRef = useRef<NodeJS.Timeout | null>(null);
    const videoElementRef = useRef<HTMLVideoElement | null>(null);

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

    // Stable resize handlers stored once in refs to avoid listener identity issues
    const sidebarWidthRef = useRef(sidebarWidth);
    useEffect(() => { sidebarWidthRef.current = sidebarWidth; }, [sidebarWidth]);

    const handleMouseMove = useCallback((e: MouseEvent) => {
        if (!isResizing.current) return;
        const width = window.innerWidth - e.clientX;
        if (width >= 240 && width <= 600) {
            setSidebarWidth(width);
        }
    }, []);

    const stopResizing = useCallback(() => {
        isResizing.current = false;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', stopResizing);
        document.body.style.cursor = 'default';
        localStorage.setItem('wt_sidebar_width', sidebarWidthRef.current.toString());
    }, [handleMouseMove]);

    const startResizing = useCallback((e: React.MouseEvent) => {
        isResizing.current = true;
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', stopResizing);
        document.body.style.cursor = 'col-resize';
    }, [handleMouseMove, stopResizing]);

    // Cleanup resize listeners on unmount to prevent leaks
    useEffect(() => {
        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', stopResizing);
        };
    }, [handleMouseMove, stopResizing]);

    const handleDragStart = (event: DragStartEvent) => {
        setActiveDragId(event.active.id as string);
    };

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;

        if (over && active.id !== over.id) {
            const oldIndex = queue.findIndex((item) => item.original_url === active.id);
            const newIndex = queue.findIndex((item) => item.original_url === over.id);

            // Optimistic update for smoother UX
            setQueue((items) => arrayMove(items, oldIndex, newIndex));

            // Send reorder to server (server will broadcast queue_update)
            sendMsg('queue_reorder', { old_index: oldIndex, new_index: newIndex });
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
        if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);

        const ws = new WebSocket(url);
        wsRef.current = ws;

        ws.onopen = () => {
            setConnected(true);
            if (reconnectTimer.current) clearTimeout(reconnectTimer.current);

            // Start ping interval for latency measurement
            pingIntervalRef.current = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'ping', payload: { client_time: performance.now() } }));
                }
            }, 5000); // Ping every 5 seconds

            // Send initial ping
            ws.send(JSON.stringify({ type: 'ping', payload: { client_time: performance.now() } }));
        };
        ws.onmessage = (event) => {
            try { handleWsMessage(JSON.parse(event.data)); }
            catch (e) { console.error("Failed to parse WS message", e); }
        };
        ws.onclose = () => {
            setConnected(false);
            if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
            reconnectTimer.current = setTimeout(connect, 3000);
        };
        ws.onerror = () => ws.close();
    };

    useEffect(() => {
        connect();
        const savedTheme = localStorage.getItem('wt_theme');
        if (savedTheme) {
            if (savedTheme === 'custom') {
                const customTheme = loadCustomTheme();
                if (customTheme) {
                    setActiveTheme(customTheme);
                    setCustomBgColor(customTheme.colors.bg);
                    setCustomAccentColor(customTheme.colors.accent);
                    setShowCustomTheme(true);
                }
            } else {
                const t = getThemeById(savedTheme);
                if (t) setActiveTheme(t);
            }
        }
        const savedProxy = localStorage.getItem('wt_proxy');
        if (savedProxy !== null) {
            setUseProxy(savedProxy === 'true');
        } else {
            setUseProxy(true); // Default to true
        }
        // Load saved sidebar width
        const savedWidth = localStorage.getItem('wt_sidebar_width');
        if (savedWidth) {
            const width = parseInt(savedWidth);
            if (width >= 240 && width <= 600) setSidebarWidth(width);
        }

        return () => {
            if (wsRef.current) wsRef.current.close();
            if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
        };
    }, [roomId]);

    // Load saved cookies when user is available
    useEffect(() => {
        const loadCookies = async () => {
            if (!currentUser || currentUser === 'Guest') {
                setIsLoadingCookies(false);
                return;
            }
            try {
                const searchParams = new URLSearchParams(window.location.search);
                const mockUser = searchParams.get('user');
                const userParam = mockUser ? `?user=${encodeURIComponent(mockUser)}` : '';

                const res = await fetch(`/api/cookies${userParam}`);
                if (res.ok) {
                    const data = await res.json();
                    if (data.has_cookies && data.content) {
                        setCookieContent(data.content);
                    }
                }
            } catch (err) {
                console.error('Failed to load cookies:', err);
            } finally {
                setIsLoadingCookies(false);
            }
        };
        loadCookies();
    }, [currentUser]);

    // Load extension token when settings are opened
    useEffect(() => {
        const loadToken = async () => {
            if (!showSettings || !currentUser || currentUser === 'Guest') return;
            setIsLoadingToken(true);
            try {
                const response = await getExtensionToken();
                setExtensionToken(response.token);
            } catch (err) {
                console.error('Failed to load extension token:', err);
            } finally {
                setIsLoadingToken(false);
            }
        };
        loadToken();
    }, [showSettings, currentUser]);

    // Note: We no longer need a local ticker for syncState.timestamp
    // The badge now uses actualPlayerTime which is updated via onTimeUpdate

    const handleWsMessage = (msg: WsMessage) => {
        const type = msg.type;
        const payload = msg.payload ?? {};
        internalUpdateCount.current += 1; // Increment counter to block local events

        switch (type) {
            case 'sync':
                // On sync (initial load or reconnect), set video data and re-resolve for fresh DASH URLs
                if (payload.video_data) {
                    const syncVideoData = payload.video_data;
                    const isSameVideo = videoData?.original_url === syncVideoData.original_url;

                    if (!videoData || !isSameVideo) {
                        // New video or first load: Re-resolve for fresh stream URLs
                        if (syncVideoData.original_url) {
                            console.log('[Room] Sync: Re-resolving video for fresh stream URLs...');
                            resolveUrl(syncVideoData.original_url)
                                .then((freshData) => {
                                    console.log('[Room] Sync: Got fresh stream:', freshData.stream_type, freshData.quality);
                                    setVideoData(freshData);
                                })
                                .catch((err) => {
                                    console.warn('[Room] Sync: Re-resolve failed, using cached data:', err.message);
                                    setVideoData(syncVideoData);
                                });
                        } else {
                            setVideoData(syncVideoData);
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
                if (typeof payload.permanent === 'boolean') setIsPermanent(payload.permanent);

                if (playerRef.current && payload.video_data) {
                    const serverTimestamp = typeof payload.timestamp === 'number' ? payload.timestamp : 0;
                    if (payload.is_playing) Promise.resolve(playerRef.current.play?.()).catch(() => { });
                    else playerRef.current.pause?.();

                    const isLive = payload.video_data.is_live;
                    if (isLive && serverTimestamp === 0) {
                        // Stay at live edge
                    } else if (playerRef.current) {
                        const playerTime = playerRef.current.currentTime();
                        const diff = Math.abs(playerTime - serverTimestamp);
                        if (diff > syncThresholdRef.current) playerRef.current.currentTime(serverTimestamp);
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
                    const queuedVideoData = payload.video_data;
                    console.log('[Room] Re-resolving video for fresh stream URLs...');
                    // Show cached data immediately as placeholder
                    setVideoData(queuedVideoData);

                    resolveUrl(queuedVideoData.original_url)
                        .then((freshData) => {
                            console.log('[Room] Got fresh stream:', freshData.stream_type, freshData.quality);
                            setVideoData(freshData);
                        })
                        .catch((err) => {
                            console.warn('[Room] Re-resolve failed:', err.message);
                            // Keep showing cached data, might still work if not expired
                        });
                } else if (payload.video_data) {
                    setVideoData(payload.video_data);
                }
                break;
            case 'play':
                if (playerRef.current) {
                    const serverTimestamp = typeof payload.timestamp === 'number' ? payload.timestamp : 0;
                    if (!(payload.video_data?.is_live && serverTimestamp === 0)) {
                        playerRef.current.currentTime(serverTimestamp);
                    }
                    playerRef.current.play();
                }
                break;
            case 'pause':
                if (playerRef.current) {
                    const serverTimestamp = typeof payload.timestamp === 'number' ? payload.timestamp : 0;
                    playerRef.current.pause();
                    if (!(payload.video_data?.is_live && serverTimestamp === 0)) {
                        playerRef.current.currentTime(serverTimestamp);
                    }
                }
                break;
            case 'seek':
                // Intentional seek - always hard jump
                if (playerRef.current && typeof payload.timestamp === 'number') {
                    playerRef.current.currentTime(payload.timestamp);
                }
                // Reset playback rate after seek
                const seekVideo = playerRef.current?.getVideoElement?.();
                if (seekVideo) seekVideo.playbackRate = 1.0;
                break;
            case 'queue_update':
                if (payload.queue) setQueue(payload.queue);
                if (typeof payload.playing_index === 'number') setPlayingIndex(payload.playing_index);
                break;
            case 'roles_update':
                if (payload.roles) setRoles(payload.roles);
                break;
            case 'room_settings_update':
                if (typeof payload.permanent === 'boolean') setIsPermanent(payload.permanent);
                break;
            case 'pong':
                // Calculate round-trip latency
                if (payload.client_time) {
                    const rtt = performance.now() - payload.client_time;
                    // Use exponential moving average for smooth latency tracking
                    latencyRef.current = latencyRef.current === 0
                        ? rtt / 2
                        : latencyRef.current * 0.8 + (rtt / 2) * 0.2;
                }
                break;
            case 'heartbeat':
                // Gradual sync - adjust playback rate instead of jumping for small drifts
                if (playerRef.current && payload.is_playing && typeof payload.timestamp === 'number') {
                    const currentTime = playerRef.current.currentTime();
                    // Compensate for latency (one-way delay)
                    const compensatedTimestamp = payload.timestamp + (latencyRef.current / 1000);
                    const drift = compensatedTimestamp - currentTime;

                    const video = playerRef.current.getVideoElement?.();
                    if (video) {
                        if (Math.abs(drift) > 3) {
                            // Large drift - hard seek
                            playerRef.current.currentTime(compensatedTimestamp);
                            video.playbackRate = 1.0;
                        } else if (drift > 0.5) {
                            // We're behind - speed up slightly
                            video.playbackRate = 1.05;
                        } else if (drift < -0.5) {
                            // We're ahead - slow down slightly
                            video.playbackRate = 0.95;
                        } else {
                            // We're synced - normal speed
                            video.playbackRate = 1.0;
                        }
                    }

                    // Update sync state display
                    setSyncState(prev => ({
                        ...prev,
                        timestamp: compensatedTimestamp,
                        lastSync: new Date().toLocaleTimeString()
                    }));
                }
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

    const sendMsg = (type: string, payload?: unknown) => {
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
        } catch (err: unknown) {
            console.error(err);
            toast.error(getErrorMessage(err, 'Failed to resolve video'));
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
        } catch (err: unknown) {
            console.error(err);
            toast.error(getErrorMessage(err, 'Failed to resolve video'));
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
            {/* Header */}
            <header className={`h-12 border-b ${activeTheme.border} flex items-center px-3 shrink-0 ${activeTheme.header} backdrop-blur-md z-50`}>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => router.push('/')}
                        className="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 flex items-center justify-center transition-colors border border-white/5"
                    >
                        <Home className="w-4 h-4 text-neutral-400" />
                    </button>
                    <div className="flex flex-col pl-1">
                        <h1 className="font-bold text-white leading-none text-sm normal-case tracking-normal">Watch Together</h1>
                        <div className="flex items-center gap-1.5 mt-0.5">
                            <span className="font-medium text-neutral-500 text-xs normal-case">{roomId}</span>
                            <div className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-emerald-500" : "bg-red-500 animate-pulse"}`} />
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
                                {Math.floor(actualPlayerTime / 60)}:{Math.floor(actualPlayerTime % 60).toString().padStart(2, '0')}
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
                                    autoPlay={syncState.isPlaying}
                                    initialTime={syncState.timestamp} // Pass initial sync timestamp
                                    // DASH-specific props
                                    streamType={videoData.stream_type}
                                    videoUrl={getDashUrls()?.videoUrl}
                                    audioUrl={getDashUrls()?.audioUrl}
                                    availableQualities={getDashUrls()?.availableQualities}
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
                                    onTimeUpdate={(time: number, isPlaying: boolean) => {
                                        // Update actual player time for accurate badge display
                                        setActualPlayerTime(time);
                                        setSyncState(prev => ({ ...prev, isPlaying }));
                                    }}
                                    onQualityChangeNotify={(oldVideoUrl, newVideoUrl, audioUrl) => {
                                        // Notify backend for prefetch optimization
                                        sendMsg('quality_change', {
                                            old_video_url: oldVideoUrl,
                                            new_video_url: newVideoUrl,
                                            audio_url: audioUrl,
                                        });
                                    }}
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
                                    <div className="flex-1 overflow-y-auto p-2 space-y-1 custom-scrollbar">
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

            {/* Settings Overlay */}
            {
                showSettings && (
                    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
                        <div className="absolute inset-0 bg-black/90 backdrop-blur-sm" onClick={() => setShowSettings(false)} />
                        <div className="relative w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden shadow-2xl max-h-[90vh] flex flex-col">
                            <div className="p-5 border-b border-zinc-800 flex items-center justify-between shrink-0">
                                <h2 className="text-base font-semibold text-white">Settings</h2>
                                <button onClick={() => setShowSettings(false)} className="text-zinc-500 hover:text-white transition-colors p-1 rounded-lg hover:bg-white/5">
                                    <X className="w-5 h-5" />
                                </button>
                            </div>


                            <div className="p-5 space-y-6 overflow-y-auto flex-1">
                                {/* Permanent Room Toggle - Admin Only */}
                                {roles[currentUser] === 'admin' && (
                                    <button
                                        onClick={() => sendMsg('toggle_permanent', {})}
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
                                                onClick={() => { setActiveTheme(t); localStorage.setItem('wt_theme', t.id); setShowCustomTheme(false); }}
                                                className={`p-3 rounded-xl border text-xs font-medium transition-all ${activeTheme.id === t.id && !showCustomTheme
                                                    ? "bg-white/10 border-white/20 text-white"
                                                    : "bg-white/5 border-white/5 text-zinc-500 hover:border-white/10 hover:text-zinc-300"
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
                                            ? "bg-violet-500/10 border-violet-500/20 text-violet-400"
                                            : "bg-white/5 border-white/5 text-zinc-500 hover:border-white/10"
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
                                                onClick={() => {
                                                    const custom = createCustomTheme('Custom', customBgColor, customAccentColor);
                                                    setActiveTheme(custom);
                                                    saveCustomTheme(custom);
                                                    localStorage.setItem('wt_theme', 'custom');
                                                    toast.success('Custom theme applied!');
                                                }}
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
                                    onClick={() => { const v = !useProxy; setUseProxy(v); localStorage.setItem('wt_proxy', String(v)); }}
                                    className={`w-full p-4 rounded-xl border flex items-center justify-between transition-all ${useProxy ? "bg-violet-500/10 border-violet-500/20" : "bg-zinc-800/30 border-zinc-800"
                                        }`}
                                >
                                    <div className="text-left">
                                        <span className="font-medium text-white text-sm">Proxy Mode</span>
                                        <p className="text-xs text-zinc-500 mt-0.5">Bypass regional restrictions</p>
                                    </div>
                                    <div className={`w-10 h-5 rounded-full transition-all flex items-center px-0.5 ${useProxy ? "bg-violet-500" : "bg-zinc-700"}`}>
                                        <div className={`w-4 h-4 bg-white rounded-full transition-all shadow-sm ${useProxy ? "translate-x-5" : "translate-x-0"}`} />
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
                                            placeholder={isLoadingCookies ? "Loading saved cookies..." : "# Netscape HTTP Cookie File..."}
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
                                                        toast.success("Cookies saved!");
                                                        setCookieContent('');
                                                    } catch (err: unknown) {
                                                        toast.error(getErrorMessage(err, "Failed to save cookies"));
                                                    } finally {
                                                        setIsSavingCookies(false);
                                                    }
                                                }}
                                                disabled={isSavingCookies || !cookieContent || !currentUser || currentUser === 'Guest'}
                                                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                            >
                                                {isSavingCookies ? "Saving..." : "Save Cookies"}
                                            </button>
                                        </div>
                                    </div>
                                </div>

                                {/* Browser Extension */}
                                <div className="pt-4 border-t border-zinc-800">
                                    <label className="text-xs font-medium text-zinc-400 flex items-center gap-2 mb-3">
                                        <LinkIcon className="w-4 h-4" /> Browser Extension
                                    </label>
                                    <div className="bg-zinc-800/30 rounded-xl border border-zinc-800 p-4 space-y-4">
                                        <p className="text-xs text-zinc-400 leading-relaxed">
                                            Install the browser extension to automatically sync cookies from YouTube, Twitch, and other sites.
                                        </p>

                                        {/* API Token */}
                                        {currentUser && currentUser !== 'Guest' && (
                                            <div className="space-y-2">
                                                <div className="flex items-center justify-between">
                                                    <span className="text-[10px] text-zinc-500 uppercase font-medium">API Token</span>
                                                    {extensionToken?.last_sync_at && (
                                                        <span className="text-[10px] text-zinc-500">
                                                            Last sync: {new Date(extensionToken.last_sync_at * 1000).toLocaleString()}
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    <div className="flex-1 h-9 bg-zinc-900 border border-zinc-700 rounded-lg px-3 flex items-center">
                                                        {isLoadingToken ? (
                                                            <span className="text-xs text-zinc-500">Loading...</span>
                                                        ) : extensionToken ? (
                                                            <code className="text-[11px] font-mono text-zinc-300 truncate">
                                                                {extensionToken.id.slice(0, 20)}...
                                                            </code>
                                                        ) : (
                                                            <span className="text-xs text-zinc-500">No token</span>
                                                        )}
                                                    </div>
                                                    <button
                                                        onClick={() => {
                                                            if (extensionToken) {
                                                                navigator.clipboard.writeText(extensionToken.id);
                                                                setIsCopyingToken(true);
                                                                setTimeout(() => setIsCopyingToken(false), 2000);
                                                                toast.success('Token copied!');
                                                            }
                                                        }}
                                                        disabled={!extensionToken}
                                                        className="h-9 px-3 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg text-zinc-400 hover:text-white transition-colors disabled:opacity-50"
                                                        title="Copy token"
                                                    >
                                                        {isCopyingToken ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                                                    </button>
                                                    <button
                                                        onClick={async () => {
                                                            setIsRegeneratingToken(true);
                                                            try {
                                                                const response = await regenerateExtensionToken();
                                                                setExtensionToken(response.token);
                                                                toast.success('Token regenerated!');
                                                            } catch (err: unknown) {
                                                                toast.error(getErrorMessage(err, 'Failed to regenerate'));
                                                            } finally {
                                                                setIsRegeneratingToken(false);
                                                            }
                                                        }}
                                                        disabled={isRegeneratingToken}
                                                        className="h-9 px-3 bg-amber-600/20 hover:bg-amber-600/30 border border-amber-600/30 rounded-lg text-amber-400 hover:text-amber-300 text-xs font-medium transition-colors disabled:opacity-50"
                                                    >
                                                        {isRegeneratingToken ? 'Regenerating...' : 'Regenerate'}
                                                    </button>
                                                </div>
                                                {extensionToken && extensionToken.sync_count > 0 && (
                                                    <div className="text-[10px] text-zinc-500">
                                                        Synced {extensionToken.sync_count} time{extensionToken.sync_count !== 1 ? 's' : ''}
                                                    </div>
                                                )}
                                            </div>
                                        )}

                                        {/* Download Links */}
                                        <div className="space-y-2">
                                            <span className="text-[10px] text-zinc-500 uppercase font-medium">Install Extension</span>
                                            <div className="grid grid-cols-2 gap-2">
                                                <a
                                                    href="/extension/chrome"
                                                    className="flex items-center justify-center gap-2 h-10 bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 rounded-lg text-xs font-medium text-zinc-300 hover:text-white transition-colors"
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                >
                                                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                                                        <path d="M12 0C8.21 0 4.831 1.757 2.632 4.501l3.953 6.848A5.454 5.454 0 0 1 12 6.545h10.691A12 12 0 0 0 12 0zM1.931 5.47A11.943 11.943 0 0 0 0 12c0 6.012 4.42 10.991 10.189 11.864l3.953-6.847a5.45 5.45 0 0 1-6.865-2.29zm13.342 2.166a5.446 5.446 0 0 1 1.45 7.09l.002.001h-.002l-5.344 9.257c.206.01.413.016.621.016 6.627 0 12-5.373 12-12 0-1.54-.29-3.011-.818-4.364zM12 16.364a4.364 4.364 0 1 1 0-8.728 4.364 4.364 0 0 1 0 8.728z"/>
                                                    </svg>
                                                    Chrome / Edge
                                                </a>
                                                <a
                                                    href="/extension/firefox"
                                                    className="flex items-center justify-center gap-2 h-10 bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 rounded-lg text-xs font-medium text-zinc-300 hover:text-white transition-colors"
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                >
                                                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                                                        <path d="M8.824 7.287c.008 0 .004 0 0 0zm-2.8-1.4c.006 0 .003 0 0 0zm16.754 2.161c-.505-1.215-1.53-2.528-2.333-2.943.654 1.283 1.033 2.57 1.177 3.53l.002.02c-1.314-3.278-3.544-4.6-5.366-7.477-.096-.147-.19-.3-.283-.453a3.95 3.95 0 0 1-.145-.282 2.421 2.421 0 0 1-.159-.402c-.002-.012-.003-.024-.005-.036-.009-.064-.015-.13-.019-.195a1.085 1.085 0 0 1 .014-.579.027.027 0 0 0-.02-.03.02.02 0 0 0-.015.001l-.016.007c-.03.017-.06.033-.09.051l-.046.027-.038.023a7.14 7.14 0 0 0-.97.713c-.296.25-.58.522-.85.817a9.28 9.28 0 0 0-.78.914 9.887 9.887 0 0 0-.936 1.467 12.095 12.095 0 0 0-1.265 3.486l-.101.496-.013.072-.074.443c-.03.188-.054.38-.075.572l-.027.293-.029.343-.035.568-.013.634c0 .207.003.414.01.62.032.98.174 1.943.422 2.875.164.612.371 1.21.62 1.787a11.929 11.929 0 0 0 5.217 5.478c.173.093.345.185.52.27l.098.047c.296.142.597.275.904.395l.006.002c.216.082.435.16.658.23l.182.059.249.072.252.068.23.057.256.056.223.046.258.05.218.039.262.039.219.031.262.03.222.024.262.02.224.016.264.011.224.009.266.003.221.002c.176-.001.352-.01.527-.023l.128-.014.182-.015.24-.035.135-.018.22-.044.122-.025.228-.059.109-.028.237-.078.093-.031.252-.1.072-.03.268-.125.05-.023.282-.155.026-.016.27-.175.009-.007a6.947 6.947 0 0 0 .532-.42l.029-.026c.08-.072.157-.147.232-.224l.058-.06.19-.215.071-.088.156-.21.083-.121.13-.211.08-.141.108-.21.068-.144.091-.217.055-.143.079-.236.044-.145.066-.26.03-.138.049-.293.019-.125.031-.328.009-.116.012-.386v-.035a8.102 8.102 0 0 0-.115-1.275l-.039-.195a7.63 7.63 0 0 0-.14-.59l-.062-.203a7.094 7.094 0 0 0-.218-.606l-.063-.148a6.77 6.77 0 0 0-.308-.6 6.05 6.05 0 0 0-.393-.584 6.25 6.25 0 0 0-.142-.18 6.37 6.37 0 0 0-.148-.177 5.83 5.83 0 0 0-.311-.337 5.6 5.6 0 0 0-.325-.306 5.434 5.434 0 0 0-.168-.143 5.138 5.138 0 0 0-.351-.266 5.116 5.116 0 0 0-.177-.12 5.023 5.023 0 0 0-.367-.219 5.1 5.1 0 0 0-.181-.096c-.124-.062-.251-.12-.379-.173a4.987 4.987 0 0 0-.183-.074 5.104 5.104 0 0 0-.39-.134 5.08 5.08 0 0 0-.181-.054 5.115 5.115 0 0 0-.4-.095 5.156 5.156 0 0 0-.175-.033 5.297 5.297 0 0 0-.411-.055 5.48 5.48 0 0 0-.166-.015 5.718 5.718 0 0 0-.423-.019c-.052 0-.104-.002-.156 0a6.076 6.076 0 0 0-.437.018c-.046.002-.092.008-.138.012a6.449 6.449 0 0 0-.45.057c-.04.006-.08.016-.12.023a6.901 6.901 0 0 0-.46.106c-.034.01-.069.021-.103.031a7.397 7.397 0 0 0-.468.16c-.027.01-.055.022-.082.033a7.921 7.921 0 0 0-.475.219c-.021.01-.042.022-.063.033a8.498 8.498 0 0 0-.481.28c-.016.01-.032.022-.048.032a9.117 9.117 0 0 0-.485.345c-.01.008-.02.017-.03.025a9.776 9.776 0 0 0-.488.412c-.006.005-.012.012-.018.017a10.494 10.494 0 0 0-.49.483l-.007.007a11.28 11.28 0 0 0-.49.557v.001a12.157 12.157 0 0 0-.49.636 13.18 13.18 0 0 0-.487.72l-.003.004a14.382 14.382 0 0 0-.482.809 15.927 15.927 0 0 0-.474.902c-.152.32-.303.644-.453.971a18.933 18.933 0 0 0-.444 1.044c-.136.357-.27.717-.401 1.08a20.58 20.58 0 0 0-.375 1.128c-.109.37-.215.743-.316 1.118-.092.34-.18.683-.264 1.026-.076.31-.148.621-.217.933-.063.285-.124.571-.18.857-.052.263-.1.527-.146.79-.042.24-.082.48-.118.72-.034.224-.064.449-.092.673-.026.21-.05.42-.072.63-.02.198-.038.396-.053.593-.014.187-.027.373-.037.559-.01.177-.016.353-.022.528-.005.167-.009.333-.01.498-.001.159 0 .316.002.474.002.152.008.304.015.455.007.146.017.291.029.436.012.14.027.28.044.418.018.135.038.269.061.402.024.131.05.26.08.389.031.127.065.252.102.376.04.122.082.242.128.361.049.118.101.233.157.347.06.113.122.222.19.33.07.107.145.21.224.31.084.103.172.2.265.295.1.099.205.19.316.278.12.094.245.18.377.26.145.087.296.163.455.231.178.074.364.133.557.177.221.05.45.078.686.085a3.78 3.78 0 0 0 .736-.047c.284-.047.57-.127.852-.24.325-.13.645-.304.952-.52.355-.25.693-.554 1.003-.91.346-.398.654-.862.91-1.393.283-.585.5-1.252.634-2.002.147-.828.193-1.754.127-2.766-.073-1.108-.28-2.312-.647-3.606-.406-1.429-.999-2.96-1.823-4.595-.912-1.812-2.095-3.748-3.623-5.809-1.688-2.277-3.757-4.702-6.313-7.281z"/>
                                                    </svg>
                                                    Firefox
                                                </a>
                                                <a
                                                    href="/extension/safari"
                                                    className="flex items-center justify-center gap-2 h-10 bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 rounded-lg text-xs font-medium text-zinc-300 hover:text-white transition-colors"
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                >
                                                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                                                        <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm0 1.5c5.799 0 10.5 4.701 10.5 10.5S17.799 22.5 12 22.5 1.5 17.799 1.5 12 6.201 1.5 12 1.5zm0 1.5a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm4.5 4.5l-6 3-3 6 6-3 3-6zm-4.5 3.75a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5z"/>
                                                    </svg>
                                                    Safari
                                                </a>
                                                <a
                                                    href="https://github.com/yourusername/watch-together-extension"
                                                    className="flex items-center justify-center gap-2 h-10 bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 rounded-lg text-xs font-medium text-zinc-300 hover:text-white transition-colors"
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                >
                                                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                                                        <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/>
                                                    </svg>
                                                    Source Code
                                                </a>
                                            </div>
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
