import { FRAMEGEN_DELAY_MS, FRAMEGEN_ROOT, processingSize, type GeneratedFrame } from './policy';
import { reportClientError } from '@/lib/client-errors';
export interface FramegenStatus { state: 'off' | 'starting' | 'idle' | 'active' | 'unavailable'; message: string }
interface Reply { frames?: GeneratedFrame[]; ms?: number; error?: string }

/** Presentation-only: the original element remains the sole media/room clock. */
export class FramegenController {
  private worker?: Worker;
  private canvas: HTMLCanvasElement;
  private context: CanvasRenderingContext2D;
  private pending?: { id: number; resolve: (data: Reply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
  private nextId = 0;
  private epoch = 0;
  private disposed = false;
  private failed = false;
  private busy = false;
  private reset = true;
  private frames: GeneratedFrame[] = [];
  private callback?: number;
  private raf?: number;
  private lastTime?: number;
  private interval = 1 / 24;
  private missed = 0;
  private slow = 0;
  private lastPresentation = 0;
  private statusKey = '';
  private nativeFullscreen = false;
  private cleanups: (() => void)[] = [];
  constructor(private video: HTMLVideoElement, host: HTMLDivElement, private fps: number,
    private notify: (status: FramegenStatus) => void, private delay: (ms: number) => void) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'absolute inset-0 w-full h-full object-contain pointer-events-none';
    this.canvas.setAttribute('aria-hidden', 'true'); this.canvas.style.visibility = 'hidden';
    this.context = this.canvas.getContext('2d', { alpha: false })!;
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
  private status(state: FramegenStatus['state'], message: string) {
    if (this.disposed) return;
    const key = state + message;
    if (key !== this.statusKey) { this.statusKey = key; this.notify({ state, message }); }
  }
  private hide() { this.canvas.style.visibility = 'hidden'; this.delay(0); }
  private clearFrames() { this.frames.forEach(f => f.frame.close()); this.frames = []; }
  private invalidate() { this.epoch++; this.reset = true; this.lastTime = undefined; this.clearFrames(); this.hide(); }
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
  private async start() {
    try {
      const size = processingSize(this.video.videoWidth, this.video.videoHeight);
      if (!navigator.gpu || !size || !this.video.requestVideoFrameCallback || !this.context) throw new Error('This browser or source does not support motion smoothing');
      if (this.video.mediaKeys) throw new Error('Protected video cannot be processed');
      const frame = new VideoFrame(this.video);
      const hdr = ['pq', 'hlg', 'smpte2084', 'arib-std-b67'].includes(String(frame.colorSpace.transfer)); frame.close();
      if (hdr) throw new Error('Original picture retained to preserve HDR');
      this.canvas.width = size.width; this.canvas.height = size.height;
      this.worker = new Worker(`${FRAMEGEN_ROOT}/interpolation.worker.js`);
      this.worker.onmessage = ({ data }) => {
        if (data.type === 'fatal') { this.fail(data.error); return; }
        if (!this.pending || this.pending.id !== data.id) { data.frames?.forEach((f: GeneratedFrame) => f.frame.close()); return; }
        const pending = this.pending; this.pending = undefined; clearTimeout(pending.timer);
        if (data.error) pending.reject(new Error(data.error)); else pending.resolve(data);
      };
      this.worker.onerror = (event) => { event.preventDefault(); this.fail('Frame generation worker failed'); };
      this.worker.onmessageerror = () => this.fail('Frame generation worker failed');
      await this.request({ type: 'init', ...size }, [], 30000);
      if (this.disposed || this.failed) return;
      this.status('idle', 'Ready — play the video to smooth motion');
      this.capture(); this.present();
    } catch (error) {
      if (!this.disposed && !this.failed) this.fail(error instanceof Error ? error.message : 'Frame generation unavailable');
    }
  }
  private capture() {
    if (this.disposed || this.failed) return;
    this.callback = this.video.requestVideoFrameCallback((_now, metadata) => {
      this.callback = undefined; this.capture();
      if (this.blocked()) { this.invalidate(); return; }
      if (this.lastTime !== undefined) {
        const dt = metadata.mediaTime - this.lastTime;
        if (dt > 0 && dt < 0.12) this.interval = this.interval * 0.75 + dt * 0.25;
      }
      this.lastTime = metadata.mediaTime;
      if (1 / this.interval >= this.fps * 0.99) {
        this.invalidate(); this.status('idle', 'Source already meets the selected frame rate'); return;
      }
      if (this.busy) {
        if (++this.missed >= 8) this.fail('GPU cannot keep up; original playback continues');
        return;
      }
      this.missed = 0; this.busy = true;
      const epoch = this.epoch;
      const reset = this.reset; this.reset = false;
      void createImageBitmap(this.video).then(async bitmap => {
        if (this.disposed || this.failed || epoch !== this.epoch) { bitmap.close(); return; }
        const result = await this.request({ type: 'frame', frame: bitmap, time: metadata.mediaTime, fps: this.fps, reset }, [bitmap]);
        if (this.disposed || this.failed || epoch !== this.epoch || this.blocked()) { result.frames?.forEach(f => f.frame.close()); return; }
        this.slow = (result.ms ?? 0) > this.interval * 850 ? this.slow + 1 : Math.max(0, this.slow - 1);
        if (this.slow >= 8) { result.frames?.forEach(f => f.frame.close()); this.fail('GPU cannot keep up; original playback continues'); return; }
        this.frames.push(...result.frames ?? []);
        while (this.frames.length > 20) this.frames.shift()!.frame.close();
      }).catch(error => { if (!this.disposed && !this.failed) this.fail(error instanceof Error ? error.message : 'Frame capture failed'); })
        .finally(() => { this.busy = false; });
    });
  }
  private present() {
    if (this.disposed || this.failed) return;
    this.raf = requestAnimationFrame(() => this.present());
    if (this.blocked()) { this.hide(); return; }
    const time = this.video.currentTime - FRAMEGEN_DELAY_MS / 1000 * this.video.playbackRate;
    let due: GeneratedFrame | undefined;
    while (this.frames.length && this.frames[0].time <= time + 0.001) { due?.frame.close(); due = this.frames.shift(); }
    if (due) {
      this.context.drawImage(due.frame, 0, 0); due.frame.close();
      this.canvas.style.visibility = 'visible'; this.delay(FRAMEGEN_DELAY_MS);
      this.lastPresentation = performance.now();
      this.status('active', `${Math.round(1 / this.interval)} → ${this.fps} fps · local AI · up to 540p processing`);
    } else if (this.lastPresentation && performance.now() - this.lastPresentation > 250) {
      this.hide(); this.reset = true; this.status('idle', 'Waiting for fresh frames');
    }
  }
  private stop() {
    if (this.callback !== undefined) this.video.cancelVideoFrameCallback(this.callback);
    if (this.raf !== undefined) cancelAnimationFrame(this.raf);
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new Error('Frame generator stopped')); this.pending = undefined; }
    this.worker?.terminate(); this.worker = undefined;
    this.clearFrames(); this.hide();
  }
  private fail(message: string) {
    if (this.failed || this.disposed) return;
    this.failed = true; this.stop(); this.status('unavailable', `${message}. Original playback continues.`);
    reportClientError({ source: 'media', message: `Frame generation: ${message}` });
  }
  dispose() { if (this.disposed) return; this.disposed = true; this.stop(); this.cleanups.forEach(fn => fn()); this.canvas.remove(); }
}
