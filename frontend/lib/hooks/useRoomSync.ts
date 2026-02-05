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
    playerRef: React.MutableRefObject<RoomPlayer | null>;
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
    sendMessage: (type: string, payload?: unknown) => void;
    setLoadingQueueIndex: (index: number | null) => void;
}

interface RoomPlayer {
    play?: () => Promise<void> | void;
    pause?: () => void;
    currentTime?: (time?: number) => number;
    getVideoElement?: () => HTMLVideoElement | null;
}

type RoomWsPayload = {
    video_data?: ResolveResponse;
    members?: { email: string }[];
    queue?: ResolveResponse[];
    roles?: Record<string, string>;
    your_email?: string;
    playing_index?: number;
    is_playing?: boolean;
    timestamp?: number;
    client_time?: number;
    [key: string]: unknown;
};

interface RoomWsMessage {
    type: string;
    payload?: RoomWsPayload;
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

    // Reconnection with exponential backoff
    const reconnectAttempts = useRef<number>(0);
    const MAX_RECONNECT_ATTEMPTS = 15;
    const BASE_RECONNECT_DELAY = 1000;
    const MAX_RECONNECT_DELAY = 30000;

    // Latency tracking
    const latencyRef = useRef<number>(0);

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

    // Ref to track current roomState (avoids stale closure in callbacks)
    const roomStateRef = useRef<RoomState>(roomState);
    useEffect(() => { roomStateRef.current = roomState; }, [roomState]);

    const [syncInfo, setSyncInfo] = useState<SyncInfo>({
        isPlaying: false,
        timestamp: 0,
        lastSync: '',
        latency: 0,
    });

    const [loadingQueueIndex, setLoadingQueueIndex] = useState<number | null>(null);

