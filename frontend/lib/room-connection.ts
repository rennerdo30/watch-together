/** Recover a room after sleep, browser restore, or an expired Access session. */
const PING_MS = 5_000;
const STALE_MS = 20_000;
const SESSION_MS = 60_000;
const RECONNECT_MS = 3_000;
const RELOAD_KEY = 'wt-session-reload';

export const ROOM_CLOSED_WS_CODE = 4001;

interface Options {
    socketUrl: string;
    sessionUrl: string;
    onMessage: (data: string) => void;
    onConnected: (connected: boolean) => void;
    onSessionExpired: () => void;
}

export class RoomConnection {
    private socket: WebSocket | null = null;
    private stopped = false;
    private timer: ReturnType<typeof setInterval> | undefined;
    private retry: ReturnType<typeof setTimeout> | undefined;
    private probe: Promise<void> | null = null;
    private abort: AbortController | null = null;
    private lastMessage = 0;
    private lastSessionCheck = 0;
    private identity: string | null | undefined;

    constructor(private readonly options: Options) { }

    start() {
        this.open();
        void this.checkSession();
        this.timer = setInterval(() => {
            if (this.stopped) return;
            if (Date.now() - this.lastSessionCheck >= SESSION_MS) void this.checkSession();
            if (Date.now() - this.lastMessage >= STALE_MS) {
                this.open();
                void this.checkSession();
            } else if (this.socket?.readyState === WebSocket.OPEN) {
                this.ping();
            }
        }, PING_MS);
        window.addEventListener('pageshow', this.pageshow);
        window.addEventListener('online', this.resume);
        window.addEventListener('focus', this.resume);
        document.addEventListener('visibilitychange', this.visible);
    }

    stop() {
        this.stopped = true;
        clearInterval(this.timer);
        clearTimeout(this.retry);
        this.abort?.abort();
        this.disconnect();
        window.removeEventListener('pageshow', this.pageshow);
        window.removeEventListener('online', this.resume);
        window.removeEventListener('focus', this.resume);
        document.removeEventListener('visibilitychange', this.visible);
    }

    send(type: string, payload?: unknown): boolean {
        if (this.stopped) return false;
        if (this.socket?.readyState !== WebSocket.OPEN || Date.now() - this.lastMessage >= STALE_MS) {
            this.resume();
            return false; // Never replay votes/queue mutations after reconnecting.
        }
        this.socket.send(JSON.stringify({ type, payload }));
        return true;
    }

    private disconnect() {
        if (this.socket) {
            // Closing an obsolete socket must not disconnect a newer one or
            // schedule another reconnect after the page has unmounted.
            this.socket.onopen = this.socket.onclose = this.socket.onerror = this.socket.onmessage = null;
            this.socket.close();
            this.socket = null;
        }
        this.options.onConnected(false);
    }

    private open() {
        if (this.stopped) return;
        clearTimeout(this.retry);
        this.disconnect();
        this.lastMessage = Date.now();
        const socket = new WebSocket(this.options.socketUrl);
        this.socket = socket;
        socket.onopen = () => {
            this.lastMessage = Date.now();
            this.options.onConnected(true);
            this.ping();
        };
        socket.onmessage = event => {
            this.lastMessage = Date.now();
            this.options.onMessage(event.data);
        };
        socket.onclose = event => {
            this.options.onConnected(false);
            if (event.code === ROOM_CLOSED_WS_CODE) { this.stop(); return; }
            if (this.stopped) return;
            // A failed WS handshake cannot expose Access's HTTP response to
            // JavaScript. Probe over HTTP to distinguish expiry from an outage.
            void this.checkSession();
            this.retry = setTimeout(() => this.open(), RECONNECT_MS);
        };
        socket.onerror = () => socket.close();
    }

    private ping() {
        this.socket?.send(JSON.stringify({ type: 'ping', payload: { client_time: performance.now() } }));
    }

    private pageshow = (event: PageTransitionEvent) => {
        if (!event.persisted) return; // start() already checks a new/restored document.
        void this.checkSession().then(() => this.open());
    };

    private resume = () => {
        if (this.stopped) return;
        void this.checkSession();
        if (!this.socket || this.socket.readyState === WebSocket.CLOSED ||
            this.socket.readyState === WebSocket.CLOSING || Date.now() - this.lastMessage >= STALE_MS) this.open();
    };

    private visible = () => { if (!document.hidden) this.resume(); };

    private checkSession(): Promise<void> {
        if (this.stopped) return Promise.resolve();
        if (this.probe) return this.probe;
        this.lastSessionCheck = Date.now();
        const controller = new AbortController();
        this.abort = controller;
        const timeout = setTimeout(() => controller.abort(), 10_000);
        this.probe = (async () => {
            try {
                const response = await fetch(this.options.sessionUrl, {
                    cache: 'no-store', credentials: 'same-origin', redirect: 'manual',
                    headers: { 'X-Requested-With': 'XMLHttpRequest' }, signal: controller.signal,
                });
                if (this.stopped) return;
                // Access returns 401 for XMLHttpRequest, or an opaque redirect
                // if an upstream login redirect still occurs. A full navigation
                // lets Access renew SSO or display the sign-in page.
                if (response.status === 401 || response.status === 403 || response.type === 'opaqueredirect') {
                    this.expired(); return;
                }
                if (!response.ok) return;
                if (response.headers.get('content-type')?.includes('text/html')) {
                    this.expired(); return;
                }
                const user = await response.json();
                if (this.stopped || typeof user.authenticated !== 'boolean') return;
                const identity = user.authenticated && typeof user.email === 'string' ? user.email : null;
                // Guest deployments are allowed, but losing/changing a known
                // session must not leave stale identity/roles on the screen.
                if (this.identity !== undefined && identity !== this.identity) { this.expired(); return; }
                this.identity = identity;
            } catch {
                // Offline, timeouts, malformed responses and 5xx are not proof
                // of expired credentials. The next resume/periodic probe retries.
            } finally {
                clearTimeout(timeout);
                this.probe = null;
                if (this.abort === controller) this.abort = null;
            }
        })();
        return this.probe;
    }

    private expired() {
        this.stop();
        this.options.onSessionExpired();
        const key = `${RELOAD_KEY}:${window.location.pathname}`;
        try {
            const last = Number(sessionStorage.getItem(key));
            if (last && Date.now() - last < 30_000) return;
            sessionStorage.setItem(key, String(Date.now()));
        } catch {
            // Without a persistent guard, an unavailable Access service could
            // cause a reload loop. Leave the visible sign-in button instead.
            return;
        }
        window.location.reload();
    }
}
