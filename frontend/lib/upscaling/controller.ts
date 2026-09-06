import { ASSET_ROOT, ContentSelection, RenderBudget, neuralFits, outputSize, type ContentMode, type UpscaleMode } from './policy';
import { LocalWorker } from './worker-client';
import { SpatialRenderer } from './spatial';

export interface EnhancementStatus {
  state: 'off' | 'starting' | 'active' | 'idle' | 'unavailable';
  message: string;
  backend?: 'neural' | 'spatial';
  content?: ContentMode;
}

/** Presentation only. Never writes src, currentTime, playbackRate, volume or
 * play state and never interacts with the room or a streaming engine. */
export class EnhancementController {
  private disposed = false;
  private busy = false;
  private dirty = false;
  private epoch = 0;
  private callback?: number;
  private usesVideoCallback = false;
  private renderer?: LocalWorker | SpatialRenderer;
  private canvas?: HTMLCanvasElement;
  private classifier?: LocalWorker;
  private classifying = false;
  private classificationFailed = false;
  private lastClassification = -Infinity;
  private selection = new ContentSelection();
  private content: ContentMode;
  private allowNeural = true;
  private stopped = false;
  private budget = new RenderBudget();
  private lastTime = -1;
  private frameInterval = 1000 / 30;
  private lastMetadata?: { mediaTime: number; presentedFrames: number };
  private neuralKey = '';
  private nativeFullscreen = false;
  private hdr = false;
  private protectedContent = false;
  private cleanups: (() => void)[] = [];
  private lastStatus = '';
  private sampleCanvas?: HTMLCanvasElement;

  constructor(private video: HTMLVideoElement, private host: HTMLDivElement,
    private mode: Exclude<UpscaleMode, 'off'>, private notify: (status: EnhancementStatus) => void) {
    this.content = mode === 'animation' ? 'animation' : 'general';
    this.report('starting', 'Preparing enhancement on this device…');
    const on = (target: EventTarget, name: string, listener: () => void) => {
      target.addEventListener(name, listener); this.cleanups.push(() => target.removeEventListener(name, listener));
    };
    const invalidate = () => { this.epoch++; this.hide(); this.lastTime = -1; this.dirty = true; this.cancelFrame(); void this.draw(); };
    on(video, 'seeking', invalidate);
    on(video, 'seeked', invalidate);
    on(video, 'loadeddata', () => { this.inspectColor(); invalidate(); });
    on(video, 'resize', () => { this.inspectColor(); invalidate(); });
    on(video, 'play', invalidate);
    on(video, 'pause', () => { this.cancelFrame(); });
    on(video, 'emptied', invalidate);
    on(video, 'waiting', () => { this.epoch++; this.hide(); });
    on(video, 'playing', invalidate);
    on(video, 'enterpictureinpicture', invalidate);
    on(video, 'leavepictureinpicture', invalidate);
    on(video, 'webkitbeginfullscreen', () => { this.nativeFullscreen = true; invalidate(); });
    on(video, 'webkitendfullscreen', () => { this.nativeFullscreen = false; invalidate(); });
    on(video, 'encrypted', () => { this.protectedContent = true; invalidate(); });
    on(video.textTracks, 'change', invalidate);
    on(document, 'visibilitychange', () => {
      if (document.hidden) {
        this.releaseRenderer(); this.classifier?.dispose(); this.classifier = undefined;
      }
      invalidate();
    });
    const resize = new ResizeObserver(invalidate); resize.observe(host);
    this.cleanups.push(() => resize.disconnect());
    this.inspectColor();
    void this.draw();
  }

  private report(state: EnhancementStatus['state'], message: string) {
    if (this.disposed) return;
    const backend = this.renderer instanceof LocalWorker ? 'neural' : this.renderer ? 'spatial' : undefined;
    const status: EnhancementStatus = { state, message, backend, content: this.content };
    const key = JSON.stringify(status);
    if (key !== this.lastStatus) { this.lastStatus = key; this.notify(status); }
  }

  private inspectColor() {
    // Avoid silently mapping HDR to SDR through an 8-bit enhancement pipeline.
    if (typeof VideoFrame === 'undefined' || this.video.readyState < 2) return;
    try {
      const frame = new VideoFrame(this.video);
      this.hdr = ['pq', 'hlg', 'smpte2084', 'arib-std-b67'].includes(String(frame.colorSpace.transfer));
      frame.close();
    } catch { /* CORS/protected sources are handled by the actual render attempt. */ }
  }

