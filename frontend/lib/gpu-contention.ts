/**
 * Notices when something else is using the GPU heavily, typically a game on
 * another screen.
 *
 * A web page cannot see other programs or the GPU's load, by design. What it
 * can see is its own work: the same model at the same size suddenly taking
 * much longer than it did on an idle GPU means it is sharing the GPU. Local
 * processing (motion smoothing, upscaling) then steps aside instead of
 * slowing the game down, and probes occasionally to come back once the GPU
 * is free.
 */

/** Work this many times slower than idle means the GPU is shared. */
const BUSY_RATIO = 2;
/** Below this many times the idle cost, the GPU is free again. */
const CLEAR_RATIO = 1.4;
/** Small costs are noisy; never call contention below this absolute slowdown. */
const MIN_EXTRA_MS = 4;
/** Consecutive slow measurements before stepping aside. */
const BUSY_SAMPLES = 20;
/** Consecutive normal probes before coming back. */
const CLEAR_PROBES = 2;
/** Samples a learned baseline is taken from. */
const BASELINE_SAMPLES = 30;
const SMOOTHING = 0.2;
/** How often a paused processor measures the GPU again. */
export const CONTENTION_PROBE_MS = 3000;

export const GPU_BUSY_MESSAGE = 'Paused: your GPU is busy with another app, such as a game. It resumes on its own when the GPU is free.';

export class GpuContention {
  private learned: number[] = [];
  private average?: number;
  private slow = 0;
  private normal = 0;
  busy = false;

  /** `baseline`: the work's cost on an idle GPU, if measured; otherwise learned from the first samples. */
  constructor(private baseline?: number) {}

  private get threshold() { return this.baseline === undefined ? Infinity : Math.max(this.baseline * BUSY_RATIO, this.baseline + MIN_EXTRA_MS); }

  /** One measurement of normal work. Returns true when it is time to step aside. */
  observe(ms: number): boolean {
    if (!Number.isFinite(ms) || ms < 0 || this.busy) return false;
    if (this.baseline === undefined) {
      this.learned.push(ms);
      if (this.learned.length >= BASELINE_SAMPLES) {
        const sorted = [...this.learned].sort((a, b) => a - b);
        this.baseline = sorted[Math.floor(sorted.length / 2)];
      }
      return false;
    }
    this.average = this.average === undefined ? ms : this.average * (1 - SMOOTHING) + ms * SMOOTHING;
    this.slow = this.average > this.threshold ? this.slow + 1 : 0;
    if (this.slow < BUSY_SAMPLES) return false;
    this.busy = true; this.slow = 0; this.normal = 0;
    return true;
  }

  /** One probe while stepped aside. Returns true when the GPU is free again. */
  probe(ms: number): boolean {
    if (!this.busy || this.baseline === undefined) return false;
    this.normal = ms < Math.max(this.baseline * CLEAR_RATIO, this.baseline + MIN_EXTRA_MS / 2) ? this.normal + 1 : 0;
    if (this.normal < CLEAR_PROBES) return false;
    this.busy = false; this.average = undefined; this.normal = 0;
    return true;
  }

  /** Whether recent work runs well above its idle cost: shared, not merely slow. */
  get slowerThanIdle() { return this.average !== undefined && this.average > this.threshold; }

  /** A new size or model changes the idle cost. */
  rebase(baseline?: number) { this.baseline = baseline; this.learned = []; this.average = undefined; this.slow = 0; }
}
