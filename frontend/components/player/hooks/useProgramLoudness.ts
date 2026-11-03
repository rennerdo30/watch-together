'use client';

import { useEffect, useState } from 'react';

import { programLoudnessUrl } from '@/lib/api';

/** Pause before asking again about a measurement the server is still running. */
const PENDING_RETRY_MS = 3000;
/** Questions asked about one video before settling for the running estimate. */
const MAX_ATTEMPTS = 40;

/**
 * The whole video's integrated loudness, as the server measured it.
 *
 * Asked once per video, after its manifest has loaded (the server only
 * measures videos it has resolved). The first request for a video waits
 * while the server reads its audio, a few seconds; the leveller runs on its
 * own estimate meanwhile. Null while unknown, for live streams, and when
 * normalization is off.
 */
export function useProgramLoudness(mediaElement: HTMLMediaElement | null, manifestUrl: string | undefined,
    enabled: boolean): number | null {
    const [measured, setMeasured] = useState<{ manifestUrl: string; lufs: number | null } | null>(null);

    useEffect(() => {
        if (!enabled || !mediaElement || !manifestUrl) return;
        const url = programLoudnessUrl(manifestUrl);
        if (!url) return;
        const controller = new AbortController();
        let attempts = 0;
        let retryTimer: number | undefined;
        const ask = () => {
            mediaElement.removeEventListener('loadedmetadata', ask);
            attempts += 1;
            fetch(url, { signal: controller.signal, cache: 'no-store' })
                .then(response => (response.ok ? response.json() : null))
                .then((body: { integrated_lufs?: unknown; pending?: unknown } | null) => {
                    if (controller.signal.aborted) return;
                    // A long video is still being read: the server answers
                    // before the proxy's timeout and keeps measuring.
                    if (body?.pending === true && attempts < MAX_ATTEMPTS) {
                        retryTimer = window.setTimeout(ask, PENDING_RETRY_MS);
                        return;
                    }
                    const lufs = typeof body?.integrated_lufs === 'number' && Number.isFinite(body.integrated_lufs)
                        ? body.integrated_lufs : null;
                    setMeasured({ manifestUrl, lufs });
                })
                .catch(error => {
                    // Not knowing it is the normal state before the answer; the
                    // running estimate keeps levelling.
                    if (!controller.signal.aborted) console.warn('[ProgramLoudness] Unavailable:', error);
                });
        };
        if (mediaElement.readyState >= HTMLMediaElement.HAVE_METADATA) ask();
        else mediaElement.addEventListener('loadedmetadata', ask);
        return () => {
            controller.abort(); window.clearTimeout(retryTimer);
            mediaElement.removeEventListener('loadedmetadata', ask);
        };
    }, [enabled, mediaElement, manifestUrl]);

    return enabled && measured && measured.manifestUrl === manifestUrl ? measured.lufs : null;
}
