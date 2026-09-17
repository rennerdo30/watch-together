'use client';

/**
 * Receiving one member's screen.
 *
 * The viewer's side of the handshake: answer the offer, hand back
 * candidates, and expose whatever arrives as a `MediaStream` for the
 * player's own `<video>` element to render. Nothing is buffered on the way
 * — that is the point of doing this peer to peer, and it is why there is
 * no manifest, no proxy and no engine in this path.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { IncomingSignal, SendSignal } from './signalling';

interface ViewerOptions {
    iceServers: RTCIceServer[];
    sendSignal: SendSignal;
}

export interface ViewerHandle {
    /** The sharer's screen, once it starts arriving. */
    stream: MediaStream | null;
    /** How the connection to the sharer is going, for the UI to explain. */
    status: 'idle' | 'connecting' | 'live' | 'failed';
    /** An offer or a candidate arrived from the sharer. */
    accept: (signal: IncomingSignal) => void;
    /** The share ended, or this browser is the one sharing. */
    reset: () => void;
}

export function usePeerViewer(options: ViewerOptions): ViewerHandle {
    const peerRef = useRef<RTCPeerConnection | null>(null);
    const sharerRef = useRef<string | null>(null);
    const [stream, setStream] = useState<MediaStream | null>(null);
    const [status, setStatus] = useState<ViewerHandle['status']>('idle');
    const optionsRef = useRef(options);
    useEffect(() => { optionsRef.current = options; });

    const reset = useCallback(() => {
        peerRef.current?.close();
        peerRef.current = null;
        sharerRef.current = null;
        setStream(null);
        setStatus('idle');
    }, []);

    const accept = useCallback((signal: IncomingSignal) => {
        const { iceServers, sendSignal } = optionsRef.current;

        if (signal.kind === 'offer') {
            // A fresh offer replaces whatever came before: the sharer has
            // restarted their capture, or this viewer reloaded.
            peerRef.current?.close();
            const peer = new RTCPeerConnection({ iceServers });
            peerRef.current = peer;
            sharerRef.current = signal.from;
            setStatus('connecting');

            peer.ontrack = (event) => {
                setStream(event.streams[0] ?? null);
            };
            peer.onicecandidate = (event) => {
                if (event.candidate) sendSignal(signal.from, 'ice', event.candidate.toJSON());
            };
            peer.onconnectionstatechange = () => {
                if (peer !== peerRef.current) return;
                if (peer.connectionState === 'connected') setStatus('live');
                // No direct path exists between these two networks. Saying
                // so beats a player that stares at nothing.
                if (peer.connectionState === 'failed') setStatus('failed');
            };

            void (async () => {
                try {
                    await peer.setRemoteDescription(signal.data as RTCSessionDescriptionInit);
                    const answer = await peer.createAnswer();
                    await peer.setLocalDescription(answer);
                    sendSignal(signal.from, 'answer', peer.localDescription?.toJSON());
                } catch (error) {
                    console.error('[Share] Could not answer the sharer:', error);
                    setStatus('failed');
                }
            })();
            return;
        }

        if (signal.kind === 'ice' && peerRef.current) {
            void peerRef.current.addIceCandidate(signal.data as RTCIceCandidateInit)
                .catch((error) => console.warn('[Share] Ignored a candidate:', error));
        }
    }, []);

    useEffect(() => () => { peerRef.current?.close(); }, []);

    return { stream, status, accept, reset };
}
