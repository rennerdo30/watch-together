'use client';
import { useEffect, useRef, useState } from 'react';
import { useLocalStorageState } from '@/lib/hooks/useLocalStorageState';
import { parseFramegenMode, type FramegenMode } from '@/lib/framegen/policy';
import type { FramegenController, FramegenStatus } from '@/lib/framegen/controller';
const OFF: FramegenStatus = { state: 'off', message: 'Off' };
export function useFrameGeneration(video: HTMLVideoElement | null, source: string, audioReady: boolean,
  setDelay: (ms: number) => void, mode: FramegenMode, blocked: boolean) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<FramegenStatus>(OFF);
  useEffect(() => {
    if (mode === 'off' || !video || !hostRef.current || !audioReady || blocked) return;
    let cancelled = false;
    let controller: FramegenController | undefined;
    const host = hostRef.current;
    void import('@/lib/framegen/controller').then(({ FramegenController }) => {
      if (!cancelled) controller = new FramegenController(video, host, Number(mode), setStatus, setDelay);
    }).catch(() => { if (!cancelled) setStatus({ state: 'unavailable', message: 'Motion smoothing could not load; original playback continues' }); });
    return () => { cancelled = true; controller?.dispose(); setDelay(0); };
  }, [video, source, mode, audioReady, setDelay, blocked]);
  const effective = mode === 'off' ? OFF : blocked ? { state: 'unavailable' as const, message: 'Not available for live or shared streams' }
    : !audioReady ? { state: 'starting' as const, message: 'Waiting for audio support — click Play to enable local processing' } : status;
  return { hostRef, status: effective };
}
export function useFramegenPreference() {
  return useLocalStorageState<FramegenMode>('w2g-player-framegen-beta', 'off', parseFramegenMode);
}

/** Probe pixel access before routing native audio into Web Audio (tainted sources mute it). */
export function useFramegenCapability(video: HTMLVideoElement | null, source: string, mode: FramegenMode) {
  const [result, setResult] = useState({ ready: false, message: 'Waiting for a decoded frame' });
  useEffect(() => {
    if (!video || mode === 'off') return;
    const probe = () => {
      if (!navigator.gpu || !video.requestVideoFrameCallback) { setResult({ ready: false, message: 'WebGPU frame processing is unavailable on this browser' }); return; }
      if (video.readyState < 2) return;
      try {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d')!; context.drawImage(video, 0, 0, 1, 1); context.getImageData(0, 0, 1, 1);
        setResult({ ready: true, message: '' });
      } catch { setResult({ ready: false, message: 'This source does not allow local frame processing' }); }
    };
    probe(); video.addEventListener('loadeddata', probe);
    return () => video.removeEventListener('loadeddata', probe);
  }, [video, source, mode]);
  return result;
}
