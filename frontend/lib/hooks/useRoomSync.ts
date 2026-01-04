/**
 * useRoomSync - WebSocket synchronization hook for Watch Together rooms
 * 
 * Handles:
 * - WebSocket connection management
 * - Latency measurement via ping/pong
 * - Message sending and receiving
 * - Auto-reconnection
 */

import { useRef, useEffect, useCallback, useState } from 'react';
import { ResolveResponse, resolveUrl } from '@/lib/api';

// Message types from server
export type RoomMessageType =
    | 'sync'
    | 'user_joined'
    | 'user_left'
    | 'set_video'
    | 'play'
    | 'pause'
    | 'seek'
    | 'queue_update'
    | 'roles_update'
    | 'pong'
    | 'heartbeat';

export interface RoomState {
    videoData: ResolveResponse | null;
    queue: ResolveResponse[];
    playingIndex: number;
    members: { email: string }[];
    roles: Record<string, string>;
    currentUser: string;
    isPlaying: boolean;
    timestamp: number;
}

export interface SyncInfo {
    isPlaying: boolean;
    timestamp: number;
    lastSync: string;
    latency: number;
}

export interface UseRoomSyncOptions {
    roomId: string;
    playerRef: React.MutableRefObject<any>;
    syncThreshold: number;
    onVideoChange?: (videoData: ResolveResponse) => void;
}

export interface UseRoomSyncReturn {
    // State
    connected: boolean;
    roomState: RoomState;
    syncInfo: SyncInfo;
    loadingQueueIndex: number | null;

    // Actions  
    sendMessage: (type: string, payload?: any) => void;
    setLoadingQueueIndex: (index: number | null) => void;
}

function getWsUrl(roomId: string) {
    if (typeof window === 'undefined') return '';
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    return `${protocol}//${host}/ws/${roomId}`;
}

