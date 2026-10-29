import {
  FRAMEGEN_BUDGET_MS, FRAMEGEN_DELAY_MS, FRAMEGEN_MIDS, FRAMEGEN_ROOT, FRAMEGEN_TUNE_KEY,
  FrameRateEstimate, needsGeneration, processingSizes, type ProcessingSize, type TuneCache,
} from './policy';
import { reportClientError } from '@/lib/client-errors';
import { CONTENTION_PROBE_MS, GPU_BUSY_MESSAGE, GpuContention } from '@/lib/gpu-contention';
export interface FramegenStatus {
  state: 'off' | 'starting' | 'idle' | 'active' | 'unavailable';
  message: string;
  /** Stepped aside because another app is using the GPU heavily. */
  busyGpu?: boolean;
  /** The source already plays at the target rate: nothing is drawn, the picture is free for others. */
  passthrough?: boolean;
}
interface Reply { count?: number; ms?: number; error?: string; size?: ProcessingSize; tunes?: TuneCache; baselineMs?: number }

/** Consecutive slow or skipped source frames before the worker steps down a size. */
const SLOW_LIMIT = 8;
/** A frame is slow when generation took more than this share of its interval. */
const SLOW_SHARE = 0.85;

function readTunes(): TuneCache {
  try { return JSON.parse(localStorage.getItem(FRAMEGEN_TUNE_KEY) ?? '{}') as TuneCache; }
  catch { return {}; }
}
function storeTunes(tunes: TuneCache | undefined) {
  if (!tunes) return;
  try { localStorage.setItem(FRAMEGEN_TUNE_KEY, JSON.stringify(tunes)); }
  catch (error) { console.warn('[framegen] Could not keep the GPU tune:', error); }
}

/**
 * Presentation-only: the original element remains the sole media/room clock.
 * The worker owns the canvas; this side captures frames, asks for the frame
 * due each animation frame, and decides when the overlay is shown.
 */
