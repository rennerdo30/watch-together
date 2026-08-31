import { BACKEND_ORIGIN } from '@/lib/constants';

// When running server-side (SSG/SSR), use internal docker URL. Client-side
// requests stay relative so nginx routes them, unless BACKEND_ORIGIN points
// at the backend directly (running without a reverse proxy).
const API_BASE_URL = typeof window === 'undefined'
    ? (process.env.BACKEND_URL || 'http://backend:8000')
    : BACKEND_ORIGIN;

export interface QualityOption {
    height: number;
    width: number;
    video_url: string;
    format_id: string;
    vcodec: string;
    tbr?: number;
}

export interface AudioOption {
    abr: number;
    audio_url: string;
    format_id: string;
    acodec: string;
}

export interface ResolveResponse {
    original_url: string;
    stream_url: string;
    title: string;
    is_live: boolean;
    thumbnail?: string;
    backend_engine: string;
    pinned?: boolean;
    quality?: string;
    has_audio?: boolean;
    stream_type?: 'hls' | 'dash' | 'combined' | 'video_only' | 'default' | 'unknown';
    // DASH-specific fields
    video_url?: string;
    audio_url?: string;
    available_qualities?: QualityOption[];
    audio_options?: AudioOption[];
}

export interface RoomSummary {
    id: string;
    active_users: number;
    /** Admin-set display name; empty when the room only has its id. */
    name?: string;
    current_video?: string;
    queue_size: number;
}

export async function resolveUrl(url: string): Promise<ResolveResponse> {
    const encodedUrl = encodeURIComponent(url);
    const ua = typeof window !== 'undefined' ? encodeURIComponent(navigator.userAgent) : '';

    // Pass user identity for cookie lookup (dev mode uses query param)
    let userParam = '';
    if (typeof window !== 'undefined') {
        const searchParams = new URLSearchParams(window.location.search);
        const mockUser = searchParams.get('user');
        if (mockUser) userParam = `&user=${encodeURIComponent(mockUser)}`;
    }

    const res = await fetch(`${API_BASE_URL}/api/resolve?url=${encodedUrl}&user_agent=${ua}${userParam}`);

    if (!res.ok) {
        const errorData = await res.json().catch(() => ({ detail: 'Unknown error' }));
        throw new Error(errorData.detail || 'Failed to resolve URL');
    }

    return res.json();
}
export async function fetchRooms(): Promise<RoomSummary[]> {
    const res = await fetch(`${API_BASE_URL}/api/rooms`, { cache: 'no-store' });
    if (!res.ok) {
        const errorData = await res.json().catch(() => ({ detail: 'Unknown error' }));
        throw new Error(errorData.detail || 'Failed to load the room list');
    }
    const data = await res.json();
    if (!Array.isArray(data)) {
        throw new Error('The room list response was not a list of rooms');
    }
    return data as RoomSummary[];
}

// ============================================================================
// Admin API
// ============================================================================

export class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
        super(message);
        this.status = status;
    }
}

export interface AdminRoom {
    id: string;
    name: string;
    active_users: number;
    members: string[];
    current_video: string | null;
    is_live: boolean;
    is_playing: boolean;
    queue_size: number;
    permanent: boolean;
}

export interface AdminOverview {
    requested_by: string;
    uptime_seconds: number;
    totals: { rooms: number; viewers: number };
    rooms: AdminRoom[];
    cookie_users: string[];
}

export interface AdminSegmentEntry {
    name: string;
    bytes: number;
    age_seconds: number;
}

export interface AdminFormatEntry {
    original_url: string;
    title: string | null;
    is_live: boolean;
    stream_type: string | null;
    created_at: number | null;
    expires_at: number | null;
    age_seconds: number | null;
    expires_in_seconds: number | null;
}

