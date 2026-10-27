/** Renew Access only after the room socket has actually failed. */
interface Options {
    url: string;
    disconnected: () => boolean;
    onSignInRequired: () => void;
}

export function createRoomAuthRecovery(options: Options) {
    let disposed = false;
    let checking = false;
    let lastAttempt = -Infinity;
    let controller: AbortController | null = null;
    const eligible = () => !disposed && options.disconnected();

    const check = async () => {
        if (!eligible() || checking || Date.now() - lastAttempt < 10_000) return;
        checking = true;
        lastAttempt = Date.now();
        const request = new AbortController();
        controller = request;
        const timeout = setTimeout(() => request.abort(), 8_000);
        try {
            const response = await fetch(options.url, {
                cache: 'no-store', credentials: 'same-origin', redirect: 'manual',
                headers: { 'X-Requested-With': 'XMLHttpRequest' }, signal: request.signal,
            });
            // A slow probe can finish after the socket reconnects. Never let
            // its stale response interrupt a room that is already healthy.
            if (!eligible()) return;
            if (response.status !== 401 && response.type !== 'opaqueredirect') return;

            const key = `wt-room-auth-reload:${window.location.pathname}`;
            try {
                const previous = Number(sessionStorage.getItem(key));
                if (previous && Date.now() - previous < 60_000) {
                    options.onSignInRequired();
                    return;
                }
                sessionStorage.setItem(key, String(Date.now()));
            } catch {
                // Without a guard across navigation, do not risk a reload loop.
                options.onSignInRequired();
                return;
            }
            window.location.reload();
        } catch {
            // Network failures, timeouts and server errors leave the normal
            // socket reconnect path alone. They are not proof of expired login.
        } finally {
            clearTimeout(timeout);
            checking = false;
            if (controller === request) controller = null;
        }
    };

    const resume = () => { void check(); };
    const visible = () => { if (!document.hidden) resume(); };
    const restored = (event: PageTransitionEvent) => { if (event.persisted) resume(); };
    window.addEventListener('focus', resume);
    window.addEventListener('online', resume);
    window.addEventListener('pageshow', restored);
    document.addEventListener('visibilitychange', visible);

    return {
        check,
        dispose() {
            disposed = true;
            controller?.abort();
            window.removeEventListener('focus', resume);
            window.removeEventListener('online', resume);
            window.removeEventListener('pageshow', restored);
            document.removeEventListener('visibilitychange', visible);
        },
    };
}
