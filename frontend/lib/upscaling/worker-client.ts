export interface WorkerResult { ms?: number; changed?: boolean; probability?: number }

/** One request at a time; deadlines prevent a hung GPU/model from hanging UI. */
export class LocalWorker {
  private worker: Worker;
  private nextId = 0;
  private disposed = false;
  private pending?: { id: number; resolve: (value: WorkerResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
  constructor(url: string, onFatal: () => void = () => {}) {
    this.worker = new Worker(url);
    this.worker.onmessage = ({ data }) => {
      if (data.type === 'fatal') { this.fail(); onFatal(); return; }
      if (!this.pending || data.id !== this.pending.id) return;
      const pending = this.pending; this.pending = undefined; clearTimeout(pending.timer);
      if (data.error) pending.reject(new Error(data.error)); else pending.resolve(data);
    };
    this.worker.onerror = (event) => { event.preventDefault(); this.fail(); onFatal(); };
    this.worker.onmessageerror = () => { this.fail(); onFatal(); };
  }
  request(message: object, transfer: Transferable[] = [], timeout = 20_000): Promise<WorkerResult> {
    if (this.disposed || this.pending) return Promise.reject(new Error('Worker unavailable'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.fail(); this.dispose(); }, timeout);
      this.pending = { id, resolve, reject, timer };
      try { this.worker.postMessage({ ...message, id }, transfer); }
      catch { this.fail(); }
    });
  }
  private fail() {
    if (!this.pending) return;
    clearTimeout(this.pending.timer); this.pending.reject(new Error('Local processing unavailable'));
    this.pending = undefined;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.fail();
    this.worker.postMessage({ type: 'dispose' });
    // Give idle workers a chance to release their GPU/model explicitly; still
    // terminate hung workers. This delay never blocks the main thread.
    setTimeout(() => this.worker.terminate(), 100);
  }
}