    // Message handler
    const handleMessage = useCallback((msg: RoomWsMessage) => {
        const type = msg.type;
        const payload = msg.payload ?? {};

        switch (type) {
            case 'sync':
                // Initial sync or reconnect
                if (payload.video_data) {
                    const syncVideoData = payload.video_data;
                    // Use ref to get current video URL (avoids stale closure)
                    const currentVideoUrl = roomStateRef.current.videoData?.original_url;
                    const newVideoUrl = syncVideoData.original_url;

                    if (!currentVideoUrl || currentVideoUrl !== newVideoUrl) {
                        // Re-resolve for fresh URLs
                        if (newVideoUrl) {
                            resolveUrl(newVideoUrl)
                                .then((freshData) => {
                                    setRoomState(prev => ({ ...prev, videoData: freshData }));
                                    onVideoChange?.(freshData);
                                })
                                .catch(() => {
                                    setRoomState(prev => ({ ...prev, videoData: syncVideoData }));
                                });
                        } else {
                            setRoomState(prev => ({ ...prev, videoData: syncVideoData }));
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
                    const serverTimestamp = typeof payload.timestamp === 'number' ? payload.timestamp : 0;
                    if (payload.is_playing) Promise.resolve(playerRef.current.play?.()).catch(() => { });
                    else playerRef.current.pause?.();

                    const isLive = payload.video_data.is_live;
                    if (!isLive || serverTimestamp !== 0) {
                        const playerTime = playerRef.current.currentTime?.() ?? 0;
                        const diff = Math.abs(playerTime - serverTimestamp);
                        if (diff > syncThresholdRef.current) {
                            playerRef.current.currentTime?.(serverTimestamp);
                        }
                    }
                }
                break;

            case 'user_joined':
            case 'user_left': {
                const updatedMembers = payload.members;
                if (updatedMembers) {
                    setRoomState(prev => ({ ...prev, members: updatedMembers }));
                }
                break;
            }

            case 'set_video':
                setLoadingQueueIndex(null);
                setSyncInfo(prev => ({ ...prev, timestamp: 0, isPlaying: true }));

                if (payload.video_data?.original_url) {
                    const queuedVideoData = payload.video_data;
                    setRoomState(prev => ({ ...prev, videoData: queuedVideoData }));

                    resolveUrl(queuedVideoData.original_url)
                        .then((freshData) => {
                            setRoomState(prev => ({ ...prev, videoData: freshData }));
                            onVideoChange?.(freshData);
                        })
                        .catch(() => { });
                } else if (payload.video_data) {
                    const fallbackVideoData = payload.video_data;
                    setRoomState(prev => ({ ...prev, videoData: fallbackVideoData }));
                }
                break;

            case 'play':
                if (playerRef.current) {
                    const serverTimestamp = typeof payload.timestamp === 'number' ? payload.timestamp : 0;
                    if (!(payload.video_data?.is_live && serverTimestamp === 0)) {
                        playerRef.current.currentTime?.(serverTimestamp);
                    }
                    playerRef.current.play?.();
                }
                setRoomState(prev => ({ ...prev, isPlaying: true }));
                break;

            case 'pause':
                if (playerRef.current) {
                    const serverTimestamp = typeof payload.timestamp === 'number' ? payload.timestamp : 0;
                    playerRef.current.pause?.();
                    if (!(payload.video_data?.is_live && serverTimestamp === 0)) {
                        playerRef.current.currentTime?.(serverTimestamp);
                    }
                }
                setRoomState(prev => ({ ...prev, isPlaying: false }));
                break;

            case 'seek':
                if (playerRef.current && typeof payload.timestamp === 'number') {
                    // Apply latency compensation to seek (same as heartbeat)
                    const compensatedSeekTime = payload.timestamp + (latencyRef.current / 1000);
                    playerRef.current.currentTime?.(compensatedSeekTime);
                    const video = playerRef.current.getVideoElement?.();
                    if (video) video.playbackRate = 1.0;
                }
                break;

            case 'queue_update':
                setRoomState(prev => ({
                    ...prev,
                    queue: payload.queue ?? prev.queue,
                    playingIndex: payload.playing_index ?? prev.playingIndex,
                }));
                break;

            case 'roles_update': {
                const updatedRoles = payload.roles;
                if (updatedRoles) {
                    setRoomState(prev => ({ ...prev, roles: updatedRoles }));
                }
                break;
            }

            case 'pong':
                if (typeof payload.client_time === 'number') {
                    const rtt = performance.now() - payload.client_time;
                    latencyRef.current = latencyRef.current === 0
                        ? rtt / 2
                        : latencyRef.current * 0.8 + (rtt / 2) * 0.2;
                    setSyncInfo(prev => ({ ...prev, latency: latencyRef.current }));
                }
                break;

            case 'heartbeat':
                if (playerRef.current && payload.is_playing && typeof payload.timestamp === 'number') {
                    const currentTime = playerRef.current.currentTime?.() ?? 0;
                    const compensatedTimestamp = payload.timestamp + (latencyRef.current / 1000);
                    const drift = compensatedTimestamp - currentTime;

                    const video = playerRef.current.getVideoElement?.();
                    if (video) {
                        // Check if we're in DASH mode (video has volume=0 and there's a separate audio element)
                        // In DASH mode, useDashSync handles its own A/V sync, so we should only do hard seeks
                        // and avoid playback rate manipulation which would desync audio
                        const isDashMode = video.volume === 0 && !video.muted;

                        if (Math.abs(drift) > syncThresholdRef.current) {
                            // Hard seek for large drift (works for both modes)
                            playerRef.current.currentTime?.(compensatedTimestamp);
                            video.playbackRate = 1.0;
                        } else if (!isDashMode) {
                            // Only adjust playback rate in HLS mode (not DASH)
                            // DASH has its own sync via useDashSync that manages both video and audio
                            if (drift > 0.5) {
                                video.playbackRate = 1.05;
                            } else if (drift < -0.5) {
                                video.playbackRate = 0.95;
                            } else {
                                video.playbackRate = 1.0;
                            }
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

    }, [playerRef, onVideoChange]); // Use roomStateRef.current instead of roomState in closure

    // Connect function
    const connect = useCallback(function connectSocket() {
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
            reconnectAttempts.current = 0; // Reset on successful connection
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

            // Exponential backoff for reconnection
            if (reconnectAttempts.current < MAX_RECONNECT_ATTEMPTS) {
                const delay = Math.min(
                    BASE_RECONNECT_DELAY * Math.pow(1.5, reconnectAttempts.current),
                    MAX_RECONNECT_DELAY
                );
                reconnectAttempts.current++;
                console.log(`[RoomSync] Reconnecting in ${Math.round(delay)}ms (attempt ${reconnectAttempts.current}/${MAX_RECONNECT_ATTEMPTS})`);
                reconnectTimer.current = setTimeout(connectSocket, delay);
            } else {
                console.error('[RoomSync] Max reconnection attempts reached');
            }
        };

        ws.onerror = () => ws.close();
    }, [roomId, handleMessage]);

    // Send message function
    const sendMessage = useCallback((type: string, payload?: unknown) => {
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
