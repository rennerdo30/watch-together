"use client";

import { createRoomAuthRecovery } from '@/lib/room-auth-recovery';

import { useStoredTheme } from '@/lib/hooks/useStoredTheme';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import {
    Loader2, Users, Link as LinkIcon,
    Plus, SkipForward,
    Play, ListVideo, Settings, X, Bug,
    Crown, Shield, User as UserIcon, Copy, Check, ExternalLink, Puzzle,
    MonitorUp, MonitorStop, Globe, Bell, BellOff, Volume2, AlertTriangle
} from 'lucide-react';
import { BrandMark } from '@/components/brand-mark';
import { Mascot } from '@/components/mascot';
import { prewarmPosition, prewarmVideo } from '@/lib/prewarm';
import { StartupTimer, type PlaybackEngine } from '@/lib/playback-timing';
import { resumePosition, type PlaybackStart } from '@/lib/playback';
import { usePlaybackAttention } from '@/lib/hooks/usePlaybackAttention';
import { isLiveCatchUpRate } from '@/lib/live-latency';
import { autoQualityCap, openingPlan } from '@/lib/abr';
import { readOpeningEstimate } from '@/lib/bandwidth-memory';
import { capHeadroom, parseQualityMode, QUALITY_MODE_STORAGE_KEY } from '@/lib/quality-mode';
import { captureScreen, shareUnsupportedReason, stopStream } from '@/lib/share/screen-capture';
import { type LiveShare } from '@/lib/share/relay';
import {
    browserUnavailableText, fetchBrowserStatus, openBrowserSession,
    type SharedBrowserSession, type SharedBrowserStatus,
} from '@/lib/shared-browser';
import { useSharePublisher } from '@/lib/share/useSharePublisher';
import { useShareViewer } from '@/lib/share/useShareViewer';
import { ResolveResponse, type QueueEntry, dashManifestUrl, resolveUrl, getUserSettings, updateUserSettings, getCookies, forgetCookies, type CookieStatus, type UserSettings } from '@/lib/api';
import { youtubePlaylistUrl } from '@/lib/playlist-url';
import { PlaylistPreviewDialog } from '@/components/playlist-preview-dialog';
import { CustomPlayer, type PrewarmRequest, type StartupMark } from '@/components/custom-player';
import type { ShakaPreloadTarget } from '@/components/player/hooks';
import { chapterAt, formatChapterTime } from '@/lib/chapters';
import { LiveChat } from '@/components/live-chat';
import { RoomLog } from '@/components/room-log';
import { ErrorBoundary } from '@/components/error-boundary';
import { RoomSettingsDialog, type RoomSettingsSection } from '@/components/room-settings-dialog';
import { ColorModeToggle } from '@/components/color-mode-toggle';
import { displayHost, displayName, getErrorMessage, looksLikeUrl } from '@/lib/utils';
import { BUTTON_DANGER, BUTTON_PRIMARY, BUTTON_SECONDARY, ICON_BUTTON, ICON_BUTTON_ACTIVE } from '@/lib/ui-classes';
import {
    DEFAULT_SPONSORBLOCK_SETTINGS,
    parseSponsorBlockSettings,
    parseSponsorSegments,
    skippedSegmentMessage,
    type SkippedSegment,
    type SponsorBlockSettings,
    type SponsorSegment,
} from '@/lib/sponsorblock';
import {
    APP_NAME,
    BACKEND_ORIGIN,
    COPY_FEEDBACK_DURATION_MS,
    EXTENSION_HINT_DISMISSED_KEY,
    EXTENSION_STORE_URL,
    FONT_SIZE_DEFAULT,
    DEFAULT_SHARE_QUALITY,
    PLAYBACK_TIMING_STALL_WINDOW_MS,
    PREWARM_NEXT_VIDEO_SECONDS,
    SHARE_QUALITY_PRESETS,
    SPECULATIVE_RESOLVE_DEBOUNCE_MS,
    SPECULATIVE_RESOLVE_MAX_AGE_MS,
    SIDEBAR_DEFAULT_WIDTH,
    type ShareQuality,
    SIDEBAR_MAX_WIDTH,
    SIDEBAR_MIN_WIDTH,
} from '@/lib/constants';
import toast, { Toaster } from 'react-hot-toast';
import { useLocalStorageState, parseStoredBoolean, parsePositiveNumber, parseSidebarWidth, parseFontSize } from '@/lib/hooks/useLocalStorageState';

import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragEndEvent, DragStartEvent, DragOverlay } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { SortableQueueItem, QueueItemOverlay } from '@/components/sortable-queue-item';
import {
    mergeRoomActivity,
    normalizeRoomActivity,
    type RoomActivityEvent,
} from '@/lib/room-log';

function getWsUrl(roomId: string) {
    if (typeof window === "undefined") return "";
    // Without a reverse proxy the backend origin is explicit; otherwise the
    // socket goes to the page's own host and nginx routes it.
    const origin = BACKEND_ORIGIN || window.location.origin;
    return `${origin.replace(/^http/, "ws")}/ws/${roomId}`;
}

interface RoomPlayer {
    play: () => Promise<void> | void;
    pause: () => void;
    currentTime: (time?: number) => number;
    getDuration: () => number;
    getVideoElement: () => HTMLVideoElement | null;
}

type WsPayload = {
    video_data?: ResolveResponse;
    members?: { email: string }[];
    queue?: QueueEntry[];
    roles?: Record<string, string>;
    your_email?: string;
    playing_index?: number;
    permanent?: boolean;
    is_playing?: boolean;
    timestamp?: number;
    client_time?: number;
    activity_log?: unknown;
    activity?: unknown;
    [key: string]: unknown;
};

interface WsMessage {
    type: string;
    payload?: WsPayload;
}

// An admin force-close ends the room for good: the server says so in-band
// (a room_closed message) and closes the socket with this code. Either
// signal means "do not reconnect" — reconnecting recreates the room.
const ROOM_CLOSED_WS_CODE = 4001;
const ROOM_CLOSED_REDIRECT_DELAY_MS = 2000;

/** Which engine plays a resolved video; see CustomPlayer. */
const isHlsUrl = (url: string) => url.includes('.m3u8') || url.includes('playlist') || url.includes('manifest');
const playbackEngineOf = (video: ResolveResponse): PlaybackEngine =>
    video.stream_type === 'dash' ? 'mse' : isHlsUrl(video.stream_url ?? '') ? 'hls' : 'direct';

