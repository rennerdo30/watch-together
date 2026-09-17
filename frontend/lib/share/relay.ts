/**
 * The wire between a shared screen and the people watching it.
 *
 * The media goes through the server. Not because that is the best way to
 * move video — it is not, a direct connection between two browsers is a
 * hop shorter and half a second faster — but because it is the way that
 * works here: this origin publishes no ports, and the tunnel in front of it
 * carries HTTP and WebSocket and nothing else. So the picture is encoded in
 * the browser, pushed up a WebSocket as container chunks, copied by the
 * server to every viewer, and decoded through Media Source Extensions.
 *
 * It travels on its own socket, never the room's. The room socket carries
 * play, pause and seek, and a WebSocket delivers strictly in order: a
 * megabyte of video queued ahead of a pause would hold the pause behind it
 * for as long as the video took to flush, and the room would drift by
 * exactly that much. Two sockets, two queues.
 */

/** Who is sharing, as the room describes it. */
export interface LiveShare {
    connection_id: string;
    email: string;
    title: string;
    quality: string;
    started_at: number;
}

/** What the server says on the media socket. Media itself is binary. */
export const SHARE_CONTROL_FORMAT = 'format';
export const SHARE_CONTROL_RESYNC = 'resync';
export const SHARE_CONTROL_ENDED = 'ended';
export const SHARE_CONTROL_TOO_SLOW = 'too_slow';

/**
 * Close codes the server uses, mirrored from `backend/core/config.py`.
 * Each one means exactly one thing to the room, because each one gets a
 * different sentence.
 */
export const SHARE_CLOSE_PROTOCOL = 4400;
export const SHARE_CLOSE_NOT_AUTHORIZED = 4403;
export const SHARE_CLOSE_NO_SHARE = 4404;
export const SHARE_CLOSE_TOO_SLOW = 4408;
export const SHARE_CLOSE_BUSY = 4409;
export const SHARE_CLOSE_ENDED = 4410;
export const SHARE_CLOSE_TOO_MANY_VIEWERS = 4429;

/** How a viewer's side of the share is going, for the room to explain. */
export type ShareViewerStatus = 'idle' | 'connecting' | 'live' | 'too-slow' | 'failed';

/** How the sharer's own side is going. */
export type SharePublisherStatus = 'idle' | 'connecting' | 'live' | 'failed';

/** The address of the media socket for one room, in one role. */
export function shareSocketUrl(
    origin: string,
    roomId: string,
    role: 'publisher' | 'viewer',
    options: { connectionId?: string; user?: string } = {},
): string {
    // An empty origin means the backend is served from this one, which is
    // how the deployment behind the tunnel is put together.
    const resolved = origin || (typeof window === 'undefined' ? '' : window.location.origin);
    const base = resolved.replace(/^http/, 'ws');
    const params = new URLSearchParams({ role });
    if (options.connectionId) params.set('connection', options.connectionId);
    // Development identities travel the same way they do on the room socket.
    if (options.user) params.set('user', options.user);
    return `${base}/ws/share/${encodeURIComponent(roomId)}?${params.toString()}`;
}

/** What a close code means, in a sentence a viewer can act on. */
export function shareCloseReason(code: number): string | null {
    switch (code) {
        case SHARE_CLOSE_TOO_SLOW:
            return 'Your connection could not keep up with the shared screen.';
        case SHARE_CLOSE_TOO_MANY_VIEWERS:
            return 'This share already has as many viewers as the server will carry.';
        case SHARE_CLOSE_NOT_AUTHORIZED:
            return 'This room did not accept the connection for the shared screen.';
        case SHARE_CLOSE_BUSY:
            return 'The server is already carrying as many screen shares as it can.';
        case SHARE_CLOSE_PROTOCOL:
            return 'The shared screen was sent in a form this room could not carry.';
        default:
            return null;
    }
}
