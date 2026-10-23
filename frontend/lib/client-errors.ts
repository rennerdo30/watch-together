import { BACKEND_ORIGIN } from './constants';

export type ClientErrorSource = 'shaka' | 'hls' | 'media' | 'runtime' | 'promise' | 'react';
type Report = {
    source: ClientErrorSource;
    message: string;
    code?: number;
    http_status?: number;
    resource?: string;
    stack?: string;
};

function safeUrl(value: string): string {
    try {
        const url = new URL(value, window.location.origin);
        return `${url.origin}${url.pathname}`.slice(0, 500);
    } catch { return '[redacted]'; }
}

function redact(value: string): string {
    return value.replace(/https?:\/\/[^\s<>"']+/g, safeUrl)
        .replace(/(bearer\s+)\S+/gi, '$1[redacted]')
        .replace(/((?:token|signature|cookie|authorization|password|secret|key)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]');
}

let windowStart = 0;
let sent = 0;

/** Best effort, no retries or console logging: diagnostics must never break playback. */
export function reportClientError(report: Report): void {
    if (typeof window === 'undefined') return;
    const now = Date.now();
    if (now - windowStart >= 60_000) { windowStart = now; sent = 0; }
    if (sent >= 20) return;
    sent++;
    const room = window.location.pathname.match(/^\/room\/([\w-]+)/)?.[1] ?? '';
    // Development identity is interpreted only when the backend enables development mode.
    const user = new URLSearchParams(window.location.search).get('user');
    const query = user ? `?user=${encodeURIComponent(user)}` : '';
    void fetch(`${BACKEND_ORIGIN}/api/client-errors${query}`, {
        method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            ...report, room,
            message: redact(report.message || 'Unknown client error').slice(0, 2000),
            stack: redact(report.stack ?? '').slice(0, 4000),
            resource: report.resource ? safeUrl(report.resource) : '',
            user_agent: navigator.userAgent.slice(0, 500),
        }),
    }).catch(() => { /* A failed report must not create another error. */ });
}

export function reportPlayerError(source: 'shaka' | 'hls', detail: unknown, message: string): void {
    const data = detail as { code?: unknown; data?: unknown[]; category?: unknown; response?: { code?: unknown }; url?: string } | undefined;
    const code = typeof data?.code === 'number' && Number.isInteger(data.code) ? data.code : undefined;
    const status = source === 'shaka' && code === 1001 ? Number(data?.data?.[1]) : Number(data?.response?.code);
    reportClientError({
        source, code,
        // Shaka data also includes response bodies/headers: never transmit them.
        message: source === 'shaka' ? `Shaka error code=${code ?? 'unknown'} category=${typeof data?.category === 'number' ? data.category : 'unknown'}` : message,
        http_status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined,
        resource: source === 'shaka' && typeof data?.data?.[0] === 'string' ? data.data[0] : data?.url,
    });
}
