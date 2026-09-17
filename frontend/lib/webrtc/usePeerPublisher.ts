'use client';

/**
 * Sending one screen to several viewers at once.
 *
 * There is no server in the media path: the sharer's browser holds one
 * connection per viewer and encodes for each of them. That is what makes
 * this the lowest-latency arrangement available — nothing between the two
 * machines but the network — and also what bounds it to a handful of
 * viewers, since every one of them costs the sharer another copy of the
 * stream.
 */

import { useCallback, useEffect, useRef } from 'react';

import { applyQuality } from './screen-capture';
import type { IncomingSignal, SendSignal } from './signalling';
import type { ShareQuality } from '../constants';

interface PublisherOptions {
    /** The captured screen, or null while not sharing. */
    stream: MediaStream | null;
    quality: ShareQuality;
    iceServers: RTCIceServer[];
    sendSignal: SendSignal;
}

export interface PublisherHandle {
    /** A viewer says it is ready; offer it the stream. */
    offerTo: (connectionId: string) => void;
    /**
     * An answer or a candidate came back from a viewer. Returns false when
     * the signal is from someone this browser is not sending to, which is
     * how the room tells a sharer's traffic from a viewer's without having
     * to know which role it is playing.
     */
    accept: (signal: IncomingSignal) => boolean;
    /** Forget a viewer that has left the room. */
    drop: (connectionId: string) => void;
    /** How many viewers are connected right now. */
    viewerCount: () => number;
}

export function usePeerPublisher(options: PublisherOptions): PublisherHandle {
    const peers = useRef(new Map<string, RTCPeerConnection>());
    const optionsRef = useRef(options);
    useEffect(() => { optionsRef.current = options; });

    const close = useCallback((connectionId: string) => {
        const peer = peers.current.get(connectionId);
        if (!peer) return;
        peer.onicecandidate = null;
        peer.onconnectionstatechange = null;
        peer.close();
        peers.current.delete(connectionId);
    }, []);

    const offerTo = useCallback((connectionId: string) => {
        const { stream, iceServers, sendSignal, quality } = optionsRef.current;
        if (!stream) return;
        // A viewer that reloads announces itself again; the old connection
        // is finished with, not reused.
        close(connectionId);

        const peer = new RTCPeerConnection({ iceServers });
        peers.current.set(connectionId, peer);

        for (const track of stream.getTracks()) {
            const sender = peer.addTrack(track, stream);
            if (track.kind === 'video') void applyQuality(sender, quality);
        }

        peer.onicecandidate = (event) => {
            if (event.candidate) sendSignal(connectionId, 'ice', event.candidate.toJSON());
        };
        peer.onconnectionstatechange = () => {
            if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
                close(connectionId);
            }
        };

        void (async () => {
            try {
                const offer = await peer.createOffer();
                await peer.setLocalDescription(offer);
                sendSignal(connectionId, 'offer', peer.localDescription?.toJSON());
            } catch (error) {
                console.error('[Share] Could not offer the stream:', error);
                close(connectionId);
            }
        })();
    }, [close]);

    const accept = useCallback((signal: IncomingSignal): boolean => {
        const peer = peers.current.get(signal.from);
        if (!peer) return false;
        void (async () => {
            try {
                if (signal.kind === 'answer') {
                    await peer.setRemoteDescription(signal.data as RTCSessionDescriptionInit);
                } else if (signal.kind === 'ice') {
                    await peer.addIceCandidate(signal.data as RTCIceCandidateInit);
                }
            } catch (error) {
                // A candidate that arrives before the answer is normal and
                // recoverable; the connection carries on with the rest.
                console.warn('[Share] Ignored a signal from a viewer:', error);
            }
        })();
        return true;
    }, []);

    // Changing quality mid-share re-tunes the senders rather than
    // renegotiating: the encoding is a property of the sender, not of the
    // connection.
    useEffect(() => {
        for (const peer of peers.current.values()) {
            for (const sender of peer.getSenders()) {
                if (sender.track?.kind === 'video') void applyQuality(sender, options.quality);
            }
        }
    }, [options.quality]);

    // Stopping the capture closes every connection with it.
    useEffect(() => {
        if (options.stream) return;
        for (const connectionId of Array.from(peers.current.keys())) close(connectionId);
    }, [options.stream, close]);

    const peersRef = peers;
    useEffect(() => () => {
        for (const peer of peersRef.current.values()) peer.close();
        peersRef.current.clear();
    }, [peersRef]);

    return {
        offerTo,
        accept,
        drop: close,
        viewerCount: () => peers.current.size,
    };
}
