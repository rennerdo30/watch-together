'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocalStorageState } from '@/lib/hooks/useLocalStorageState';
import { parseUpscaleMode, type UpscaleMode } from '@/lib/upscaling/policy';
import type { EnhancementController, EnhancementStatus } from '@/lib/upscaling/controller';

const OFF: EnhancementStatus = { state: 'off', message: 'Off' };

export function useVideoEnhancement(video: HTMLVideoElement | null, source: string) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useLocalStorageState<UpscaleMode>('w2g-player-upscaling-beta', 'off', parseUpscaleMode);
  const [status, setStatus] = useState<EnhancementStatus>(OFF);
  useEffect(() => {
    if (!video || !hostRef.current || mode === 'off') return;
    const host = hostRef.current;
    let cancelled = false;
    let controller: EnhancementController | undefined;
    // No enhancement bundle, workers, models or capability probes until opt-in.
    void import('@/lib/upscaling/controller').then(({ EnhancementController }) => {
      if (!cancelled) controller = new EnhancementController(video, host, mode, setStatus);
    }).catch(() => {
      if (!cancelled) setStatus({ state: 'unavailable', message: 'Enhancement could not load; original playback continues' });
    });
    return () => { cancelled = true; controller?.dispose(); };
  }, [video, source, mode]);
  return { hostRef, mode, setMode, status: mode === 'off' ? OFF : status };
}