  private suspension() {
    if (document.hidden) return 'Enhancement paused while this tab is hidden';
    if (this.nativeFullscreen || document.pictureInPictureElement === this.video) return 'Original picture in native fullscreen or picture-in-picture';
    if (this.protectedContent || this.video.mediaKeys) return 'Original picture for protected video';
    if (this.hdr) return 'Original picture to preserve HDR';
    if (Array.from(this.video.textTracks).some(track => track.mode === 'showing')) return 'Original picture while native captions are shown';
    if (this.video.seeking || this.video.readyState < 2) return 'Waiting for a video frame';
    return null;
  }

  private hide() { if (this.canvas) this.canvas.style.visibility = 'hidden'; }
  private releaseRenderer() {
    this.hide(); this.renderer?.dispose(); this.renderer = undefined;
    this.canvas?.remove(); this.canvas = undefined;
    this.neuralKey = '';
    this.budget = new RenderBudget();
  }

  private async createRenderer() {
    const canvas = document.createElement('canvas');
    canvas.className = 'absolute inset-0 w-full h-full object-contain pointer-events-none';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.visibility = 'hidden';
    this.host.replaceChildren(canvas); this.canvas = canvas;
    if (this.allowNeural && neuralFits(this.video.videoWidth, this.video.videoHeight) &&
      navigator.gpu && canvas.transferControlToOffscreen && typeof createImageBitmap === 'function') {
      const renderer = new LocalWorker(`${ASSET_ROOT}/neural.worker.js`, () => {
        if (!this.disposed && this.renderer === renderer) this.degrade();
      });
      this.renderer = renderer;
      const offscreen = canvas.transferControlToOffscreen();
      await renderer.request({ type: 'init', canvas: offscreen }, [offscreen]);
    } else {
      const renderer = new SpatialRenderer(canvas);
      this.renderer = renderer;
      canvas.addEventListener('webglcontextlost', () => {
        if (!this.disposed && this.renderer === renderer) this.fail('GPU connection lost; original playback continues');
      }, { once: true });
    }
  }

  private degrade() {
    this.epoch++;
    this.allowNeural = false;
    this.releaseRenderer(); this.lastTime = -1; this.dirty = true;
    this.report('starting', 'Switching to lightweight enhancement…');
    if (!this.busy) void this.draw();
  }

  private fail(message: string) {
    this.stopped = true; this.epoch++; this.cancelFrame(); this.releaseRenderer();
    this.classifier?.dispose(); this.classifier = undefined;
    this.report('unavailable', message);
  }

  private cancelFrame() {
    if (this.callback === undefined) return;
    if (this.usesVideoCallback) this.video.cancelVideoFrameCallback(this.callback);
    else cancelAnimationFrame(this.callback);
    this.callback = undefined;
  }

  private schedule() {
    if (this.disposed || this.stopped || this.callback !== undefined || this.video.paused || this.video.ended || document.hidden) return;
    this.usesVideoCallback = typeof this.video.requestVideoFrameCallback === 'function';
    if (this.usesVideoCallback) {
      this.callback = this.video.requestVideoFrameCallback((_now, metadata) => {
        this.callback = undefined;
        if (this.lastMetadata) {
          const frames = metadata.presentedFrames - this.lastMetadata.presentedFrames;
          const time = metadata.mediaTime - this.lastMetadata.mediaTime;
          if (frames > 0 && time > 0 && time < 1) this.frameInterval = Math.max(8, Math.min(100, time * 1000 / frames / this.video.playbackRate));
        }
        this.lastMetadata = metadata;
        void this.draw();
      });
    } else this.callback = requestAnimationFrame(() => { this.callback = undefined; void this.draw(); });
  }

  private async classify() {
    if (this.mode !== 'auto' || this.classifying || this.classificationFailed || this.video.paused ||
      performance.now() - this.lastClassification < 5000) return;
    this.classifying = true; this.lastClassification = performance.now();
    const epoch = this.epoch;
    try {
      this.sampleCanvas ??= document.createElement('canvas');
      this.sampleCanvas.width = this.sampleCanvas.height = 224;
      const context = this.sampleCanvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Frame sampling unavailable');
      // Match the classifier's documented center-crop preprocessing. Resize
      // only sources smaller than its input, never read back a full video frame.
      const size = Math.min(224, this.video.videoWidth, this.video.videoHeight);
      context.drawImage(this.video, (this.video.videoWidth - size) / 2, (this.video.videoHeight - size) / 2,
        size, size, 0, 0, 224, 224);
      const pixels = context.getImageData(0, 0, 224, 224).data;
      this.classifier ??= new LocalWorker(`${ASSET_ROOT}/classifier.worker.js`);
      const result = await this.classifier.request({ pixels }, [pixels.buffer], 30_000);
      if (!this.disposed && epoch === this.epoch && result.probability !== undefined) {
        this.content = this.selection.observe(result.probability, performance.now());
      }
    } catch {
      if (!this.disposed && epoch === this.epoch) {
        this.classificationFailed = true; this.content = 'general';
        this.classifier?.dispose(); this.classifier = undefined;
      }
    } finally { this.classifying = false; }
  }

