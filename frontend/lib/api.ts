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