export default function RoomPage() {
    const { id: roomId } = useParams() as { id: string };
    const router = useRouter();

    // UI State
    const [videoData, setVideoData] = useState<ResolveResponse | null>(null);
    const [queue, setQueue] = useState<QueueEntry[]>([]);
    const [playingIndex, setPlayingIndex] = useState<number>(-1);
    const [inputUrl, setInputUrl] = useState('');
    const [playlistDialogUrl, setPlaylistDialogUrl] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [members, setMembers] = useState<{ email: string }[]>([]);
    const [roles, setRoles] = useState<Record<string, string>>({});
    const [currentUser, setCurrentUser] = useState<string>("");
    const canImportPlaylist = roles[currentUser] === 'admin' || roles[currentUser] === 'moderator';
    const playlistInput = youtubePlaylistUrl(inputUrl.trim());
    const [connected, setConnected] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    // The section the dialog opens on; unset opens the viewer's default.
    const [settingsSection, setSettingsSection] = useState<RoomSettingsSection | undefined>(undefined);
    const { activeTheme, setActiveTheme } = useStoredTheme();
    const [useProxy, setUseProxy] = useLocalStorageState('wt_proxy', true, parseStoredBoolean, String);
    const [sidebarTab, setSidebarTab] = useState<'queue' | 'users' | 'chat' | 'log' | 'chapters'>('queue');
    const [activityLog, setActivityLog] = useState<RoomActivityEvent[]>([]);
    const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
    const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
    const [showDebug, setShowDebug] = useState(false);
    const [syncState, setSyncState] = useState({ isPlaying: false, timestamp: 0, lastSync: '' });
    const [loadingQueueIndex, setLoadingQueueIndex] = useState<number | null>(null);
    // A room video is being re-resolved for fresh stream URLs. Tracked
    // separately from loadingQueueIndex, which is only set on the client
    // that clicked: every other member gets `set_video` out of the blue and
    // must show the spinner too, not an empty room.
    const [isRestoringVideo, setIsRestoringVideo] = useState(false);
    const [actualPlayerTime, setActualPlayerTime] = useState(0); // Real player time for badge display
    const [isPermanent, setIsPermanent] = useState(false); // Room permanent status
    const [roomName, setRoomName] = useState(''); // Admin-set display name; the id stays the address
    // What the autoplay policy did to this viewer's latest start, as the
    // player reports it: the tab title and notifications speak from it.
    const [playbackGate, setPlaybackGate] = useState<PlaybackStart>('started');
    // SponsorBlock: the admin's setting, and the segments of the video the
    // server has looked up. Segments are kept with the video they belong to,
    // because they can arrive while this client is still resolving it.
    const [sponsorBlock, setSponsorBlock] = useState<SponsorBlockSettings>(DEFAULT_SPONSORBLOCK_SETTINGS);
    const [sponsorSegments, setSponsorSegments] = useState<{ videoUrl: string | null; segments: SponsorSegment[] }>(
        { videoUrl: null, segments: [] });
    // The skip the server announced it is about to make (`skip_upcoming`),
    // so the player can fetch where the room will land before it jumps.
    const [upcomingSkip, setUpcomingSkip] = useState<{ videoUrl: string; seconds: number; key: string } | null>(null);

    // A link is being resolved, either pasted directly or picked from the
    // queue. The empty state is hidden while this is true: both used to
    // render at once, and the spinner's translucent backdrop let the
    // "Nothing playing yet" text show through it.
    const isResolving = loading || loadingQueueIndex !== null || isRestoringVideo;

    // The WebSocket handler is created once, so reading videoData from its
    // closure always saw the value from mount. Every `sync` therefore looked
    // like a new video and triggered a re-resolve, which replaced the stream
    // URLs and remounted the player: a rebuffer loop on every reconnect.
    const videoDataRef = useRef<ResolveResponse | null>(null);
    useEffect(() => { videoDataRef.current = videoData; }, [videoData]);

    // A room left open in a background tab all day: what it plays has to
    // reach a viewer who is not looking, above all when the browser started
    // it muted or not at all.
    const attentionVideo = useMemo(() => videoData
        ? { title: videoData.title, playing: syncState.isPlaying }
        : null, [videoData, syncState.isPlaying]);
    const attention = usePlaybackAttention(attentionVideo, playbackGate);
    // Read from the WebSocket handler, which is created once.
    const announceRef = useRef(attention.announce);
    useEffect(() => { announceRef.current = attention.announce; }, [attention.announce]);
    const currentUserRef = useRef(currentUser);
    useEffect(() => { currentUserRef.current = currentUser; }, [currentUser]);

    // Layout resizing
    const [storedSidebarWidth, setStoredSidebarWidth] = useLocalStorageState('wt_sidebar_width', SIDEBAR_DEFAULT_WIDTH, parseSidebarWidth);
    const [sidebarDraft, setSidebarWidth] = useState<number | null>(null);
    const sidebarWidth = sidebarDraft ?? storedSidebarWidth;
    const isResizing = useRef(false);
    // The text size the viewer picked; it used to be written but never read back.
    const [fontSize, setFontSize] = useLocalStorageState('wt_font_size', FONT_SIZE_DEFAULT, parseFontSize, String);
    const [isLoadingCookies, setIsLoadingCookies] = useState(true);
    // Whether the server holds cookies for this user right now: gates
    // features that act on their account, and decides whether to suggest
    // installing the extension.
    const [hasSavedCookies, setHasSavedCookies] = useState(false);
    const [cookieStatus, setCookieStatus] = useState<CookieStatus | null>(null);
    const [extensionHintDismissed, setExtensionHintDismissed] = useLocalStorageState(
        EXTENSION_HINT_DISMISSED_KEY, false, parseStoredBoolean, String);
    const [userSettings, setUserSettings] = useState<UserSettings | null>(null);
    const [isCopyingDebug, setIsCopyingDebug] = useState(false);

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
    const authRecoveryRef = useRef<ReturnType<typeof createRoomAuthRecovery> | null>(null);
    const [signInRequired, setSignInRequired] = useState(false);
    const playerRef = useRef<RoomPlayer | null>(null);
    const internalUpdateCount = useRef(0); // Counter to prevent feedback loops during sync
    const reconnectTimer = useRef<NodeJS.Timeout | null>(null);
    // Set when the server closes the room for good; blocks the reconnect.
    const roomClosedRef = useRef(false);

    // Latency tracking for sync compensation
    const latencyRef = useRef<number>(0); // Average latency in ms
    // When this viewer last moved the playhead themselves. A heartbeat with
    // the pre-seek timestamp can already be in flight when the seek message
    // reaches the server — Germany to Japan is a quarter second each way —
    // and correcting against it yanks the viewer straight back to where they
    // seeked away from.
    const lastLocalSeekAtRef = useRef(0);
    // The name this viewer just asked for, so the settings broadcast that
    // confirms it can be acknowledged with a toast. Without one, Save gave no
    // sign of life: the modal hides the header, the input already shows what
    // was typed, and the address deliberately never changes.
    const pendingRenameRef = useRef<string | null>(null);
    const pingIntervalRef = useRef<NodeJS.Timeout | null>(null);
    const videoElementRef = useRef<HTMLVideoElement | null>(null);

    const syncThresholdRef = useRef(4);
    const [syncThreshold, setSyncThresholdState] = useLocalStorageState('w2g-sync-threshold', 4, parsePositiveNumber);

    const setSyncThreshold = (val: number) => {
        setSyncThresholdState(val);
        syncThresholdRef.current = val;
    };

    useEffect(() => { syncThresholdRef.current = syncThreshold; }, [syncThreshold]);

    // Stable resize handlers stored once in refs to avoid listener identity issues
    const sidebarWidthRef = useRef(sidebarWidth);
    useEffect(() => { sidebarWidthRef.current = sidebarWidth; }, [sidebarWidth]);

    const handleMouseMove = useCallback((e: MouseEvent) => {
        if (!isResizing.current) return;
        const width = window.innerWidth - e.clientX;
        if (width >= SIDEBAR_MIN_WIDTH && width <= SIDEBAR_MAX_WIDTH) {
            setSidebarWidth(width);
        }
    }, []);

    const stopResizing = useCallback(function stopResizing() {
        isResizing.current = false;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', stopResizing);
        document.body.style.cursor = 'default';
        setStoredSidebarWidth(sidebarWidthRef.current);
    }, [handleMouseMove, setStoredSidebarWidth]);

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
            if (wsRef.current !== ws) return;
            setSignInRequired(false);
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
        ws.onclose = (event) => {
            if (wsRef.current !== ws) return;
            setConnected(false);
            if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
            // An admin close is final. Reconnecting here recreated the room
            // seconds after it was closed, making the close look like a no-op.
            if (roomClosedRef.current || event.code === ROOM_CLOSED_WS_CODE) {
                roomClosedRef.current = true;
                return;
            }
            void authRecoveryRef.current?.check();
            reconnectTimer.current = setTimeout(connect, 3000);
        };
        ws.onerror = () => ws.close();
    };

    useEffect(() => {
        const user = new URLSearchParams(window.location.search).get('user');
        const suffix = user ? `?user=${encodeURIComponent(user)}` : '';
        const recovery = createRoomAuthRecovery({
            url: `${BACKEND_ORIGIN}/api/me${suffix}`,
            disconnected: () => !roomClosedRef.current && wsRef.current?.readyState === WebSocket.CLOSED,
            onSignInRequired: () => setSignInRequired(true),
        });
        authRecoveryRef.current = recovery;
        connect();

        return () => {
            recovery.dispose();
            authRecoveryRef.current = null;
            const ws = wsRef.current;
            wsRef.current = null;
            if (ws) {
                ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
                ws.close();
            }
            if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
            if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
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
                const data = await getCookies();
                setHasSavedCookies(data.has_cookies);
                setCookieStatus(data);
            } catch (err) {
                console.error('Failed to load the cookie status:', err);
            } finally {
                setIsLoadingCookies(false);
            }
        };
        loadCookies();
        getUserSettings()
            .then(setUserSettings)
            .catch((err) => console.warn('[Room] Could not load user settings:', err));
    }, [currentUser]);

    // Cookies may have arrived from the extension since the page loaded;
    // what the settings offer depends on whether they exist.
    useEffect(() => {
        if (!showSettings || !currentUser || currentUser === 'Guest') return;
        getCookies()
            .then((data) => { setHasSavedCookies(data.has_cookies); setCookieStatus(data); })
            .catch(() => { /* the initial load already reported this */ });
    }, [showSettings, currentUser]);

    // Note: We no longer need a local ticker for syncState.timestamp
    // The badge now uses actualPlayerTime which is updated via onTimeUpdate

    // === SHARING A SCREEN WITH THE ROOM ===
    // The media goes through this server, on its own WebSocket: the origin
    // publishes no ports and the tunnel carries HTTP and WebSocket only, so
    // there is no path between two browsers to use instead. It costs about
    // a second of delay and the server's bandwidth per viewer; it works
    // from anywhere, which the direct path did not.
    const [liveShare, setLiveShare] = useState<LiveShare | null>(null);
    const [myConnectionId, setMyConnectionId] = useState('');
    // The socket handler is installed once and keeps the render it was
    // created in, so anything it compares against has to be a ref rather
    // than state — the same reason `videoDataRef` exists.
    const myConnectionIdRef = useRef('');
    const [localShareStream, setLocalShareStream] = useState<MediaStream | null>(null);
    const [shareDialogOpen, setShareDialogOpen] = useState(false);
    const [shareQuality, setShareQuality] = useState<ShareQuality>(DEFAULT_SHARE_QUALITY);
    const [shareError, setShareError] = useState<string | null>(null);
    const amSharing = !!liveShare && liveShare.connection_id === myConnectionId;

    // In development the identity travels as a query parameter, exactly as
    // it does on the room socket.
    const searchParams = useSearchParams();
    const devUser = searchParams.get('user') ?? undefined;

    // `sendMsg` is defined further down; reaching it through a ref keeps
    // these callbacks stable and free of declaration order.
    const sendMsgRef = useRef<(type: string, payload?: unknown) => void>(() => { });

    // === HOW LONG EACH VIDEO TOOK TO START (lib/playback-timing.ts) ===
    // Everything here is reached from the socket handler, which keeps the
    // render it was created in, so it lives in refs.
    const startupTimerRef = useRef<StartupTimer | null>(null);
    const startupReportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // The resolve this viewer waited for before announcing a video, so the
    // report of that video's start can include it.
    const initiatedResolveRef = useRef<{ url: string; ms: number } | null>(null);
    const sendStartupTiming = () => {
        if (startupReportTimerRef.current !== null) clearTimeout(startupReportTimerRef.current);
        startupReportTimerRef.current = null;
        const report = startupTimerRef.current?.takeReport();
        if (report) sendMsgRef.current('playback_timing', report);
    };
    const beginStartupTiming = (video: ResolveResponse | null | undefined) => {
        // The video being replaced reports what it has, stalls so far included.
        sendStartupTiming();
        startupTimerRef.current = null;
        if (!video?.original_url) return;
        const initiated = initiatedResolveRef.current;
        initiatedResolveRef.current = null;
        startupTimerRef.current = new StartupTimer(
            video.original_url, playbackEngineOf(video), performance.now(),
            initiated?.url === video.original_url ? initiated.ms : undefined);
    };
    const handleStartupMark = (mark: StartupMark) => {
        const timer = startupTimerRef.current;
        if (!timer || (mark.originalUrl && mark.originalUrl !== timer.originalUrl)) return;
        const now = performance.now();
        switch (mark.kind) {
            case 'manifest': timer.markManifest(now, mark.preloaded); break;
            case 'first-frame':
                timer.markFirstFrame(now, mark.height);
                if (startupReportTimerRef.current === null) {
                    startupReportTimerRef.current = setTimeout(sendStartupTiming, PLAYBACK_TIMING_STALL_WINDOW_MS);
                }
                break;
            case 'playing': timer.markPlaying(now); break;
            case 'stall': timer.markStall(now); break;
        }
    };

    const publisher = useSharePublisher({
        origin: BACKEND_ORIGIN,
        roomId,
        connectionId: amSharing ? myConnectionId : '',
        stream: amSharing ? localShareStream : null,
        quality: shareQuality,
        user: devUser,
    });
    const viewer = useShareViewer({
        origin: BACKEND_ORIGIN,
        roomId,
        active: !!liveShare && !amSharing,
        connectionId: myConnectionId,
        user: devUser,
    });

    const stopSharing = useCallback((tellTheRoom = true) => {
        setLocalShareStream((current) => { stopStream(current); return null; });
        if (tellTheRoom) sendMsgRef.current('share_stop', {});
    }, []);

    const startSharing = useCallback(async () => {
        setShareError(null);
        const unsupported = shareUnsupportedReason();
        if (unsupported) { setShareError(unsupported); return; }
        try {
            const stream = await captureScreen(shareQuality);
            // Chrome's own "Stop sharing" bar ends the capture without
            // telling this page anything else; the track ending is how it
            // finds out.
            stream.getVideoTracks()[0]?.addEventListener('ended', () => stopSharing());
            setLocalShareStream(stream);
            setShareDialogOpen(false);
            sendMsgRef.current('share_start', {
                title: SHARE_QUALITY_PRESETS[shareQuality].label,
                quality: shareQuality,
            });
        } catch (error) {
            // Cancelling the picker is an ordinary answer, not a failure.
            if ((error as DOMException)?.name === 'NotAllowedError') { setShareDialogOpen(false); return; }
            setShareError('Could not start the capture. Another app may be holding the screen.');
        }
    }, [shareQuality, stopSharing]);

    // === THE ROOM'S SHARED BROWSER ===
    // A real browser running on the server, in the same place a share goes:
    // one player, one source. Unlike a share it is not this room's to assume
    // — there is one container for the whole instance, and its picture needs
    // a path out that the tunnel cannot provide — so the status is fetched
    // before the button is drawn, and says why when the answer is no.
    const [browserStatus, setBrowserStatus] = useState<SharedBrowserStatus | null>(null);
    const [sharedBrowser, setSharedBrowser] = useState<SharedBrowserSession | null>(null);
    const [browserSessionEmbed, setBrowserEmbed] = useState<{ session: SharedBrowserSession; embed: { path: string; control: boolean } } | null>(null);
    const browserEmbed = sharedBrowser
        && browserSessionEmbed?.session.room_id === sharedBrowser.room_id
        && browserSessionEmbed.session.opened_at === sharedBrowser.opened_at
        ? browserSessionEmbed.embed : null;
    const [browserDialogOpen, setBrowserDialogOpen] = useState(false);
    const [browserError, setBrowserError] = useState<string | null>(null);

    // Escape closes whichever room dialog is open.
    useEffect(() => {
        if (!showSettings && !shareDialogOpen && !browserDialogOpen) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            setShowSettings(false);
            setShareDialogOpen(false);
            setBrowserDialogOpen(false);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [showSettings, shareDialogOpen, browserDialogOpen]);

    const refreshBrowserStatus = useCallback(() => {
        void fetchBrowserStatus(BACKEND_ORIGIN, roomId).then(setBrowserStatus);
    }, [roomId]);

    useEffect(() => { refreshBrowserStatus(); }, [refreshBrowserStatus]);

    // The session is minted per tab, not per room: the cookie it sets is
    // this browser's way in, so every member asks for their own once the
    // room has the browser open.
    useEffect(() => {
        if (!sharedBrowser) return;
        let cancelled = false;
        void openBrowserSession(BACKEND_ORIGIN, roomId)
            .then((embed) => { if (!cancelled) { setBrowserEmbed({ session: sharedBrowser, embed }); setBrowserError(null); } })
            .catch(() => {
                if (!cancelled) setBrowserError('Could not get into the shared browser.');
            });
        return () => { cancelled = true; };
    }, [sharedBrowser, roomId]);

    const openSharedBrowser = useCallback(() => {
        setBrowserError(null);
        sendMsgRef.current('browser_open', { title: 'Shared browser' });
        setBrowserDialogOpen(false);
    }, []);

    const closeSharedBrowser = useCallback(() => {
        sendMsgRef.current('browser_close', {});
    }, []);

    const browserBlockedText = browserUnavailableText(browserStatus);

    const handleWsMessage = (msg: WsMessage) => {
        const type = msg.type;
        const payload = msg.payload ?? {};
        internalUpdateCount.current += 1; // Increment counter to block local events

        switch (type) {
            case 'sync':
                // Which browser this is — the relay checks it before taking
                // media from anyone — and whatever is already being shared
                // when it arrives. A member joining mid-share is the case
                // the retained container header exists for.
                if (payload.your_connection_id) {
                    myConnectionIdRef.current = payload.your_connection_id as string;
                    setMyConnectionId(payload.your_connection_id as string);
                }
                setLiveShare((payload.live_share as LiveShare | null) ?? null);
                // …and whether the room already has the browser open, so a
                // member who joins mid-session sees it rather than an empty
                // player with a button that says "open".
                setSharedBrowser((payload.shared_browser as SharedBrowserSession | null) ?? null);
                // On sync (initial load or reconnect), set video data and re-resolve for fresh DASH URLs
                if (payload.video_data) {
                    const syncVideoData = payload.video_data;
                    const current = videoDataRef.current;
                    const isSameVideo = current?.original_url === syncVideoData.original_url;

                    if (!current || !isSameVideo) {
                        beginStartupTiming(syncVideoData);
                        // New video or first load: Re-resolve for fresh stream URLs
                        if (syncVideoData.original_url) {
                            console.log('[Room] Sync: Re-resolving video for fresh stream URLs...');
                            setIsRestoringVideo(true);
                            resolveUrl(syncVideoData.original_url, { room: roomId })
                                .then((freshData) => {
                                    console.log('[Room] Sync: Got fresh stream:', freshData.stream_type, freshData.quality);
                                    // Who added it is room knowledge, not something a resolve returns.
                                    setVideoData({ ...freshData, added_by: syncVideoData.added_by });
                                })
                                .catch((err) => {
                                    console.warn('[Room] Sync: Re-resolve failed, using cached data:', err.message);
                                    setVideoData(syncVideoData);
                                })
                                .finally(() => setIsRestoringVideo(false));
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
                if (typeof payload.name === 'string') setRoomName(payload.name);
                if ('activity_log' in payload) setActivityLog(normalizeRoomActivity(payload.activity_log));
                {
                    const settings = parseSponsorBlockSettings(payload.sponsorblock);
                    if (settings) setSponsorBlock(settings);
                    setSponsorSegments({
                        videoUrl: payload.video_data?.original_url ?? null,
                        segments: parseSponsorSegments(payload.sponsor_segments),
                    });
                }

                if (playerRef.current && payload.video_data) {
                    const serverTimestamp = typeof payload.timestamp === 'number' ? payload.timestamp : 0;
                    if (payload.is_playing) Promise.resolve(playerRef.current.play?.()).catch(() => { });
                    else playerRef.current.pause?.();

                    const isLive = payload.video_data.is_live;
                    if (isLive) {
                        // Live positions are per client — hls.js anchors the
                        // timeline at *this* viewer's first playlist load —
                        // so no stored number is meaningful here. The live
                        // edge is the shared position and every player
                        // reaches it on its own.
                    } else if (playerRef.current) {
                        const playerTime = playerRef.current.currentTime();
                        const diff = Math.abs(playerTime - serverTimestamp);
                        if (diff > syncThresholdRef.current) playerRef.current.currentTime(serverTimestamp);
                    }
                }
                break;
            case 'activity':
                setActivityLog((history) => mergeRoomActivity(history, payload.activity));
                break;
            case 'user_joined': if (payload.members) setMembers(payload.members); break;
            case 'user_left': if (payload.members) setMembers(payload.members); break;
            case 'set_video': {
                // The server refreshes queued entries before announcing them.
                // Mount once, immediately; another resolve here delays every
                // viewer. A replayed entry resumes where the room left it —
                // the server carries that on the video as `progress` — while a
                // live stream has no position to return to.
                const nextVideo = payload.video_data;
                beginStartupTiming(nextVideo);
                const resumeAt = resumePosition(nextVideo);
                setSyncState(prev => ({ ...prev, timestamp: resumeAt, isPlaying: !!nextVideo }));
                setActualPlayerTime(resumeAt);
                setSponsorSegments({ videoUrl: nextVideo?.original_url ?? null, segments: [] });
                setVideoData(nextVideo ?? null);
                setIsRestoringVideo(false);
                setLoadingQueueIndex(null);
                // Whoever queued it is looking at it already.
                if (nextVideo && nextVideo.added_by !== currentUserRef.current) {
                    announceRef.current(nextVideo.title,
                        nextVideo.added_by ? displayName(nextVideo.added_by) : undefined);
                }
                break;
            }
            case 'play':
                if (playerRef.current) {
                    const serverTimestamp = typeof payload.timestamp === 'number' ? payload.timestamp : 0;
                    // Play/pause messages carry no video_data: the live check
                    // has to come from the room's own state.
                    if (!videoDataRef.current?.is_live) {
                        playerRef.current.currentTime(serverTimestamp);
                    }
                    playerRef.current.play();
                }
                break;
            case 'pause':
                if (playerRef.current) {
                    const serverTimestamp = typeof payload.timestamp === 'number' ? payload.timestamp : 0;
                    playerRef.current.pause();
                    if (!videoDataRef.current?.is_live) {
                        playerRef.current.currentTime(serverTimestamp);
                    }
                }
                break;
            case 'seek':
                // Intentional seek - always hard jump. Except on a live
                // stream, where another viewer's position means nothing in
                // this player's timeline.
                if (playerRef.current && typeof payload.timestamp === 'number' && !videoDataRef.current?.is_live) {
                    playerRef.current.currentTime(payload.timestamp);
                }
                // The server moved the room past a SponsorBlock segment: an
                // unexplained jump looks like a glitch, so say what happened.
                if (payload.skipped && typeof payload.skipped === 'object') {
                    const skipped = payload.skipped as Partial<SkippedSegment>;
                    if (typeof skipped.category === 'string' &&
                        typeof skipped.start === 'number' && typeof skipped.end === 'number') {
                        toast(skippedSegmentMessage(skipped as SkippedSegment), { icon: '⏭️' });
                    }
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
            case 'skip_upcoming':
                if (typeof payload.video_url === 'string' && typeof payload.to === 'number'
                    && Number.isFinite(payload.to) && payload.to >= 0) {
                    setUpcomingSkip({
                        videoUrl: payload.video_url,
                        seconds: payload.to,
                        key: `${payload.video_url}@${payload.at}-${payload.to}`,
                    });
                }
                break;
            case 'sponsorblock_segments':
                if (typeof payload.video_url === 'string') {
                    setSponsorSegments({ videoUrl: payload.video_url, segments: parseSponsorSegments(payload.segments) });
                }
                break;
            case 'room_settings_update':
                if (typeof payload.permanent === 'boolean') setIsPermanent(payload.permanent);
                {
                    const settings = parseSponsorBlockSettings(payload.sponsorblock);
                    if (settings) setSponsorBlock(settings);
                }
                if (typeof payload.name === 'string') {
                    setRoomName(payload.name);
                    if (pendingRenameRef.current !== null &&
                        payload.name === pendingRenameRef.current) {
                        toast.success(payload.name
                            ? `Room renamed to "${payload.name}"`
                            : 'Room name removed');
                        pendingRenameRef.current = null;
                    }
                }
                break;
            case 'room_closed': {
                roomClosedRef.current = true;
                if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
                const message = typeof payload.message === 'string' && payload.message
                    ? payload.message
                    : 'This room was closed by an administrator';
                toast.error(message);
                setTimeout(() => router.push('/'), ROOM_CLOSED_REDIRECT_DELAY_MS);
                break;
            }
            case 'resolve_failed':
                // Only the member who added the link hears of it; for
                // everyone else the pending row simply goes away.
                toast.error(typeof payload.detail === 'string' && payload.detail
                    ? `Could not add to the queue: ${payload.detail}`
                    : 'Could not add that link to the queue');
                break;
            case 'error':
                // The server refuses quietly otherwise, and a click that
                // does nothing visible reads as a broken button.
                if (typeof payload.message === 'string' && payload.message) {
                    toast.error(payload.message);
                }
                break;
            case 'share_started': {
                // Everyone but the sharer opens the media socket, which the
                // hooks do from this state; the sharer's own player shows
                // the capture directly, with nothing in between.
                setLiveShare(payload as unknown as LiveShare);
                break;
            }

            case 'browser_opened':
                setSharedBrowser(payload as unknown as SharedBrowserSession);
                break;

            case 'browser_closed':
                setSharedBrowser(null);
                break;

            case 'share_ended':
                setLiveShare(null);
                // If this browser was the one sharing, the capture stops
                // with it — an admin can end someone else's share.
                stopSharing(false);
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
                // A live stream is never position-synced: the server's
                // timestamp is some viewer's window-relative position, and
                // correcting towards it every five seconds dragged a DVR
                // stream back to the start of its window on every beat.
                // hls.js's own catch-up towards its latency target is left
                // alone; only a rate left over from position sync is put back
                // to 1x. Resetting every rate here undid the catch-up on every
                // beat.
                if (videoDataRef.current?.is_live) {
                    const liveVideo = playerRef.current?.getVideoElement?.();
                    if (liveVideo && !isLiveCatchUpRate(liveVideo.playbackRate)) liveVideo.playbackRate = 1.0;
                } else if (playerRef.current && payload.is_playing && typeof payload.timestamp === 'number') {
                    // Gradual sync - adjust playback rate instead of jumping for small drifts
                    const currentTime = playerRef.current.currentTime();
                    // Compensate for latency (one-way delay)
                    const compensatedTimestamp = payload.timestamp + (latencyRef.current / 1000);
                    const drift = compensatedTimestamp - currentTime;

                    const video = playerRef.current.getVideoElement?.();
                    // A heartbeat carrying the pre-seek timestamp can still
                    // be in flight when the seek reaches the server, and a
                    // seek still buffering reports its new position before
                    // the server has confirmed it. Correcting against either
                    // snaps the viewer back to where they seeked away from.
                    const settling = Boolean(video?.seeking) ||
                        Date.now() - lastLocalSeekAtRef.current < 3000;
                    if (video && settling) {
                        video.playbackRate = 1.0;
                    } else if (video) {
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
    useEffect(() => { sendMsgRef.current = sendMsg; });

    // Leaving the room, or closing the tab, releases the capture: the
    // browser's own sharing indicator would otherwise outlive the share.
    useEffect(() => () => { stopStream(localShareStream); }, [localShareStream]);

    // Whose session a resolve ran with, when it was not the viewer's own.
    const lentBy = (data: ResolveResponse) =>
        data.resolved_by && data.resolved_by !== currentUser
            ? ` (using ${displayName(data.resolved_by)}'s cookies)`
            : '';

    // === RESOLVING A PASTED LINK BEFORE THE CLICK ===
    // A resolve is the longest single wait in starting a video, and it does
    // not depend on the click: a link that looks complete is resolved while
    // the viewer reaches for the button, and the click joins that resolve —
    // still in flight, or already answered. The server coalesces identical
    // resolves and caches the answer, so a queue add of the same link lands
    // on it too.
    const speculativeResolveRef = useRef<{ url: string; at: number; result: Promise<ResolveResponse> } | null>(null);
    const resolveForRoom = useCallback((url: string): Promise<ResolveResponse> => {
        const earlier = speculativeResolveRef.current;
        if (earlier && earlier.url === url && Date.now() - earlier.at < SPECULATIVE_RESOLVE_MAX_AGE_MS) {
            return earlier.result;
        }
        const entry = { url, at: Date.now(), result: resolveUrl(url, { room: roomId }) };
        speculativeResolveRef.current = entry;
        // A failed resolve is not kept: the click asks again and reports it.
        entry.result.catch(() => {
            if (speculativeResolveRef.current === entry) speculativeResolveRef.current = null;
        });
        return entry.result;
    }, [roomId]);
    useEffect(() => {
        const url = inputUrl.trim();
        if (!looksLikeUrl(url) || youtubePlaylistUrl(url).purePlaylist) return;
        const timer = setTimeout(() => {
            // Speculation: its errors are the click's to report, not this.
            resolveForRoom(url).catch(() => { });
        }, SPECULATIVE_RESOLVE_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [inputUrl, resolveForRoom]);

    const handleLoadNow = async (e: React.FormEvent) => {
        e.preventDefault();
        const url = inputUrl.trim();
        if (!url || loading) return;
        if (youtubePlaylistUrl(url).purePlaylist) {
            if (canImportPlaylist) setPlaylistDialogUrl(url);
            else toast.error('Only room moderators and admins can import playlists.');
            return;
        }
        setLoading(true);
        const clickedAt = performance.now();
        try {
            const data = await resolveForRoom(url);
            // What this viewer waited for, from the click: a resolve the
            // paste already started counts only for what was left of it.
            initiatedResolveRef.current = { url: data.original_url, ms: performance.now() - clickedAt };
            sendMsg('set_video', { video_data: data });
            setInputUrl('');
            toast.success(`Playing: ${data.title}${lentBy(data)}`);
        } catch (err: unknown) {
            console.error(err);
            toast.error(getErrorMessage(err, 'Failed to resolve video'));
        } finally { setLoading(false); }
    };

    // The link goes to the server as it is. The server shows it in the queue
    // at once, as a pending row, and resolves it there; waiting here for the
    // resolve first kept the viewer staring at a busy button for the length
    // of an extraction.
    const handleAddToQueue = () => {
        const url = inputUrl.trim();
        if (!url || loading) return;
        if (youtubePlaylistUrl(url).purePlaylist) {
            if (canImportPlaylist) setPlaylistDialogUrl(url);
            else toast.error('Only room moderators and admins can import playlists.');
            return;
        }
        sendMsg('queue_add', { url });
        setInputUrl('');
        toast('Adding to queue…');
    };

    // A live stream outlives its signed playlist URL: the CDN starts
    // answering 403 partway through the session, and retrying the dead URL
    // can never succeed. The only fix is a fresh resolve. The cooldown keeps
    // a stream that is genuinely gone (the fresh URL is rejected too) from
    // looping — the second failure inside the window surfaces as an error.
    const SOURCE_REFRESH_COOLDOWN_MS = 30_000;
    const lastSourceRefreshRef = useRef(0);
    const handleSourceExpired = useCallback(async () => {
        const original = videoDataRef.current?.original_url;
        if (!original) throw new Error('There is no stream to refresh.');
        const now = Date.now();
        if (now - lastSourceRefreshRef.current < SOURCE_REFRESH_COOLDOWN_MS) {
            throw new Error('The stream keeps rejecting playback — it may have ended.');
        }
        lastSourceRefreshRef.current = now;
        console.log('[Room] Stream URL expired upstream, re-resolving...');
        const fresh = await resolveUrl(original, { refresh: true, room: roomId });
        console.log('[Room] Got fresh stream after expiry:', fresh.stream_type, fresh.quality);
        setVideoData(fresh);
    }, [roomId]);

    // Chapters (YouTube: sections) of the current video. Jumping to one is a
    // room-wide seek, like dragging the seek bar: the player is moved here
    // and the room told, since a programmatic move is otherwise treated as
    // sync correction and never published.
    const chapters = videoData?.chapters ?? [];
    const hasChapters = chapters.length > 0;
    const seekRoom = (time: number) => {
        playerRef.current?.currentTime(time);
        lastLocalSeekAtRef.current = Date.now();
        sendMsg('seek', { timestamp: time });
        setSyncState(prev => ({ ...prev, timestamp: time, lastSync: new Date().toLocaleTimeString() }));
    };
    if (sidebarTab === 'chapters' && !hasChapters) setSidebarTab('queue');
    // A live stream's chat is part of watching it, so it comes to the front
    // when a live video starts — once per stream: a member who switches back
    // to the queue is not pulled away again by every sync.
    // Remembered per stream rather than keyed on the video state alone: a
    // live source is re-resolved now and then, and the state passing through
    // a refresh must not count as a new stream starting.
    const liveStreamKey = videoData?.is_live ? videoData.original_url : null;
    const chatShownForRef = useRef<string | null>(null);
    useEffect(() => {
        if (!liveStreamKey || chatShownForRef.current === liveStreamKey) return;
        chatShownForRef.current = liveStreamKey;
        setSidebarTab('chat');
    }, [liveStreamKey]);

    const getFinalVideoUrl = () => {
        if (!videoData) return "";
        const rawUrl = videoData.stream_url;
        const proxiedUrl = useProxy ? `/api/proxy?url=${encodeURIComponent(rawUrl)}` : rawUrl;

        // Help hls.js identify HLS streams by providing explicit MIME type
        if (isHlsUrl(rawUrl)) {
            return { src: proxiedUrl, type: 'application/x-mpegurl' };
        }
        return proxiedUrl;
    };

    // Manifest describing the adaptive streams, for the MSE engine. The
    // backend builds it from the formats it already resolved, so it is
    // addressed by the original video URL rather than a stream URL.
    // Which entry the room will play next, mirroring the server's own
    // choice: a pinned video stays in the queue and is passed over, and the
    // entry after the last one is the first.
    const upcomingEntry = (): QueueEntry | undefined => {
        if (queue.length === 0) return undefined;
        if (playingIndex >= 0 && playingIndex < queue.length && queue[playingIndex].pinned) {
            return queue[playingIndex + 1];
        }
        const remaining = queue.filter((_entry, index) => index !== playingIndex);
        if (remaining.length === 0) return undefined;
        return remaining[playingIndex >= 0 && playingIndex < remaining.length ? playingIndex : 0];
    };

    // === PREPARING THE NEXT VIDEO WHILE THIS ONE FINISHES ===
    // An adaptive video plays through one Shaka player that outlives it, and
    // that player preloads the next entry itself — manifest, segment index,
    // first segments — so the advance starts from bytes already in the page.
    // Any other player has nothing to preload with; for those, the server is
    // asked to prepare the entry (see prewarmVideo), which it also does on
    // its own beat. Nothing here is prepared for an entry the server is
    // still resolving.
    const playsThroughShaka = videoData?.stream_type === 'dash' && !!videoData.original_url && !liveShare && !sharedBrowser;
    const nearTheEnd = !!videoData?.duration && !videoData.is_live &&
        videoData.duration - actualPlayerTime <= PREWARM_NEXT_VIDEO_SECONDS;
    const upcoming = upcomingEntry();
    // The server announces an advance as a queue update first and the video
    // itself a moment later. In between, the queue already names the entry
    // on its way in; it is still the one to keep prepared, or the preload
    // would be thrown away just before it is used.
    const arriving = playingIndex >= 0 && playingIndex < queue.length &&
        queue[playingIndex].original_url !== videoData?.original_url
        ? queue[playingIndex]
        : undefined;
    const candidate = arriving ?? (nearTheEnd ? upcoming : undefined);
    const nextToPrepare = candidate && !candidate.pending ? candidate : undefined;
    const preloadNext: ShakaPreloadTarget | null =
        playsThroughShaka && nextToPrepare?.stream_type === 'dash' && !nextToPrepare.is_live
            ? {
                originalUrl: nextToPrepare.original_url,
                manifestUrl: dashManifestUrl(nextToPrepare.original_url, roomId),
                startTime: resumePosition(nextToPrepare),
                ladder: nextToPrepare.available_qualities ?? [],
            }
            : null;
    const serverPrewarmUrl = !playsThroughShaka ? nextToPrepare?.original_url : undefined;
    const serverPrewarmType = !playsThroughShaka ? nextToPrepare?.stream_type : undefined;
    useEffect(() => {
        // prewarmVideo acts once per video, so a position that ticks with
        // playback stays a single request.
        if (serverPrewarmUrl) void prewarmVideo(serverPrewarmUrl, roomId, serverPrewarmType);
    }, [serverPrewarmUrl, serverPrewarmType, roomId]);

    const warmPosition = (request: PrewarmRequest) =>
        prewarmPosition(request.originalUrl, roomId, request.seconds, request.height, request.codec);

    // A pointer resting on a queue row is a viewer about to pick it: the
    // server gets a head start on the bytes it would open on.
    const warmQueueEntry = (index: number) => {
        const entry = queue[index];
        if (!entry || entry.pending || index === playingIndex || entry.stream_type !== 'dash' || entry.is_live) return;
        const ladder = entry.available_qualities ?? [];
        const video = playerRef.current?.getVideoElement();
        let mode = parseQualityMode(null);
        try {
            mode = parseQualityMode(localStorage.getItem(QUALITY_MODE_STORAGE_KEY));
        } catch {
            // Storage can be disabled; the default mode is fine.
        }
        const headroom = capHeadroom(mode);
        const surface = video ? video.clientHeight * (window.devicePixelRatio || 1) : 0;
        const cap = headroom === null ? null : autoQualityCap(ladder.map((rung) => rung.height), surface, headroom);
        const plan = openingPlan(ladder, cap, readOpeningEstimate());
        if (plan) prewarmPosition(entry.original_url, roomId, resumePosition(entry), plan.height, plan.codec);
    };

    const getManifestUrl = () => {
        if (!videoData || videoData.stream_type !== 'dash') return undefined;
        if (!videoData.original_url) return undefined;
        return dashManifestUrl(videoData.original_url, roomId);
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
        <main className={`app-shell h-dvh w-full flex flex-col bg-[color:var(--bg-primary)] text-neutral-300 overflow-hidden font-sans`}>
            <Toaster position="bottom-center" toastOptions={{
                style: {
                    background: 'var(--toast-bg)',
                    color: 'var(--toast-fg)',
                    border: '1px solid var(--toast-border)',
                    fontSize: `${fontSize - 1}px`,
                    fontWeight: 500
                }
            }} />
            {signInRequired && !connected && (
                <div role="alert" className="flex shrink-0 items-center justify-center gap-3 bg-amber-950 px-3 py-2 text-sm text-amber-100">
                    Sign in to reconnect to the room.
                    <button type="button" className="font-semibold underline" onClick={() => window.location.reload()}>Sign in again</button>
                </div>
            )}
            {/* Header */}
            <header className={`app-header h-12 border-b border-[color:var(--border-default)] flex items-center gap-2 px-3 shrink-0 bg-[color:var(--bg-primary)]/92 backdrop-blur-md z-50`}>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={() => router.push('/')}
                        aria-label="Back to all rooms"
                        title="Back to all rooms"
                        className="w-8 h-8 rounded-lg flex items-center justify-center transition-opacity hover:opacity-80 shrink-0"
                    >
                        <BrandMark className="w-8 h-8" />
                    </button>
                    {/* The room is what this page is about; the app's name is the
                        logo's job, and stays as the small line underneath. */}
                    <div className="flex min-w-0 flex-col pl-1">
                        <div className="flex min-w-0 items-center gap-2">
                            <h1 className="truncate text-sm font-semibold leading-tight text-white" title={roomId}>{roomName || roomId}</h1>
                            <span
                                role="status"
                                aria-label={connected ? 'Connected to the room' : 'Disconnected from the room'}
                                title={connected ? 'Connected' : 'Disconnected'}
                                className={`h-1.5 w-1.5 shrink-0 rounded-full ${connected ? "bg-emerald-500" : "bg-red-500 animate-pulse"}`}
                            />
                        </div>
                        <span className="text-xs leading-tight text-neutral-500">{APP_NAME}</span>
                    </div>
                </div>

                <div className="ml-auto flex items-center gap-1">
                    {/* Playback State Indicator */}
                    {videoData && (
                        <div className="mr-2 hidden h-7 items-center gap-2 rounded-full border border-white/10 bg-white/5 px-2.5 sm:flex">
                            <div className={`w-2 h-2 rounded-full ${syncState.isPlaying ? 'bg-emerald-400' : 'bg-neutral-500'}`} />
                            <span className="ui-label">
                                {syncState.isPlaying ? 'Playing' : 'Paused'}
                            </span>
                            <span className="text-2xs font-mono text-neutral-500">
                                {Math.floor(actualPlayerTime / 60)}:{Math.floor(actualPlayerTime % 60).toString().padStart(2, '0')}
                            </span>
                        </div>
                    )}
                    {videoData?.added_by && (
                        <span className="mr-1 hidden max-w-[14rem] truncate text-xs text-neutral-500 md:inline" title={`Added by ${videoData.added_by}`}>
                            added by <span className="text-neutral-300">{displayName(videoData.added_by)}</span>
                        </span>
                    )}
                    {videoData?.original_url && (
                        <a
                            href={videoData.original_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={`Open ${videoData.title} on ${displayHost(videoData.original_url)}`}
                            title={`Open on ${displayHost(videoData.original_url)}`}
                            className={ICON_BUTTON}
                        >
                            <ExternalLink aria-hidden="true" className="w-4 h-4" />
                        </a>
                    )}
                    <div className="mx-1 hidden h-7 items-center gap-1.5 rounded-full bg-white/5 px-2.5 sm:flex" title={`${members.length} in the room`}>
                        <Users aria-hidden="true" className="h-3.5 w-3.5 text-neutral-400" />
                        <span className="text-xs font-medium ui-numeric text-neutral-300">{members.length}</span>
                    </div>
                    {attention.notifyState !== 'unsupported' && (
                        <button
                            type="button"
                            onClick={() => attention.notifyState === 'on'
                                ? attention.disableNotifications()
                                : void attention.enableNotifications()}
                            disabled={attention.notifyState === 'denied'}
                            aria-pressed={attention.notifyState === 'on'}
                            aria-label="Notify me when a video starts"
                            title={attention.notifyState === 'denied'
                                ? 'Notifications are blocked for this site in your browser settings'
                                : attention.notifyState === 'on'
                                    ? 'Notifying you when a video starts while this tab is in the background'
                                    : 'Notify me when a video starts while this tab is in the background'}
                            className={attention.notifyState === 'on' ? ICON_BUTTON_ACTIVE : ICON_BUTTON}
                        >
                            {attention.notifyState === 'on'
                                ? <Bell aria-hidden="true" className="w-4 h-4" />
                                : <BellOff aria-hidden="true" className="w-4 h-4" />}
                        </button>
                    )}
                    {/* On a phone the header has room for four buttons; colour mode
                        and diagnostics stay reachable from settings and wider screens. */}
                    <ColorModeToggle className={`${ICON_BUTTON} max-sm:hidden`} />
                    <button
                        type="button"
                        onClick={() => setShowDebug(!showDebug)}
                        aria-pressed={showDebug}
                        aria-label="Diagnostics panel"
                        className={`${showDebug ? ICON_BUTTON_ACTIVE : ICON_BUTTON} max-sm:hidden`}
                        title="Diagnostics panel"
                    >
                        <Bug aria-hidden="true" className="w-4 h-4" />
                    </button>
                    <button
                        type="button"
                        onClick={() => { setSettingsSection(undefined); setShowSettings(true); }}
                        aria-haspopup="dialog"
                        aria-label="Room settings"
                        className={ICON_BUTTON}
                        title="Room settings"
                    >
                        <Settings aria-hidden="true" className="w-4 h-4" />
                    </button>
                </div>
            </header>

            {/* Chrome's Memory Saver unloaded this tab while it was in the
                background: it ran no code, so videos started meanwhile
                went unseen. Only a browser setting prevents it. */}
            {attention.wasDiscarded && (
                <div role="alert" className="shrink-0 flex items-start justify-center gap-3 px-3 py-2 text-sm border-b border-amber-500/30 bg-amber-500/10 text-neutral-200">
                    <AlertTriangle aria-hidden="true" className="w-4 h-4 mt-0.5 shrink-0 text-amber-400" />
                    <span className="max-w-3xl">
                        Your browser unloaded this tab to save memory, so videos the room played while it was away did not reach you.
                        To keep the room live in the background, open <span className="font-mono text-white">chrome://settings/performance</span> and
                        add this site under <span className="text-white">Always keep these sites active</span>, or
                        connect the <a href={EXTENSION_STORE_URL} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 text-white hover:text-[color:var(--accent-primary)]">browser extension</a>, which keeps room tabs loaded for you.
                    </span>
                    <button
                        type="button"
                        onClick={attention.dismissDiscarded}
                        aria-label="Dismiss the unloaded tab warning"
                        className="shrink-0 rounded p-0.5 text-neutral-400 hover:text-white"
                    >
                        <X aria-hidden="true" className="w-4 h-4" />
                    </button>
                </div>
            )}

            {/* The one click that lets this tab start videos with sound.
                Asked for while nothing is at stake: the moment someone
                queues a video, this viewer is usually somewhere else. */}
            {attention.needsGesture && (
                <div role="status" className="shrink-0 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-3 py-2 text-sm border-b border-[color:var(--accent-primary)]/30 bg-[color:var(--accent-glow)] text-neutral-200">
                    <Volume2 aria-hidden="true" className="w-4 h-4 text-[color:var(--accent-primary)]" />
                    <span>Click anywhere in this tab so videos can start with sound when someone adds one.</span>
                    {attention.notifyState === 'off' && (
                        <button
                            type="button"
                            onClick={() => void attention.enableNotifications()}
                            className="underline underline-offset-2 text-white hover:text-[color:var(--accent-primary)]"
                        >
                            Also notify me
                        </button>
                    )}
                </div>
            )}

            {/* Main Content */}
            <div
                className="flex-1 flex flex-col lg:flex-row min-h-0 overflow-hidden relative"
                style={{ '--sidebar-width': `${sidebarWidth}px` } as React.CSSProperties}
            >
                {/* Player Area */}
                <div className="flex-1 flex flex-col p-3 min-w-0 min-h-0 overflow-hidden gap-2.5">
                    {/* Video Player */}
                    <div className="on-dark flex-1 min-h-0 relative rounded-xl overflow-hidden bg-black border border-white/10 shadow-2xl">
                        {/* Loading the next video never hides the one playing: a small
                            pill in the corner while it plays on, a centred spinner only
                            when there is nothing to watch meanwhile. */}
                        {isResolving && (videoData ? (
                            <div
                                role="status"
                                data-loading-video="corner"
                                className="pointer-events-none absolute top-3 right-3 z-20 flex items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-xs text-white backdrop-blur animate-in fade-in duration-300"
                            >
                                <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
                                <span>Loading video…</span>
                            </div>
                        ) : (
                            <div
                                role="status"
                                data-loading-video="centre"
                                className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 animate-in fade-in duration-300"
                            >
                                <Loader2 aria-hidden="true" className="w-5 h-5 text-white animate-spin opacity-80" />
                                <span className="ui-label text-neutral-200">Loading video…</span>
                            </div>
                        ))}
                        {sharedBrowser && (
                            <div className="absolute top-3 left-3 z-20 flex items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-xs text-white backdrop-blur">
                                <Globe aria-hidden="true" className="h-3 w-3" />
                                <span data-testid="shared-browser-banner">
                                    {browserEmbed?.control
                                        ? 'You are driving the shared browser'
                                        : `Shared browser, opened by ${sharedBrowser.opened_by}`}
                                </span>
                            </div>
                        )}
                        {liveShare && (
                            <div className="absolute top-3 left-3 z-20 flex items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-xs text-white backdrop-blur">
                                <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
                                {amSharing ? 'You are sharing your screen' : `${liveShare.email} is sharing their screen`}
                                {!amSharing && viewer.status === 'connecting' && (
                                    <span className="text-neutral-400">· connecting…</span>
                                )}
                                {amSharing && publisher.behind && (
                                    <span data-testid="share-uplink-behind" className="text-amber-300">
                                        · your uplink is behind, try a lower quality
                                    </span>
                                )}
                            </div>
                        )}
                        {liveShare && !amSharing && (viewer.status === 'failed' || viewer.status === 'too-slow') && (
                            <div role="alert" data-testid="share-viewer-problem"
                                className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/80 px-6 text-center">
                                <p className="text-sm font-semibold text-white">
                                    {viewer.status === 'too-slow'
                                        ? 'The shared screen was stopped for you'
                                        : `Could not play ${liveShare.email}'s screen`}
                                </p>
                                <p className="max-w-sm text-xs text-neutral-400">
                                    {viewer.message ?? 'The stream could not be decoded in this browser.'}
                                </p>
                            </div>
                        )}
                        {amSharing && publisher.status === 'failed' && (
                            <div role="alert" data-testid="share-publisher-problem"
                                className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/80 px-6 text-center">
                                <p className="text-sm font-semibold text-white">The room is not receiving your screen</p>
                                <p className="max-w-sm text-xs text-neutral-400">
                                    {publisher.message ?? 'The connection carrying it closed.'}
                                </p>
                            </div>
                        )}
                        {sharedBrowser ? (
                            // neko's own interface, on this origin under the
                            // prefix nginx proxies it at. The cookie that
                            // authenticates it was set by the session call
                            // above and is scoped to that prefix, so nothing
                            // on this page can read it and nothing is passed
                            // in the URL.
                            browserEmbed ? (
                                <iframe
                                    data-testid="shared-browser-frame"
                                    src={browserEmbed.path}
                                    title="Shared browser"
                                    className="h-full w-full border-0 bg-black"
                                    allow="autoplay; clipboard-read; clipboard-write; fullscreen"
                                />
                            ) : (
                                <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center">
                                    {browserError ? (
                                        <p role="alert" className="text-sm text-red-300">{browserError}</p>
                                    ) : (
                                        <>
                                            <Loader2 aria-hidden="true" className="h-5 w-5 animate-spin text-white opacity-80" />
                                            <span className="ui-label text-neutral-200">Joining the shared browser...</span>
                                        </>
                                    )}
                                </div>
                            )
                        ) : liveShare ? (
                            <ErrorBoundary>
                                <CustomPlayer
                                    key={`share-${liveShare.connection_id}`}
                                    url=""
                                    isLive
                                    shareSource={amSharing ? localShareStream : viewer.src}
                                    playerRef={playerRef}
                                    syncThreshold={syncThreshold}
                                    onSyncThresholdChange={setSyncThreshold}
                                />
                            </ErrorBoundary>
                        ) : videoData ? (
                            <ErrorBoundary>
                                <CustomPlayer
                                    // Keyed by the video's identity, not by its
                                    // signed stream URL. Those URLs rotate on
                                    // every re-resolve, and keying on them
                                    // remounted the player — reloading the
                                    // manifest and rebuffering from zero — each
                                    // time the room refreshed them.
                                    // An adaptive video is the exception: its
                                    // player is kept from one video to the next
                                    // (see useShakaPlayer), so every one of them
                                    // shares a key.
                                    key={playsThroughShaka ? 'mse' : `${videoData.original_url}-${useProxy}-${videoData.stream_type}`}
                                    url={getFinalVideoUrl()}
                                    isLive={videoData.is_live}
                                    onSourceExpired={handleSourceExpired}
                                    poster={videoData.thumbnail}
                                    title={videoData.title}
                                    channel={videoData.channel}
                                    autoPlay={syncState.isPlaying}
                                    onPlaybackGateChange={setPlaybackGate}
                                    initialTime={syncState.timestamp} // Pass initial sync timestamp
                                    // DASH-specific props
                                    streamType={videoData.stream_type}
                                    manifestUrl={getManifestUrl()}
                                    originalUrl={videoData.original_url}
                                    preloadNext={preloadNext}
                                    onPrewarm={warmPosition}
                                    onStartupMark={handleStartupMark}
                                    videoUrl={getDashUrls()?.videoUrl}
                                    audioUrl={getDashUrls()?.audioUrl}
                                    availableQualities={getDashUrls()?.availableQualities}
                                    onPlay={() => {
                                        if (internalUpdateCount.current === 0 && !syncState.isPlaying) {
                                            // A live position is only meaningful in this
                                            // player's timeline; never publish it.
                                            const t = videoData.is_live ? 0 : (playerRef.current?.currentTime() || 0);
                                            sendMsg('play', { timestamp: t });
                                            setSyncState(prev => ({ ...prev, isPlaying: true, timestamp: t, lastSync: new Date().toLocaleTimeString() }));
                                        }
                                    }}
                                    onPause={() => {
                                        // The player suppresses only pauses applied by
                                        // sync. Unrelated room messages must not swallow
                                        // a user's pause and let the next heartbeat resume it.
                                        const t = videoData.is_live ? 0 : (playerRef.current?.currentTime() || 0);
                                        sendMsg('pause', { timestamp: t });
                                        setSyncState(prev => ({ ...prev, isPlaying: false, timestamp: t, lastSync: new Date().toLocaleTimeString() }));
                                    }}
                                    onSeeked={(time: number) => {
                                        // Scrubbing a DVR window is a local affair: the
                                        // position does not translate to other players.
                                        if (videoData.is_live) return;
                                        // Never gated on the message counter: `seeked`
                                        // completes only after buffering, so it can land
                                        // beside an unrelated heartbeat or queue update —
                                        // and a swallowed seek leaves the server on the
                                        // old timestamp, whose next heartbeat yanks the
                                        // viewer back to where they seeked away from.
                                        lastLocalSeekAtRef.current = Date.now();
                                        sendMsg('seek', { timestamp: time });
                                        setSyncState(prev => ({ ...prev, timestamp: time, lastSync: new Date().toLocaleTimeString() }));
                                    }}
                                    // Named, so the server can tell this member's
                                    // report of the end from a stale one after
                                    // the room has already moved on.
                                    onEnd={() => sendMsg('video_ended', { original_url: videoData.original_url })}
                                    onPlaying={() => sendMsg('playback_ready', { original_url: videoData.original_url })}
                                    onQualityReport={(report) => sendMsg('playback_quality', report)}
                                    onTimeUpdate={(time: number) => {
                                        // Update actual player time for accurate badge display
                                        setActualPlayerTime(time);

                                    }}
                                    playerRef={playerRef}
                                    syncThreshold={syncThreshold}
                                    onSyncThresholdChange={setSyncThreshold}
                                    sponsorSegments={sponsorSegments.videoUrl === videoData.original_url ? sponsorSegments.segments : []}
                                    upcomingJump={upcomingSkip?.videoUrl === videoData.original_url ? upcomingSkip : null}
                                    storyboard={videoData.storyboard}
                                    chapters={videoData.chapters}
                                />
                            </ErrorBoundary>
                        ) : isResolving ? null : (
                            <div className="h-full w-full flex flex-col items-center justify-center gap-4 px-6 text-center">
                                <Mascot followPointer className="h-20 w-20 sm:h-24 sm:w-24" />
                                <div>
                                    <h2 className="text-base font-semibold text-neutral-100">Nothing playing yet</h2>
                                    <p className="text-sm text-neutral-400 mt-1 max-w-xs">
                                        Paste a video link below to start watching, or add one to the queue.
                                    </p>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Debug Panel */}
                    {showDebug && (
                        <section aria-label="Diagnostics" className="bg-[color:var(--bg-tertiary)]/90 backdrop-blur-xl border border-[color:var(--border-default)] rounded-lg p-3 font-mono text-2xs text-neutral-300 shrink-0 relative group/debug">
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
                                    setTimeout(() => setIsCopyingDebug(false), COPY_FEEDBACK_DURATION_MS);
                                    toast.success("Debug info copied");
                                }}
                                className="absolute top-2 right-2 p-1.5 rounded-md bg-neutral-900/50 hover:bg-neutral-800 border border-neutral-800 text-neutral-400 hover:text-white transition-all opacity-0 focus-visible:opacity-100 group-hover/debug:opacity-100 flex items-center gap-1.5"
                                title="Copy diagnostics"
                                aria-label="Copy diagnostics to the clipboard"
                            >
                                {isCopyingDebug ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                                <span className="ui-label">{isCopyingDebug ? 'Copied' : 'Copy all'}</span>
                            </button>
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                                <div>
                                    <span className="ui-label">WebSocket</span>
                                    <div className={`font-semibold ${connected ? 'text-emerald-400' : 'text-red-400'}`}>
                                        {connected ? 'CONNECTED' : 'DISCONNECTED'}
                                    </div>
                                </div>
                                <div>
                                    <span className="ui-label">Playback</span>
                                    <div className="font-semibold text-white">
                                        {syncState.isPlaying ? '▶ PLAYING' : '⏸ PAUSED'}
                                    </div>
                                </div>
                                <div>
                                    <span className="ui-label">Timestamp</span>
                                    <div className="font-semibold text-white">
                                        {syncState.timestamp.toFixed(2)}s
                                    </div>
                                </div>
                                <div>
                                    <span className="ui-label">Last Sync</span>
                                    <div className="font-semibold text-white">
                                        {syncState.lastSync || 'N/A'}
                                    </div>
                                </div>
                                <div>
                                    <span className="ui-label">Queue</span>
                                    <div className="font-semibold text-white">
                                        {queue.length} {queue.length === 1 ? 'item' : 'items'}{playingIndex >= 0 ? ` (#${playingIndex + 1})` : ''}
                                    </div>
                                </div>
                                <div>
                                    <span className="ui-label">Video</span>
                                    <div className="font-semibold text-white truncate" title={videoData?.title}>
                                        {videoData?.title || 'None'}
                                    </div>
                                </div>
                                <div>
                                    <span className="ui-label">Proxy</span>
                                    <div className={`font-semibold ${useProxy ? 'text-emerald-400' : 'text-neutral-500'}`}>
                                        {useProxy ? 'ENABLED' : 'DISABLED'}
                                    </div>
                                </div>
                                <div>
                                    <span className="ui-label">Stream Type</span>
                                    <div className={`font-semibold ${videoData?.stream_type === 'dash' ? 'text-[color:var(--accent-primary)]' : 'text-emerald-400'}`}>
                                        {videoData?.stream_type?.toUpperCase() || 'N/A'} {videoData?.quality && `(${videoData.quality})`}
                                    </div>
                                </div>
                                <div>
                                    <span className="ui-label">Qualities</span>
                                    <div className="font-semibold text-white">
                                        {videoData?.available_qualities?.length || 0} options
                                    </div>
                                </div>
                                <div>
                                    <span className="ui-label">DASH URLs</span>
                                    <div className={`font-semibold ${videoData?.video_url && videoData?.audio_url ? 'text-emerald-400' : 'text-red-400'}`}>
                                        {videoData?.video_url && videoData?.audio_url ? 'V+A OK' : 'N/A'}
                                    </div>
                                </div>
                                <div>
                                    <span className="ui-label">Members</span>
                                    <div className="font-semibold text-white">
                                        {members.length} online
                                    </div>
                                </div>
                            </div>
                        </section>
                    )}

                    {/* Most videos need a signed-in session. A member without the
                        extension has none to offer, so suggest it once — until
                        cookies arrive or the viewer dismisses the hint. */}
                    {currentUser && currentUser !== 'Guest' && !isLoadingCookies && !hasSavedCookies && !extensionHintDismissed && (
                        <div
                            role="status"
                            data-testid="extension-hint"
                            className="flex shrink-0 items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] py-2 pl-3 pr-2 text-sm text-neutral-300"
                        >
                            <Puzzle aria-hidden="true" className="h-4 w-4 shrink-0 text-[color:var(--accent-primary)]" />
                            <p className="flex-1 leading-snug">
                                Many videos only play with a signed-in account. Install the browser extension so the room can use your session.
                            </p>
                            <button
                                type="button"
                                onClick={() => { setSettingsSection('account'); setShowSettings(true); }}
                                className={`${BUTTON_PRIMARY} h-8 px-3 text-xs`}
                            >
                                Install
                            </button>
                            <button
                                type="button"
                                onClick={() => setExtensionHintDismissed(true)}
                                aria-label="Dismiss the extension hint"
                                className={ICON_BUTTON}
                            >
                                <X aria-hidden="true" className="h-4 w-4" />
                            </button>
                        </div>
                    )}

                    {/* URL input */}
                    <form onSubmit={handleLoadNow} className="flex flex-wrap gap-2 shrink-0">
                        <div className="relative flex-1 min-w-[12rem]">
                            <label htmlFor="room-video-url" className="sr-only">Video URL</label>
                            <LinkIcon aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-neutral-500" />
                            <input
                                id="room-video-url"
                                type="url"
                                inputMode="url"
                                autoComplete="off"
                                className="h-9 w-full rounded-lg border border-white/10 bg-white/5 pl-9 pr-3 text-ui text-white transition-colors placeholder:text-neutral-500 hover:border-white/20"
                                placeholder="Paste video URL..."
                                value={inputUrl}
                                onChange={e => setInputUrl(e.target.value)}
                            />
                        </div>
                        <button
                            type="submit"
                            disabled={loading || !inputUrl}
                            aria-busy={loading}
                            className={BUTTON_PRIMARY}
                        >
                            {loading ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : <Play aria-hidden="true" className="h-3.5 w-3.5 fill-current" />}
                            Play
                        </button>
                        <button
                            type="button"
                            onClick={handleAddToQueue}
                            disabled={loading || !inputUrl}
                            className={BUTTON_SECONDARY}
                        >
                            <Plus aria-hidden="true" className="h-4 w-4" />
                            Queue
                        </button>
                        {playlistInput.hasPlaylist && canImportPlaylist && (
                            <button type="button" disabled={loading}
                                onClick={() => setPlaylistDialogUrl(inputUrl.trim())}
                                className={BUTTON_SECONDARY}>
                                <ListVideo aria-hidden="true" className="h-4 w-4" />
                                Import playlist
                            </button>
                        )}
                        {amSharing ? (
                            <button
                                type="button"
                                onClick={() => stopSharing()}
                                className={BUTTON_DANGER}
                            >
                                <MonitorStop aria-hidden="true" className="h-4 w-4" />
                                <span className="max-sm:sr-only">Stop sharing</span>
                            </button>
                        ) : (
                            <button
                                type="button"
                                onClick={() => { setShareError(null); setShareDialogOpen(true); }}
                                disabled={!!liveShare || !!sharedBrowser}
                                title={liveShare
                                    ? `${liveShare.email} is already sharing`
                                    : sharedBrowser
                                        ? 'The shared browser is on the player'
                                        : 'Share your screen with the room'}
                                className={BUTTON_SECONDARY}
                            >
                                <MonitorUp aria-hidden="true" className="h-4 w-4" />
                                <span className="max-sm:sr-only">Share screen</span>
                            </button>
                        )}
                        {sharedBrowser ? (
                            <button
                                type="button"
                                onClick={closeSharedBrowser}
                                data-testid="close-shared-browser"
                                className={BUTTON_DANGER}
                            >
                                <Globe aria-hidden="true" className="h-4 w-4" />
                                <span className="max-sm:sr-only">Close browser</span>
                            </button>
                        ) : (
                            <button
                                type="button"
                                onClick={() => { setBrowserError(null); setBrowserDialogOpen(true); }}
                                data-testid="open-shared-browser"
                                disabled={!!liveShare}
                                title={liveShare
                                    ? 'Someone is sharing their screen'
                                    : browserBlockedText ?? 'Open a browser everyone can watch and take turns driving'}
                                className={BUTTON_SECONDARY}
                            >
                                <Globe aria-hidden="true" className="h-4 w-4" />
                                <span className="max-sm:sr-only">Shared browser</span>
                            </button>
                        )}
                    </form>

                    {playlistDialogUrl && (
                        <PlaylistPreviewDialog
                            key={`${roomId}:${playlistDialogUrl}`}
                            roomId={roomId}
                            url={playlistDialogUrl}
                            onClose={() => setPlaylistDialogUrl(null)}
                            onImported={(added, skipped) => {
                                setPlaylistDialogUrl(null);
                                setInputUrl('');
                                toast.success(`Added ${added} video${added === 1 ? '' : 's'} to the queue${skipped ? `; skipped ${skipped} already queued` : ''}.`);
                            }}
                        />
                    )}

                    {/* Whether a shared browser can be opened at all, said
                        before the button does anything. It is a deployment
                        question — the picture is WebRTC and this deployment
                        publishes no ports — so when the answer is no, the
                        room says which piece is missing rather than opening
                        a black rectangle. */}
                    {browserDialogOpen && (
                        <div
                            role="dialog"
                            aria-modal="true"
                            aria-label="Shared browser"
                            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
                            onClick={() => setBrowserDialogOpen(false)}
                        >
                            <div
                                onClick={(event) => event.stopPropagation()}
                                className="w-full max-w-md rounded-2xl border border-white/10 bg-[color:var(--bg-elevated)] p-6 shadow-2xl"
                            >
                                <h2 className="ui-heading">Shared browser</h2>
                                <p className="mt-2 text-sm leading-relaxed text-neutral-400">
                                    A browser runs on the server and everyone in the room watches
                                    the same page. The room admin drives it; the video playing now
                                    pauses and comes back when the browser is closed.
                                </p>
                                {browserBlockedText ? (
                                    <p
                                        role="alert"
                                        data-testid="shared-browser-unavailable"
                                        className="mt-3 text-xs leading-relaxed text-amber-200/90"
                                    >
                                        {browserBlockedText}
                                    </p>
                                ) : browserStatus?.held_by_room && browserStatus.held_by_room !== roomId ? (
                                    <p
                                        role="alert"
                                        data-testid="shared-browser-unavailable"
                                        className="mt-3 text-xs leading-relaxed text-amber-200/90"
                                    >
                                        The room &ldquo;{browserStatus.held_by_room}&rdquo; is using it right now.
                                        There is one browser for the whole instance.
                                    </p>
                                ) : (
                                    <p className="mt-3 text-xs leading-relaxed text-neutral-500">
                                        Anything typed into it — including passwords — is visible
                                        to everyone in the room, and stays in the browser after
                                        you close it.
                                    </p>
                                )}
                                <div className="mt-6 flex justify-end gap-2">
                                    <button
                                        type="button"
                                        onClick={() => setBrowserDialogOpen(false)}
                                        className={BUTTON_SECONDARY}
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        type="button"
                                        onClick={openSharedBrowser}
                                        data-testid="confirm-shared-browser"
                                        disabled={!!browserBlockedText}
                                        className={BUTTON_PRIMARY}
                                    >
                                        Open it
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* What sharing a screen means, said before the picker opens */}
                    {shareDialogOpen && (
                        <div
                            role="dialog"
                            aria-modal="true"
                            aria-label="Share your screen"
                            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
                            onClick={() => setShareDialogOpen(false)}
                        >
                            <div
                                onClick={(event) => event.stopPropagation()}
                                className="w-full max-w-md rounded-2xl border border-white/10 bg-[color:var(--bg-elevated)] p-6 shadow-2xl"
                            >
                                <h2 className="ui-heading">Share your screen</h2>
                                <p className="mt-2 text-sm leading-relaxed text-neutral-400">
                                    Your browser will ask which window to share, and whether to
                                    include its sound. The room watches it live while it runs; the
                                    video playing now pauses and comes back afterwards.
                                </p>
                                <label htmlFor="share-quality" className="ui-label mt-5 block">
                                    Quality
                                </label>
                                <select
                                    id="share-quality"
                                    value={shareQuality}
                                    onChange={(event) => setShareQuality(event.target.value as ShareQuality)}
                                    className="mt-1.5 h-9 w-full rounded-lg border border-white/10 bg-white/5 px-2.5 text-sm text-white"
                                >
                                    {Object.entries(SHARE_QUALITY_PRESETS).map(([value, preset]) => (
                                        <option key={value} value={value}>{preset.label}</option>
                                    ))}
                                </select>
                                <p className="mt-2 text-xs leading-relaxed text-neutral-500">
                                    About {(SHARE_QUALITY_PRESETS[shareQuality].maxBitrateBps / 1_000_000).toFixed(0)} Mbit/s
                                    of your upload, whoever is watching: you send one copy and the
                                    server passes it on.
                                </p>
                                <p className="mt-3 text-xs leading-relaxed text-amber-200/90">
                                    The picture travels through this server, so it arrives about a
                                    second late — and every viewer costs the server that much
                                    bandwidth again.
                                </p>
                                {shareError && (
                                    <p role="alert" className="mt-3 text-xs text-red-300">{shareError}</p>
                                )}
                                <div className="mt-6 flex justify-end gap-2">
                                    <button
                                        type="button"
                                        onClick={() => setShareDialogOpen(false)}
                                        className={BUTTON_SECONDARY}
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => void startSharing()}
                                        className={BUTTON_PRIMARY}
                                    >
                                        Choose what to share
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                {/* Resize Handle (pointer-only affordance, desktop layout) */}
                <div
                    onMouseDown={startResizing}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Resize the sidebar"
                    className="hidden lg:block absolute top-0 bottom-0 right-[var(--sidebar-width)] z-10 w-1 px-[1.5px] cursor-col-resize group transition-colors hover:bg-neutral-700"
                >
                    <div className="h-full w-full bg-neutral-800 group-hover:bg-[color:var(--accent-primary)]" />
                </div>

                {/* Resizable Sidebar */}
                <aside
                    aria-label="Queue, audience, live chat and room log"
                    className="app-surface border-t lg:border-t-0 lg:border-l border-white/10 flex flex-col shrink-0 bg-neutral-900/30 h-[42dvh] w-full lg:h-auto lg:w-[var(--sidebar-width)]"
                >
                    {/* Compact Tabs */}
                    <div role="tablist" aria-label="Sidebar sections" className={`grid ${hasChapters ? 'grid-cols-5' : 'grid-cols-4'} p-1.5 gap-1 border-b border-white/10 shrink-0`}>
                        <button
                            type="button"
                            role="tab"
                            id="sidebar-tab-queue"
                            aria-controls="sidebar-panel"
                            aria-selected={sidebarTab === 'queue'}
                            onClick={() => setSidebarTab('queue')}
                            className={`flex h-8 min-w-0 items-center justify-center rounded-lg px-1 text-ui font-medium transition-colors ${sidebarTab === 'queue'
                                ? "bg-white/10 text-white"
                                : "text-neutral-400 hover:bg-white/5 hover:text-neutral-200"
                                }`}
                        >
                            <span className="truncate">Queue</span><span className="sr-only"> ({queue.length})</span>{queue.length > 0 && <span aria-hidden="true" className="ui-numeric ml-1.5 rounded-full bg-white/10 px-1.5 text-2xs text-neutral-300">{queue.length}</span>}
                        </button>
                        <button
                            type="button"
                            role="tab"
                            id="sidebar-tab-users"
                            aria-controls="sidebar-panel"
                            aria-selected={sidebarTab === 'users'}
                            onClick={() => setSidebarTab('users')}
                            className={`flex h-8 min-w-0 items-center justify-center rounded-lg px-1 text-ui font-medium transition-colors ${sidebarTab === 'users'
                                ? "bg-white/10 text-white"
                                : "text-neutral-400 hover:bg-white/5 hover:text-neutral-200"
                                }`}
                        >
                            <span className="truncate">Audience</span><span className="sr-only"> ({members.length})</span>
                        </button>
                        <button
                            type="button"
                            role="tab"
                            id="sidebar-tab-chat"
                            aria-controls="sidebar-panel"
                            aria-selected={sidebarTab === 'chat'}
                            onClick={() => setSidebarTab('chat')}
                            aria-label="Live chat"
                            className={`flex h-8 min-w-0 items-center justify-center rounded-lg px-1 text-ui font-medium transition-colors ${sidebarTab === 'chat' ? 'bg-white/10 text-white' : 'text-neutral-400 hover:bg-white/5 hover:text-neutral-200'}`}
                        >
                            Chat
                        </button>
                        {hasChapters && (
                            <button
                                type="button"
                                role="tab"
                                id="sidebar-tab-chapters"
                                aria-controls="sidebar-panel"
                                aria-selected={sidebarTab === 'chapters'}
                                onClick={() => setSidebarTab('chapters')}
                                className={`flex h-8 min-w-0 items-center justify-center rounded-lg px-1 text-ui font-medium transition-colors ${sidebarTab === 'chapters' ? 'bg-white/10 text-white' : 'text-neutral-400 hover:bg-white/5 hover:text-neutral-200'}`}
                            >
                                Chapters<span className="sr-only"> ({chapters.length})</span>
                            </button>
                        )}
                        <button
                            type="button"
                            role="tab"
                            id="sidebar-tab-log"
                            aria-controls="sidebar-panel"
                            aria-selected={sidebarTab === 'log'}
                            onClick={() => setSidebarTab('log')}
                            className={`flex h-8 min-w-0 items-center justify-center rounded-lg px-1 text-ui font-medium transition-colors ${sidebarTab === 'log' ? 'bg-white/10 text-white' : 'text-neutral-400 hover:bg-white/5 hover:text-neutral-200'}`}
                        >
                            Log
                        </button>
                    </div>

                    {/* Content */}
                    <div
                        id="sidebar-panel"
                        role="tabpanel"
                        aria-labelledby={`sidebar-tab-${sidebarTab}`}
                        className="flex-1 overflow-hidden relative"
                    >
                        {sidebarTab === 'chapters' ? (
                            <div data-testid="chapter-list" className="h-full overflow-y-auto p-2 space-y-0.5 custom-scrollbar">
                                {chapters.map((chapter) => {
                                    const active = chapterAt(chapters, syncState.timestamp)?.start === chapter.start;
                                    return (
                                        <button
                                            type="button"
                                            key={chapter.start}
                                            onClick={() => seekRoom(chapter.start)}
                                            aria-current={active ? 'true' : undefined}
                                            className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors ${active
                                                ? 'bg-neutral-800 text-white'
                                                : 'text-neutral-300 hover:bg-white/5 hover:text-white'
                                                }`}
                                        >
                                            <span className="w-12 shrink-0 tabular-nums text-xs text-neutral-400">
                                                {formatChapterTime(chapter.start)}
                                            </span>
                                            <span className="min-w-0 truncate">{chapter.title}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        ) : sidebarTab === 'log' ? (
                            <RoomLog events={activityLog} />
                        ) : sidebarTab === 'chat' ? (
                            <LiveChat key={`${videoData?.original_url}:${videoData?.is_live}`} video={videoData} />
                        ) : sidebarTab === 'queue' ? (
                            <DndContext
                                sensors={sensors}
                                collisionDetection={closestCenter}
                                onDragStart={handleDragStart}
                                onDragEnd={handleDragEnd}
                            >
                                <div className="h-full flex flex-col">
                                    <div className="flex-1 overflow-y-auto p-2 space-y-1 custom-scrollbar">
                                        {queue.length === 0 && (
                                            <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
                                                <Mascot mood="sleepy" className="h-12 w-12" />
                                                <p className="max-w-[16rem] text-xs text-neutral-400">
                                                    The queue is empty. Paste a link and choose Queue to line up a video.
                                                </p>
                                            </div>
                                        )}
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
                                                    // The active row tracks the player live; the
                                                    // rest show the server's last save.
                                                    progress={playingIndex === index ? actualPlayerTime : (item.progress ?? 0)}
                                                    fontSize={fontSize}
                                                    onPlay={(i) => {
                                                        if (loadingQueueIndex !== i) {
                                                            setLoadingQueueIndex(i);
                                                            sendMsg('queue_play', { index: i });
                                                        }
                                                    }}
                                                    onRemove={(i) => sendMsg('queue_remove', { index: i })}
                                                    onPin={(i) => sendMsg('queue_pin', { index: i })}
                                                    onHoverRest={warmQueueEntry}
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
                                            />
                                        ) : null}
                                    </DragOverlay>
                                    <div className="shrink-0 border-t border-white/10 p-2">
                                        <button
                                            type="button"
                                            disabled={queue.length === 0}
                                            onClick={() => sendMsg('video_ended')}
                                            className={`${BUTTON_SECONDARY} w-full`}
                                        >
                                            <SkipForward aria-hidden="true" className="h-4 w-4" />
                                            Play next
                                        </button>
                                    </div>
                                </div>
                            </DndContext>
                        ) : (

                            <div className="h-full overflow-y-auto p-2 space-y-0.5 custom-scrollbar">
                                {members.length === 0 && (
                                    <p className="px-4 py-10 text-center text-xs text-neutral-400">
                                        Nobody else is here yet. Share the room link to invite someone.
                                    </p>
                                )}
                                {members.map((m) => {
                                    const role = roles[m.email] || 'user';
                                    const myRole = roles[currentUser] || 'user';
                                    const isAdmin = myRole === 'admin';

                                    return (
                                        <div key={m.email} className="group flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-white/5">
                                            <div className="relative shrink-0">
                                                <div aria-hidden="true" className="flex h-8 w-8 items-center justify-center rounded-full bg-[color:var(--accent-glow)] text-xs font-semibold text-[color:var(--accent-primary)]">
                                                    {displayName(m.email).charAt(0).toUpperCase()}
                                                </div>
                                                <span aria-hidden="true" className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[color:var(--bg-secondary)] bg-emerald-500" />
                                            </div>
                                            <div className="flex min-w-0 flex-1 flex-col">
                                                <p className="flex min-w-0 items-center gap-1.5 font-medium text-neutral-100" style={{ fontSize: `${fontSize - 1}px` }} title={m.email}>
                                                    <span className="truncate">{displayName(m.email)}</span>
                                                    {currentUser === m.email && <span className="shrink-0 font-normal text-neutral-500">(you)</span>}
                                                    {role === 'admin' && <span className="flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-1.5 text-2xs font-medium text-amber-400"><Crown aria-hidden="true" className="h-3 w-3" /> Admin</span>}
                                                    {role === 'moderator' && <span className="flex shrink-0 items-center gap-1 rounded-full bg-blue-500/15 px-1.5 text-2xs font-medium text-blue-400"><Shield aria-hidden="true" className="h-3 w-3" /> Moderator</span>}
                                                </p>
                                                <p className="truncate text-xs text-neutral-500">{m.email}</p>
                                            </div>

                                            {isAdmin && currentUser !== m.email && (
                                                <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                                                    {role !== 'admin' && (
                                                        <button
                                                            type="button"
                                                            onClick={() => sendMsg('promote', { target_email: m.email, role: 'admin' })}
                                                            className="flex h-7 w-7 items-center justify-center rounded-lg text-neutral-400 hover:bg-amber-500/15 hover:text-amber-400"
                                                            title="Promote to admin"
                                                            aria-label={`Promote ${m.email} to admin`}
                                                        >
                                                            <Crown aria-hidden="true" className="h-3.5 w-3.5" />
                                                        </button>
                                                    )}
                                                    {role !== 'moderator' && role !== 'admin' && (
                                                        <button
                                                            type="button"
                                                            onClick={() => sendMsg('promote', { target_email: m.email, role: 'moderator' })}
                                                            className="flex h-7 w-7 items-center justify-center rounded-lg text-neutral-400 hover:bg-blue-500/15 hover:text-blue-400"
                                                            title="Promote to moderator"
                                                            aria-label={`Promote ${m.email} to moderator`}
                                                        >
                                                            <Shield aria-hidden="true" className="h-3.5 w-3.5" />
                                                        </button>
                                                    )}
                                                    {role !== 'user' && (
                                                        <button
                                                            type="button"
                                                            onClick={() => sendMsg('promote', { target_email: m.email, role: 'user' })}
                                                            className="flex h-7 w-7 items-center justify-center rounded-lg text-neutral-400 hover:bg-white/10 hover:text-neutral-200"
                                                            title="Demote to viewer"
                                                            aria-label={`Demote ${m.email} to viewer`}
                                                        >
                                                            <UserIcon aria-hidden="true" className="h-3.5 w-3.5" />
                                                        </button>
                                                    )}
                                                </div>
                                            )}

                                        </div>
                                    );
                                })}
                            </div>
                        )
                        }
                    </div >
                </aside >
            </div >

            {showSettings && (
                <RoomSettingsDialog
                    onClose={() => setShowSettings(false)}
                    initialSection={settingsSection}
                    isAdmin={roles[currentUser] === 'admin'}
                    signedIn={Boolean(currentUser) && currentUser !== 'Guest'}
                    roomId={roomId}
                    roomName={roomName}
                    onRename={(name) => {
                        pendingRenameRef.current = name;
                        sendMsg('rename_room', { name });
                    }}
                    isPermanent={isPermanent}
                    onTogglePermanent={() => sendMsg('toggle_permanent', {})}
                    sponsorBlock={sponsorBlock}
                    onSponsorBlockChange={(settings) => sendMsg('sponsorblock_settings', settings)}
                    activeTheme={activeTheme}
                    onThemeChange={setActiveTheme}
                    fontSize={fontSize}
                    onFontSizeChange={setFontSize}
                    useProxy={useProxy}
                    onProxyChange={setUseProxy}
                    isLoadingCookies={isLoadingCookies}
                    hasSavedCookies={hasSavedCookies}
                    cookieStatus={cookieStatus}
                    onForgetCookies={async () => {
                        try {
                            await forgetCookies();
                            setHasSavedCookies(false);
                            setCookieStatus({ has_cookies: false });
                            toast.success('Cookies dropped from the server');
                        } catch (err: unknown) {
                            toast.error(getErrorMessage(err, 'Failed to forget cookies'));
                        }
                    }}
                    userSettings={userSettings}
                    onUserSettingsChange={async (patch) => {
                        try {
                            setUserSettings(await updateUserSettings(patch));
                        } catch (err: unknown) {
                            toast.error(getErrorMessage(err, 'Could not save the setting'));
                        }
                    }}
                />
            )}
        </main >
    );
}
