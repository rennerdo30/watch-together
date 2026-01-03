// When running server-side (SSG/SSR), use internal docker URL. Client-side use relative path.
const API_BASE_URL = typeof window === 'undefined' ? (process.env.BACKEND_URL || 'http://backend:8000') : '';

export interface ResolveResponse {
    original_url: string;
    stream_url: string;
    title: string;
    is_live: boolean;
    thumbnail?: string;
    backend_engine: string;
}

export async function resolveUrl(url: string): Promise<ResolveResponse> {
    const encodedUrl = encodeURIComponent(url);
    const ua = typeof window !== 'undefined' ? encodeURIComponent(navigator.userAgent) : '';
    const res = await fetch(`${API_BASE_URL}/api/resolve?url=${encodedUrl}&user_agent=${ua}`);

    if (!res.ok) {
        const errorData = await res.json().catch(() => ({ detail: 'Unknown error' }));
        throw new Error(errorData.detail || 'Failed to resolve URL');
    }

    return res.json();
}
export async function fetchRooms(): Promise<any[]> {
    const res = await fetch(`${API_BASE_URL}/api/rooms`, { cache: 'no-store' });
    if (!res.ok) return [];
    return res.json();
}