export interface AdminCacheReport {
    segments: {
        entries_total: number;
        bytes_total: number;
        budget_bytes: number;
        oldest_age_seconds: number | null;
        disk_free_bytes: number | null;
        entries: AdminSegmentEntry[];
    };
    memory: {
        items: number;
        size_mb: number;
        max_mb: number;
        audio_items: number;
        hits: number;
        misses: number;
        hit_rate_percent: number;
    };
    formats: AdminFormatEntry[];
    proxy: {
        uptime_seconds: number;
        totals: Record<string, number>;
        by_outcome: Record<string, number>;
        by_host: Record<string, Record<string, number>>;
        recent_failures: Record<string, unknown>[];
        recent_samples: Record<string, unknown>[];
    };
}

// Identity travels as a query parameter in development mode, the same way
// the other client calls carry it.
const devUserSuffix = (leading: '?' | '&'): string => {
    if (typeof window === 'undefined') return '';
    const user = new URLSearchParams(window.location.search).get('user');
    return user ? `${leading}user=${encodeURIComponent(user)}` : '';
};

async function adminFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const suffix = devUserSuffix(path.includes('?') ? '&' : '?');
    const res = await fetch(`${API_BASE_URL}${path}${suffix}`, { cache: 'no-store', ...init });
    if (!res.ok) {
        const body = await res.json().catch(() => ({ detail: null }));
        throw new ApiError(body.detail || `Request failed (${res.status})`, res.status);
    }
    return res.json() as Promise<T>;
}

export function fetchAdminOverview(): Promise<AdminOverview> {
    return adminFetch<AdminOverview>('/api/admin/overview');
}

export function fetchAdminCache(): Promise<AdminCacheReport> {
    return adminFetch<AdminCacheReport>('/api/admin/cache');
}

export function clearAdminCache(target: 'segments' | 'formats' | 'memory'): Promise<Record<string, number>> {
    return adminFetch<Record<string, number>>(`/api/admin/cache/${target}`, { method: 'DELETE' });
}

export function closeAdminRoom(roomId: string): Promise<{ closed: string }> {
    return adminFetch<{ closed: string }>(`/api/admin/rooms/${encodeURIComponent(roomId)}`, { method: 'DELETE' });
}

// ============================================================================
// Extension Token API
// ============================================================================

export interface ExtensionToken {
    id: string;
    created_at: number;
    last_used_at: number;
    last_sync_at: number | null;
    sync_count: number;
}

export interface TokenResponse {
    status: string;
    token: ExtensionToken;
    message?: string;
}

function getUserParam(): string {
    if (typeof window === 'undefined') return '';
    const searchParams = new URLSearchParams(window.location.search);
    const mockUser = searchParams.get('user');
    return mockUser ? `?user=${encodeURIComponent(mockUser)}` : '';
}

export interface CurrentUser {
    authenticated: boolean;
    email: string | null;
}

export async function getCurrentUser(): Promise<CurrentUser> {
    const res = await fetch(`${API_BASE_URL}/api/me${getUserParam()}`);
    if (!res.ok) {
        return { authenticated: false, email: null };
    }
    return res.json();
}

export async function getExtensionToken(): Promise<TokenResponse> {
    const res = await fetch(`${API_BASE_URL}/api/token${getUserParam()}`);
    if (!res.ok) {
        const errorData = await res.json().catch(() => ({ detail: 'Unknown error' }));
        throw new Error(errorData.detail || 'Failed to get token');
    }
    return res.json();
}

export async function regenerateExtensionToken(): Promise<TokenResponse> {
    const res = await fetch(`${API_BASE_URL}/api/token/regenerate${getUserParam()}`, {
        method: 'POST',
    });
    if (!res.ok) {
        const errorData = await res.json().catch(() => ({ detail: 'Unknown error' }));
        throw new Error(errorData.detail || 'Failed to regenerate token');
    }
    return res.json();
}

export async function revokeExtensionToken(): Promise<{ status: string; message: string }> {
    const res = await fetch(`${API_BASE_URL}/api/token${getUserParam()}`, {
        method: 'DELETE',
    });
    if (!res.ok) {
        const errorData = await res.json().catch(() => ({ detail: 'Unknown error' }));
        throw new Error(errorData.detail || 'Failed to revoke token');
    }
    return res.json();
}