export function useRoomSync({
    roomId,
    playerRef,
    syncThreshold,
    onVideoChange,
}: UseRoomSyncOptions): UseRoomSyncReturn {
    // Connection state
    const [connected, setConnected] = useState(false);
    const wsRef = useRef<WebSocket | null>(null);
    const reconnectTimer = useRef<NodeJS.Timeout | null>(null);
    const pingIntervalRef = useRef<NodeJS.Timeout | null>(null);

    // Latency tracking
    const latencyRef = useRef<number>(0);

    // Internal update counter to prevent feedback loops
    const internalUpdateCount = useRef(0);

    // Sync threshold ref for access in callbacks
    const syncThresholdRef = useRef(syncThreshold);
    useEffect(() => { syncThresholdRef.current = syncThreshold; }, [syncThreshold]);

    // Room state
    const [roomState, setRoomState] = useState<RoomState>({
        videoData: null,
        queue: [],
        playingIndex: -1,
        members: [],
        roles: {},
        currentUser: '',
        isPlaying: false,
        timestamp: 0,
    });

    const [syncInfo, setSyncInfo] = useState<SyncInfo>({
        isPlaying: false,
        timestamp: 0,
        lastSync: '',
        latency: 0,
    });

    const [loadingQueueIndex, setLoadingQueueIndex] = useState<number | null>(null);

    // Message handler
    const handleMessage = useCallback((msg: { type: string; payload: any }) => {
        const { type, payload } = msg;
        internalUpdateCount.current += 1;

        switch (type) {
            case 'sync':
                // Initial sync or reconnect
                if (payload.video_data) {
                    const currentVideoUrl = roomState.videoData?.original_url;
                    const newVideoUrl = payload.video_data.original_url;

                    if (!currentVideoUrl || currentVideoUrl !== newVideoUrl) {
                        // Re-resolve for fresh URLs
                        if (newVideoUrl) {
                            resolveUrl(newVideoUrl)
                                .then((freshData) => {
                                    setRoomState(prev => ({ ...prev, videoData: freshData }));
                                    onVideoChange?.(freshData);
                                })
                                .catch(() => {
                                    setRoomState(prev => ({ ...prev, videoData: payload.video_data }));
                                });
                        } else {
                            setRoomState(prev => ({ ...prev, videoData: payload.video_data }));
                        }
                    }
                }

                setRoomState(prev => ({
                    ...prev,
                    members: payload.members ?? prev.members,
                    queue: payload.queue ?? prev.queue,
                    roles: payload.roles ?? prev.roles,
                    currentUser: payload.your_email ?? prev.currentUser,
                    playingIndex: payload.playing_index ?? prev.playingIndex,
                    isPlaying: payload.is_playing ?? prev.isPlaying,
                    timestamp: payload.timestamp ?? prev.timestamp,
                }));

                // Sync player state
                if (playerRef.current && payload.video_data) {
                    if (payload.is_playing) playerRef.current.play?.().catch(() => { });
                    else playerRef.current.pause?.();

                    const isLive = payload.video_data.is_live;
                    if (!isLive || payload.timestamp !== 0) {
                        const playerTime = playerRef.current.currentTime?.() ?? 0;
                        const diff = Math.abs(playerTime - payload.timestamp);
                        if (diff > syncThresholdRef.current) {
                            playerRef.current.currentTime?.(payload.timestamp);
                        }
                    }
                }
                break;

            case 'user_joined':
            case 'user_left':
                if (payload.members) {
                    setRoomState(prev => ({ ...prev, members: payload.members }));
                }
                break;

            case 'set_video':
                setLoadingQueueIndex(null);
                setSyncInfo(prev => ({ ...prev, timestamp: 0, isPlaying: true }));

                if (payload.video_data?.original_url) {
                    setRoomState(prev => ({ ...prev, videoData: payload.video_data }));

                    resolveUrl(payload.video_data.original_url)
                        .then((freshData) => {
                            setRoomState(prev => ({ ...prev, videoData: freshData }));
                            onVideoChange?.(freshData);
                        })
                        .catch(() => { });
                } else {
                    setRoomState(prev => ({ ...prev, videoData: payload.video_data }));
                }
                break;

            case 'play':
                if (playerRef.current) {
                    if (!(payload.video_data?.is_live && payload.timestamp === 0)) {
                        playerRef.current.currentTime?.(payload.timestamp);
                    }
                    playerRef.current.play?.();
                }
                setRoomState(prev => ({ ...prev, isPlaying: true }));
                break;

            case 'pause':
                if (playerRef.current) {
                    playerRef.current.pause?.();
                    if (!(payload.video_data?.is_live && payload.timestamp === 0)) {
                        playerRef.current.currentTime?.(payload.timestamp);
                    }
                }
                setRoomState(prev => ({ ...prev, isPlaying: false }));
                break;

            case 'seek':
                if (playerRef.current) {
                    playerRef.current.currentTime?.(payload.timestamp);
                    const video = playerRef.current.getVideoElement?.();
                    if (video) video.playbackRate = 1.0;
                }
                break;

            case 'queue_update':
                setRoomState(prev => ({
                    ...prev,
                    queue: payload.queue,
                    playingIndex: payload.playing_index ?? prev.playingIndex,
                }));
                break;

            case 'roles_update':
                if (payload.roles) {
                    setRoomState(prev => ({ ...prev, roles: payload.roles }));
                }
                break;

            case 'pong':
                if (payload.client_time) {
                    const rtt = performance.now() - payload.client_time;
                    latencyRef.current = latencyRef.current === 0
                        ? rtt / 2
                        : latencyRef.current * 0.8 + (rtt / 2) * 0.2;
                    setSyncInfo(prev => ({ ...prev, latency: latencyRef.current }));
                }
                break;

            case 'heartbeat':
                if (playerRef.current && payload.is_playing && payload.timestamp !== undefined) {
                    const currentTime = playerRef.current.currentTime?.() ?? 0;
                    const compensatedTimestamp = payload.timestamp + (latencyRef.current / 1000);
                    const drift = compensatedTimestamp - currentTime;

                    const video = playerRef.current.getVideoElement?.();
                    if (video) {
                        if (Math.abs(drift) > 3) {
                            playerRef.current.currentTime?.(compensatedTimestamp);
                            video.playbackRate = 1.0;
                        } else if (drift > 0.5) {
                            video.playbackRate = 1.05;
                        } else if (drift < -0.5) {
                            video.playbackRate = 0.95;
                        } else {
                            video.playbackRate = 1.0;
                        }
                    }

                    setSyncInfo(prev => ({
                        ...prev,
                        timestamp: compensatedTimestamp,
                        lastSync: new Date().toLocaleTimeString(),
                    }));
                }
                break;
        }

        // Update sync state
        if (['sync', 'play', 'pause', 'seek'].includes(type)) {
            setSyncInfo(prev => ({
                ...prev,
                isPlaying: type === 'play' ? true : type === 'pause' ? false : (payload.is_playing ?? prev.isPlaying),
                timestamp: payload.timestamp ?? prev.timestamp,
                lastSync: new Date().toLocaleTimeString(),
            }));
        }

        // Decrement counter
        setTimeout(() => {
            internalUpdateCount.current = Math.max(0, internalUpdateCount.current - 1);
        }, 300);
    }, [roomState.videoData?.original_url, playerRef, onVideoChange]);

    // Connect function
    const connect = useCallback(() => {
        if (!roomId || typeof window === 'undefined') return;

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

            pingIntervalRef.current = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'ping', payload: { client_time: performance.now() } }));
                }
            }, 5000);

            ws.send(JSON.stringify({ type: 'ping', payload: { client_time: performance.now() } }));
        };

        ws.onmessage = (event) => {
            try {
                handleMessage(JSON.parse(event.data));
            } catch (e) {
                console.error('Failed to parse WS message', e);
            }
        };

        ws.onclose = () => {
            setConnected(false);
            if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
            reconnectTimer.current = setTimeout(connect, 3000);
        };

        ws.onerror = () => ws.close();
    }, [roomId, handleMessage]);

    // Send message function
    const sendMessage = useCallback((type: string, payload?: any) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type, payload }));
        }
    }, []);

    // Connect on mount
    useEffect(() => {
        connect();

        return () => {
            if (wsRef.current) wsRef.current.close();
            if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
            if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
        };
    }, [connect]);

    return {
        connected,
        roomState,
        syncInfo,
        loadingQueueIndex,
        sendMessage,
        setLoadingQueueIndex,
    };
}
