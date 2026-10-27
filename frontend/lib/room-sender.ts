/** Background reports are best-effort; only user actions need failure feedback. */
const BACKGROUND_REPORTS = new Set(['playback_quality', 'playback_ready', 'playback_timing']);

export function createRoomSender(
    send: (type: string, payload?: unknown) => boolean,
    notify: () => void,
) {
    let warned = false;
    return {
        connected() { warned = false; },
        send(type: string, payload?: unknown) {
            const sent = send(type, payload);
            if (!sent && !BACKGROUND_REPORTS.has(type) && !warned) {
                warned = true;
                notify();
            }
            return sent;
        },
    };
}