export class FramegenController {
  private worker?: Worker;
  private canvas: HTMLCanvasElement;
  private pending?: { id: number; resolve: (data: Reply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
  private nextId = 0;
  private epoch = 0;
  private disposed = false;
  private failed = false;
  private ready = false;
  private busy = false;
  private reset = true;
  private callback?: number;
  private raf?: number;
  private rate = new FrameRateEstimate();
  private interval = 1 / 24;
  private missed = 0;
  private slow = 0;
  private lastPresentation = 0;
  private presentPending = false;
  /** Set while a frame is in flight; the step-down runs once it returns. */
  private stepDownWanted = false;
  private contention = new GpuContention();
  private probeTimer?: ReturnType<typeof setTimeout>;
  /** Upload and read-back on top of the measured model cost of one source frame. */
  private static readonly FRAME_OVERHEAD_MS = 2;
  private size?: ProcessingSize;
  private statusKey = '';
  private nativeFullscreen = false;
  private cleanups: (() => void)[] = [];
  constructor(private video: HTMLVideoElement, host: HTMLDivElement, private fps: number,
    private notify: (status: FramegenStatus) => void, private delay: (ms: number) => void) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'absolute inset-0 w-full h-full object-contain pointer-events-none';
    this.canvas.setAttribute('aria-hidden', 'true'); this.canvas.style.visibility = 'hidden';
    host.replaceChildren(this.canvas);
    const on = (target: EventTarget, event: string, action: () => void) => {
      target.addEventListener(event, action); this.cleanups.push(() => target.removeEventListener(event, action));
    };
    for (const event of ['seeking', 'seeked', 'pause', 'waiting', 'emptied', 'ratechange', 'enterpictureinpicture', 'leavepictureinpicture']) on(video, event, () => this.invalidate());
    on(video, 'webkitbeginfullscreen', () => { this.nativeFullscreen = true; this.invalidate(); });
    on(video, 'webkitendfullscreen', () => { this.nativeFullscreen = false; this.invalidate(); });
    on(video, 'resize', () => this.fail('Video dimensions changed. Turn Off and on to retry.'));
    on(video, 'encrypted', () => this.fail('Protected video cannot be processed'));
    on(video.textTracks, 'change', () => this.invalidate());
    on(document, 'visibilitychange', () => {
      if (document.hidden) this.fail('Frame generation paused for the hidden tab. Turn Off and on to retry.');
    });
    this.status('starting', 'Loading local motion smoothing…');
    if (video.readyState >= 2) void this.start();
    else {
      const ready = () => { video.removeEventListener('loadeddata', ready); void this.start(); };
      on(video, 'loadeddata', ready);
    }
  }
  private status(state: FramegenStatus['state'], message: string, busyGpu = false, passthrough = false) {
    if (this.disposed) return;
    const key = state + message;
    if (key !== this.statusKey) { this.statusKey = key; this.notify({ state, message, busyGpu, passthrough }); }
  }
  private rebase(baselineMs: number | undefined) {
    this.contention.rebase(baselineMs === undefined ? undefined : baselineMs + FramegenController.FRAME_OVERHEAD_MS);
  }
  /** Another app took the GPU: show the original picture and check back now and then. */
  private stepAside() {
    this.ready = false; this.invalidate();
    this.status('idle', GPU_BUSY_MESSAGE, true);
    const probe = () => {
      this.probeTimer = undefined;
      if (this.disposed || this.failed) return;
      if (this.busy || this.blocked()) { this.probeTimer = setTimeout(probe, CONTENTION_PROBE_MS); return; }
      this.busy = true;
      void this.request({ type: 'probe', mids: this.mids }, [], 5000)
        .then(result => {
          if (this.contention.probe(result.ms ?? Infinity)) {
            this.slow = 0; this.missed = 0; this.ready = true;
            this.status('idle', 'GPU is free again — smoothing resumes');
          } else this.probeTimer = setTimeout(probe, CONTENTION_PROBE_MS);
        })
        .catch(error => { if (!this.disposed && !this.failed) this.fail(error instanceof Error ? error.message : 'Frame generation failed'); })
        .finally(() => { this.busy = false; });
    };
    this.probeTimer = setTimeout(probe, CONTENTION_PROBE_MS);
  }
  private hide() { this.canvas.style.visibility = 'hidden'; this.delay(0); }
  private invalidate() {
    this.epoch++; this.reset = true; this.rate.break(); this.lastPresentation = 0;
    this.worker?.postMessage({ type: 'clear' });
    this.hide();
  }
  private blocked() {
    return this.video.paused || this.video.ended || this.video.seeking || this.video.readyState < 2 ||
      document.hidden || this.nativeFullscreen || document.pictureInPictureElement === this.video ||
      !!this.video.mediaKeys || Array.from(this.video.textTracks).some(t => t.mode === 'showing');
  }
  private request(message: object, transfer: Transferable[] = [], timeout = 1500): Promise<Reply> {
    return new Promise((resolve, reject) => {
      if (!this.worker || this.pending) { reject(new Error('Frame generator unavailable')); return; }
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending = undefined; reject(new Error('Frame generation timed out')); }, timeout);
      this.pending = { id, resolve, reject, timer };
      try { this.worker.postMessage({ ...message, id }, transfer); }
      catch (error) { clearTimeout(timer); this.pending = undefined; reject(error); }
    });
  }
  private get mids() { return FRAMEGEN_MIDS[this.fps === 60 ? '60' : '30']; }
  private async start() {
    try {
      const sizes = processingSizes(this.video.videoWidth, this.video.videoHeight);
      if (!navigator.gpu || !sizes || !this.video.requestVideoFrameCallback || !this.canvas.transferControlToOffscreen) throw new Error('This browser or source does not support motion smoothing');
      if (this.video.mediaKeys) throw new Error('Protected video cannot be processed');
      const frame = new VideoFrame(this.video);
      const hdr = ['pq', 'hlg', 'smpte2084', 'arib-std-b67'].includes(String(frame.colorSpace.transfer)); frame.close();
      if (hdr) throw new Error('Original picture retained to preserve HDR');
      this.worker = new Worker(`${FRAMEGEN_ROOT}/interpolation.worker.js`);
      this.worker.onmessage = ({ data }) => {
        if (data.type === 'fatal') { this.fail(data.error); return; }
        if (data.type === 'progress') { this.status('starting', data.message); return; }
        if (data.type === 'presented') { this.presented(Boolean(data.shown)); return; }
        if (!this.pending || this.pending.id !== data.id) return;
        const pending = this.pending; this.pending = undefined; clearTimeout(pending.timer);
        if (data.error) pending.reject(new Error(data.error)); else pending.resolve(data);
      };
      this.worker.onerror = (event) => { event.preventDefault(); this.fail('Frame generation worker failed'); };
      this.worker.onmessageerror = () => this.fail('Frame generation worker failed');
      const offscreen = this.canvas.transferControlToOffscreen();
      // Tuning a size the first time takes a few seconds per size.
      const reply = await this.request({ type: 'init', sizes, mids: this.mids, budgetMs: FRAMEGEN_BUDGET_MS, tunes: readTunes(), canvas: offscreen }, [offscreen], 120000);
      if (this.disposed || this.failed) return;
      storeTunes(reply.tunes); this.size = reply.size; this.rebase(reply.baselineMs); this.ready = true;
      this.status('idle', 'Ready — play the video to smooth motion');
      this.capture(); this.present();
    } catch (error) {
      if (!this.disposed && !this.failed) this.fail(error instanceof Error ? error.message : 'Frame generation unavailable');
    }
  }
  /** The GPU fell behind: process at the next smaller size, or give up below 720p. */
  private async stepDown() {
    this.ready = false; this.busy = true; this.invalidate();
    try {
      const reply = await this.request({ type: 'step-down', mids: this.mids }, [], 120000);
      if (this.disposed || this.failed) return;
      storeTunes(reply.tunes); this.size = reply.size; this.rebase(reply.baselineMs); this.slow = 0; this.missed = 0; this.ready = true;
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'GPU cannot keep up');
    } finally { this.busy = false; }
  }
  private capture() {
    if (this.disposed || this.failed) return;
    this.callback = this.video.requestVideoFrameCallback((_now, metadata) => {
      this.callback = undefined; this.capture();
      if (!this.ready) return;
      if (this.blocked()) { this.invalidate(); return; }
      // Nothing is generated (and audio is not delayed) until the rate is known.
      const interval = this.rate.observe(metadata.mediaTime);
      if (interval === undefined) { this.status('idle', 'Measuring the video\'s frame rate…'); return; }
      this.interval = interval;
      if (!needsGeneration(interval, this.fps)) {
        this.hide(); this.status('idle', `Already ${Math.round(1 / interval)} fps — nothing to add at this setting`, false, true); return;
      }
      if (this.busy) {
        if (++this.missed >= SLOW_LIMIT) this.stepDownWanted = true;
        return;
      }
      this.missed = 0; this.busy = true;
      const epoch = this.epoch;
      const reset = this.reset; this.reset = false;
      const frame = new VideoFrame(this.video);
      void this.request({ type: 'frame', frame, time: metadata.mediaTime, fps: this.fps, reset }, [frame])
        .then(result => {
          if (this.disposed || this.failed || epoch !== this.epoch) return;
          if (this.contention.observe(result.ms ?? 0)) { this.stepAside(); return; }
          this.slow = (result.ms ?? 0) > this.interval * 1000 * SLOW_SHARE ? this.slow + 1 : Math.max(0, this.slow - 1);
          // Slow because the GPU is shared is not a reason to lower the size for good.
          if (this.slow >= SLOW_LIMIT) {
            if (this.contention.slowerThanIdle) { this.slow = 0; this.contention.busy = true; this.stepAside(); }
            else this.stepDownWanted = true;
          }
        })
        .catch(error => {
          frame.close();
          if (!this.disposed && !this.failed && epoch === this.epoch) this.fail(error instanceof Error ? error.message : 'Frame capture failed');
        })
        .finally(() => {
          this.busy = false;
          if (this.stepDownWanted && !this.disposed && !this.failed) { this.stepDownWanted = false; void this.stepDown(); }
        });
    });
  }
  private present() {
    if (this.disposed || this.failed) return;
    this.raf = requestAnimationFrame(() => this.present());
    if (this.blocked()) { this.hide(); return; }
    if (!this.ready || this.presentPending || !this.worker) return;
    this.presentPending = true;
    this.worker.postMessage({ type: 'present', time: this.video.currentTime - FRAMEGEN_DELAY_MS / 1000 * this.video.playbackRate });
  }
  private presented(shown: boolean) {
    this.presentPending = false;
    if (this.disposed || this.failed || this.blocked()) return;
    if (shown) {
      this.canvas.style.visibility = 'visible'; this.delay(FRAMEGEN_DELAY_MS);
      this.lastPresentation = performance.now();
      const size = this.size ? ` · ${this.size.width}×${this.size.height} processing` : '';
      this.status('active', `${Math.round(1 / this.interval)} → ${this.fps} fps · local AI${size}`);
    } else if (this.lastPresentation && performance.now() - this.lastPresentation > 250) {
      this.hide(); this.reset = true; this.lastPresentation = 0; this.status('idle', 'Waiting for fresh frames');
    }
  }
  private stop() {
    if (this.probeTimer !== undefined) clearTimeout(this.probeTimer);
    if (this.callback !== undefined) this.video.cancelVideoFrameCallback(this.callback);
    if (this.raf !== undefined) cancelAnimationFrame(this.raf);
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new Error('Frame generator stopped')); this.pending = undefined; }
    this.worker?.terminate(); this.worker = undefined; this.ready = false;
    this.hide();
  }
  private fail(message: string) {
    if (this.failed || this.disposed) return;
    this.failed = true; this.stop(); this.status('unavailable', `${message}. Original playback continues.`);
    reportClientError({ source: 'media', message: `Frame generation: ${message}` });
  }
  dispose() { if (this.disposed) return; this.disposed = true; this.stop(); this.cleanups.forEach(fn => fn()); this.canvas.remove(); }
}
