'use client';

/**
 * Watching a member's screen, as it is relayed by the server.
 *
 * The socket is opened when the room says someone has started sharing, and
 * everything that arrives on it is either a control line (text) or a piece
 * of the stream (binary). The server always begins a viewer the same way,
 * whether it joined at the first second or the tenth minute: the format,
 * the initialisation segment it retained for exactly this, and then the
 * stream from the next cluster — the first point a decoder could start.
 *
 * `resync` is the interesting case. It means this viewer fell behind, the
 * server dropped what it had not managed to receive, and everything after
 * the notice is a fresh start. A `SourceBuffer` fed a stream with a hole in
 * it never recovers, so the decode session is thrown away and rebuilt.
 * Losing a second of picture is the point: the alternative is watching
 * further and further into the past.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { SHARE_DECODE_RETRY_LIMIT, SHARE_RECONNECT_DELAY_MS } from '../constants';
import { ShareSink } from './media-sink';
import {
    SHARE_CLOSE_BUSY, SHARE_CLOSE_NOT_AUTHORIZED, SHARE_CLOSE_TOO_MANY_VIEWERS,
    SHARE_CLOSE_TOO_SLOW, SHARE_CONTROL_ENDED, SHARE_CONTROL_FORMAT,
    SHARE_CONTROL_RESYNC, SHARE_CONTROL_TOO_SLOW,
    shareCloseReason, shareSocketUrl, type ShareViewerStatus,
} from './relay';

interface ViewerOptions {
    origin: string;
    roomId: string;
    /** Whether someone else's share is running right now. */
    active: boolean;
    /**
     * This browser's room connection. Not sent anywhere — it is here so
     * that a room socket which dropped and came back reopens the media
     * socket with it. The server closes a viewer that has left the room,
     * and a reconnect is exactly the case where it did, briefly.
     */
    connectionId: string;
    /** The development identity, when the page is running with one. */
    user?: string;
}

export interface ShareViewerHandle {
    /** What to give the player as its source, once there is one. */
    src: string | null;
    status: ShareViewerStatus;
    /** Why it is not playing, phrased for the person watching. */
    message: string | null;
}

/** Close codes there is no point reconnecting after. */
const TERMINAL_CLOSE_CODES = new Set([
    SHARE_CLOSE_TOO_SLOW, SHARE_CLOSE_NOT_AUTHORIZED,
    SHARE_CLOSE_BUSY, SHARE_CLOSE_TOO_MANY_VIEWERS,
]);

export function useShareViewer(options: ViewerOptions): ShareViewerHandle {
    const { origin, roomId, active, connectionId, user } = options;
    const [src, setSrc] = useState<string | null>(null);
    // 'idle' while this socket has not reached the point of playing
    // anything; the value the room sees is derived below, so a share that
    // ends and one that has not started cannot be confused.
    const [reached, setReached] = useState<ShareViewerStatus>('idle');
    const [message, setMessage] = useState<string | null>(null);
    const sinkRef = useRef<ShareSink | null>(null);
    const socketRef = useRef<WebSocket | null>(null);
    // How many times this share's decoder has failed on these bytes. A
    // decode that dies takes the picture with it and nothing revives it in
    // place, so the socket is dropped and the server starts this viewer
    // again from a cluster — but only so many times, because a stream this
    // browser genuinely cannot play would otherwise reconnect for ever.
    const decodeFailuresRef = useRef(0);

    const dropSink = useCallback(() => {
        sinkRef.current?.dispose();
        sinkRef.current = null;
        setSrc(null);
    }, []);

    const startSink = useCallback((mime: string) => {
        dropSink();
        const sink = new ShareSink(mime, (reason) => {
            if (decodeFailuresRef.current < SHARE_DECODE_RETRY_LIMIT) {
                decodeFailuresRef.current += 1;
                console.warn('[Share] Rebuilding the decoder after:', reason);
                // Closing is what stops the server sending to a sink that no
                // longer exists; the reconnect below brings back a fresh
                // initialisation segment and a cluster to start at.
                socketRef.current?.close();
                return;
            }
            setReached('failed');
            setMessage(reason);
        });
        sinkRef.current = sink;
        setSrc(sink.url);
        setReached('live');
        setMessage(null);
    }, [dropSink]);

    useEffect(() => {
        if (!active || !connectionId) return;
        decodeFailuresRef.current = 0;

        let socket: WebSocket | null = null;
        let retry: ReturnType<typeof setTimeout> | null = null;
        let cancelled = false;

        const open = () => {
            if (cancelled) return;
            socket = new WebSocket(shareSocketUrl(origin, roomId, 'viewer', { user }));
            socket.binaryType = 'arraybuffer';
            socketRef.current = socket;

            socket.onmessage = (event) => {
                if (typeof event.data !== 'string') {
                    sinkRef.current?.append(event.data as ArrayBuffer);
                    return;
                }
                let control: { type?: string; mime?: string };
                try {
                    control = JSON.parse(event.data);
                } catch {
                    return;
                }
                if (control.type === SHARE_CONTROL_FORMAT && control.mime) {
                    if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported(control.mime)) {
                        setReached('failed');
                        setMessage('This browser cannot play the shared screen.');
                        // Nothing will change by trying again, and leaving
                        // the socket open would have the server sending a
                        // stream at a browser that cannot decode a byte.
                        cancelled = true;
                        socket?.close();
                        return;
                    }
                    // Sent before the initialisation segment, both at the
                    // start and after a resync, so this is always where a
                    // decode session begins.
                    startSink(control.mime);
                } else if (control.type === SHARE_CONTROL_RESYNC) {
                    // This viewer fell behind and the server dropped its
                    // backlog. A buffer that has been fed a stream with a
                    // hole in it never recovers, so the decode session goes
                    // now and the announcement behind this rebuilds it.
                    dropSink();
                } else if (control.type === SHARE_CONTROL_TOO_SLOW) {
                    setReached('too-slow');
                    setMessage(shareCloseReason(SHARE_CLOSE_TOO_SLOW));
                } else if (control.type === SHARE_CONTROL_ENDED) {
                    dropSink();
                    setReached('idle');
                }
            };

            socket.onclose = (event) => {
                if (cancelled) return;
                const reason = shareCloseReason(event.code);
                if (reason) setMessage(reason);
                dropSink();
                if (TERMINAL_CLOSE_CODES.has(event.code)) {
                    setReached(event.code === SHARE_CLOSE_TOO_SLOW ? 'too-slow' : 'failed');
                    return;
                }
                // Anything else is worth another try: the share may simply
                // have started a moment before this socket was opened.
                setReached('idle');
                retry = setTimeout(open, SHARE_RECONNECT_DELAY_MS);
            };

            socket.onerror = () => socket?.close();
        };

        open();

        return () => {
            cancelled = true;
            if (retry) clearTimeout(retry);
            socket?.close();
            dropSink();
            setReached('idle');
            setMessage(null);
        };
    }, [active, connectionId, origin, roomId, user, dropSink, startSink]);

    return {
        src: active ? src : null,
        // Between opening the socket and the first chunk there is nothing to
        // show but a reason to wait.
        status: !active ? 'idle' : reached === 'idle' ? 'connecting' : reached,
        message: active ? message : null,
    };
}
