/**
 * The handshake two browsers exchange to find each other.
 *
 * It rides the room's existing WebSocket: the server relays these between
 * two members and carries none of the media itself. Offers and answers are
 * session descriptions; candidates are the addresses each browser thinks it
 * can be reached on.
 */

export type SignalKind = 'offer' | 'answer' | 'ice';

/** What arrives from another browser, stamped by the server with its sender. */
export interface IncomingSignal {
    kind: SignalKind;
    from: string;
    data: unknown;
}

/** A viewer saying it is loaded and wants the stream. */
export interface ReadyNotice {
    from: string;
    email: string;
}

/** Who is sharing, as the room describes it. */
export interface LiveShare {
    connection_id: string;
    email: string;
    title: string;
    quality: string;
    started_at: number;
}

export type SendSignal = (to: string, kind: SignalKind, data: unknown) => void;

/** The relay servers this deployment offers, asked for once per page. */
export async function fetchIceServers(origin: string): Promise<RTCIceServer[]> {
    try {
        const response = await fetch(`${origin}/api/webrtc/ice`);
        if (!response.ok) return [];
        const body = await response.json() as { iceServers?: RTCIceServer[] };
        return body.iceServers ?? [];
    } catch {
        // Without them a share still connects on a local network, where
        // both browsers can see each other's addresses directly.
        return [];
    }
}
