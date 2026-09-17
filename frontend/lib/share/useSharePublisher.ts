'use client';

/**
 * Pushing one captured screen up to the server.
 *
 * `MediaRecorder` encodes the capture into container chunks — one every
 * `SHARE_TIMESLICE_MS` — and each chunk is sent, as it is produced, on the
 * share's own WebSocket. Blobs are sent straight to `send()` rather than
 * read into an `ArrayBuffer` first: reading is asynchronous, and two reads
 * in flight could finish in the wrong order, which in a container format
 * means a stream nobody can decode.
 *
 * The sharer encodes once, whatever the room's size. What grows with the
 * room is the server's outbound bandwidth, not this machine's — the
 * opposite of the peer-to-peer arrangement this replaced, where the sharer
 * paid for every viewer and the server paid for none.
 */

import { useEffect, useMemo, useState } from 'react';

import { SHARE_PUBLISHER_BACKLOG_BYTES, SHARE_TIMESLICE_MS } from '../constants';
import { recorderOptions } from './screen-capture';
import {
    SHARE_CONTROL_FORMAT, shareCloseReason, shareSocketUrl,
    type SharePublisherStatus,
} from './relay';
import type { ShareQuality } from '../constants';

interface PublisherOptions {
    origin: string;
    roomId: string;
    /** This browser's room connection, which is what the relay checks. */
    connectionId: string;
    /** The captured screen, or null while not sharing. */
    stream: MediaStream | null;
    quality: ShareQuality;
    /** The development identity, when the page is running with one. */
    user?: string;
}

export interface SharePublisherHandle {
    status: SharePublisherStatus;
    /** Why the share is not going out, phrased for the person sharing. */
    message: string | null;
    /**
     * Whether this uplink is falling behind the encoder. Nothing is done
     * about it automatically: the chunks are one continuous byte stream, so
     * dropping some would leave every viewer with an undecodable hole. The
     * honest remedy is a lower preset, which is the sharer's to choose.
     */
    behind: boolean;
}

const CANNOT_RECORD = 'This browser cannot record a screen in a format the room can play.';

export function useSharePublisher(options: PublisherOptions): SharePublisherHandle {
    const { origin, roomId, connectionId, stream, quality, user } = options;
    // What the socket has reached. 'idle' means "not there yet", which the
    // room is shown as connecting; the sharing/not-sharing distinction is
    // derived from the capture below.
    const [reached, setReached] = useState<SharePublisherStatus>('idle');
    const [message, setMessage] = useState<string | null>(null);
    const [behind, setBehind] = useState(false);

    // Worked out during the render rather than in the effect: a browser
    // that cannot produce a playable format is a fact about this browser,
    // not a state the share passes through.
    //
    // The quality belongs to the capture, which is chosen before sharing
    // starts and cannot be changed while it runs — a different bitrate
    // means a different container header, and the header a room is given
    // is the one its viewers decode against for the whole share.
    const recording = useMemo(
        () => (stream ? recorderOptions(stream, quality) : null),
        [stream, quality],
    );
    const sharing = !!stream && !!connectionId;

    useEffect(() => {
        if (!stream || !connectionId || !recording) return;

        let recorder: MediaRecorder | null = null;
        const socket = new WebSocket(shareSocketUrl(origin, roomId, 'publisher', {
            connectionId, user,
        }));

        socket.onopen = () => {
            // The format first, always: a viewer cannot create a buffer for
            // bytes whose codec it has not been told.
            socket.send(JSON.stringify({ type: SHARE_CONTROL_FORMAT, mime: recording.mimeType }));
            try {
                recorder = new MediaRecorder(stream, recording);
            } catch (error) {
                console.error('[Share] Could not start the recorder:', error);
                setReached('failed');
                setMessage('This browser could not start recording the capture.');
                socket.close();
                return;
            }
            recorder.ondataavailable = (event) => {
                if (!event.data.size || socket.readyState !== WebSocket.OPEN) return;
                setBehind(socket.bufferedAmount > SHARE_PUBLISHER_BACKLOG_BYTES);
                socket.send(event.data);
            };
            recorder.onerror = (event) => {
                console.error('[Share] The recorder stopped:', event);
                setReached('failed');
                setMessage('The screen recording stopped unexpectedly.');
            };
            recorder.start(SHARE_TIMESLICE_MS);
            setReached('live');
        };

        socket.onclose = (event) => {
            setReached('failed');
            setMessage(shareCloseReason(event.code)
                ?? 'The connection carrying your screen closed.');
        };
        socket.onerror = () => socket.close();

        return () => {
            // Stopping the recorder first lets its last chunk out before the
            // socket goes; the room is told separately that it is over.
            try { recorder?.stop(); } catch { /* already stopped with the tracks */ }
            socket.onclose = null;
            socket.close();
            setReached('idle');
            setMessage(null);
            setBehind(false);
        };
    }, [origin, roomId, connectionId, stream, recording, user]);

    return {
        status: !sharing ? 'idle' : !recording ? 'failed' : reached === 'idle' ? 'connecting' : reached,
        message: !sharing ? null : !recording ? CANNOT_RECORD : message,
        behind: sharing && behind,
    };
}