  private async draw() {
    if (this.disposed || this.stopped) return;
    if (this.busy) { this.dirty = true; return; }
    const suspended = this.suspension();
    const size = outputSize(this.video.videoWidth, this.video.videoHeight, this.host.clientWidth, this.host.clientHeight, window.devicePixelRatio || 1);
    if (suspended || !size) {
      this.hide(); this.report('idle', suspended ?? 'Original picture — already sharp enough for this display size');
      this.schedule(); return;
    }
    if (!this.dirty && this.lastTime === this.video.currentTime) { this.schedule(); return; }
    this.dirty = false; this.busy = true;
    const epoch = this.epoch;
    const sourceTime = this.video.currentTime;
    let bitmap: ImageBitmap | undefined;
    // Hide stale output even if a driver stalls before its request times out.
    const staleTimer = setTimeout(() => { if (epoch === this.epoch) this.hide(); }, 150);
    try {
      if (!this.renderer) await this.createRenderer();
      if (this.disposed || epoch !== this.epoch) return;
      const renderer = this.renderer!;
      const start = performance.now();
      let changed = false;
      if (renderer instanceof LocalWorker) {
        if (!neuralFits(this.video.videoWidth, this.video.videoHeight)) { this.degrade(); return; }
        bitmap = await createImageBitmap(this.video);
        if (this.disposed || epoch !== this.epoch) return;
        // Ownership is transferred. The worker closes every submitted bitmap.
        const key = `${bitmap.width}:${bitmap.height}:${this.content}`;
        const result = await renderer.request({ type: 'render', frame: bitmap, mode: this.content }, [bitmap], key === this.neuralKey ? 1500 : 20_000);
        this.neuralKey = key;
        changed = result.changed ?? false;
      } else await renderer.render(this.video, size.width, size.height, this.content === 'animation');
      if (this.disposed || epoch !== this.epoch) return;
      const elapsed = performance.now() - start;
      this.lastTime = sourceTime;
      if (!changed && !this.video.paused && this.budget.observe(elapsed, this.frameInterval)) {
        if (renderer instanceof LocalWorker) this.degrade();
        else this.fail('Enhancement paused to keep playback smooth. Turn Off and on to retry.');
        return;
      }
      // Never cover a seek, a native presentation mode, or moving video with
      // an old frame produced by a slow initialization/inference.
      if (this.suspension() || Math.abs(this.video.currentTime - sourceTime) > 0.15) {
        this.hide(); this.report('starting', 'Adjusting enhancement to this device…');
      } else {
        this.canvas!.style.visibility = 'visible';
        const name = this.content === 'animation' ? 'Animation' : 'General';
        const method = renderer instanceof LocalWorker ? 'AI 2×' : 'lightweight';
        const detail = this.mode === 'auto' ? this.classificationFailed ? ' · automatic detection unavailable' : ' · automatic selection' : '';
        this.report('active', `${name} · ${method}${detail}`);
      }
      void this.classify();
    } catch (error) {
      if (this.disposed || epoch !== this.epoch) return;
      if (error instanceof DOMException && error.name === 'SecurityError') this.fail('This source does not allow local frame processing; original playback continues');
      else if (this.renderer instanceof LocalWorker) this.degrade();
      else this.fail('Enhancement unavailable on this browser or source; original playback continues');
    } finally {
      clearTimeout(staleTimer); bitmap?.close(); this.busy = false;
      if (this.dirty && !this.disposed && !this.stopped) { this.dirty = false; this.lastTime = -1; void this.draw(); }
      else this.schedule();
    }
  }

  dispose() {
    this.disposed = true; this.epoch++; this.cancelFrame();
    this.cleanups.forEach(cleanup => cleanup());
    this.releaseRenderer(); this.classifier?.dispose(); this.classifier = undefined;
    this.sampleCanvas = undefined;
  }
}
