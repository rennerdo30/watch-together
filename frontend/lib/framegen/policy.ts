export type FramegenMode = 'off' | '30' | '60';
export const FRAMEGEN_ROOT = '/framegen/v1';
export const FRAMEGEN_DELAY_MS = 120;
/**
 * GPU time one source frame may take: the model's trunk plus the generated
 * frames between two source frames, measured once per GPU and size. 60% of a
 * 24 fps frame leaves room for decode, presentation and everything else the
 * page draws.
 */
export const FRAMEGEN_BUDGET_MS = 25;
/** Generated frames between two 24 fps source frames, at most, per target. */
export const FRAMEGEN_MIDS: Record<'30' | '60', number> = { '30': 2, '60': 3 };
/** Output textures the worker holds: the 120 ms delay at 60 fps, plus slack. */
export const FRAMEGEN_POOL = 12;
/** localStorage key for per-GPU kernel tunes and measured costs. */
export const FRAMEGEN_TUNE_KEY = 'wt_framegen_tune_v1';

export function parseFramegenMode(value: string | null): FramegenMode {
  return value === '30' || value === '60' ? value : 'off';
}
/** Sampling timestamps, rather than integer multipliers, supports 24 -> 30. */
export function outputTimes(a: number, b: number, fps: number): number[] {
  if (!Number.isFinite(a + b) || b <= a || b - a > 0.12 || ![30, 60].includes(fps)) return [];
  const start = Math.ceil((a - 1e-7) * fps);
  const end = Math.ceil((b - 1e-7) * fps);
  return Array.from({ length: Math.min(8, Math.max(0, end - start)) }, (_, i) => (start + i) / fps);
}

export interface ProcessingSize { width: number; height: number }

const MAX_SOURCE_WIDTH = 3840;
const MAX_SOURCE_HEIGHT = 2160;
/** Steps below the source's own size; the GPU's measured cost picks one. */
const STEP_HEIGHTS = [1440, 1080, 720];
const ALIGN = 16;

function aligned(value: number) { return Math.max(ALIGN, Math.ceil(value / ALIGN) * ALIGN); }

/**
 * The sizes motion smoothing may process a source at, largest first: the
 * source itself (up to 4K), then 1440p, 1080p and 720p below it, aspect kept
 * and padded to multiples of 16. The worker takes the largest one the GPU
 * keeps up with and steps down when it falls behind.
 */
export function processingSizes(width: number, height: number): ProcessingSize[] | null {
  if (!Number.isFinite(width + height) || width <= 0 || height <= 0 || width > MAX_SOURCE_WIDTH || height > MAX_SOURCE_HEIGHT) return null;
  const sizes: ProcessingSize[] = [{ width: aligned(width), height: aligned(height) }];
  for (const step of STEP_HEIGHTS) {
    if (step >= height * 0.95) continue;
    const scale = step / height;
    sizes.push({ width: aligned(width * scale), height: aligned(step) });
  }
  return sizes;
}

export interface GeneratedFrame { time: number; frame: ImageBitmap }

/** What the worker learned about one GPU at one size: its kernel tune and cost. */
export interface TuneEntry { tune: unknown; ms: number }
export type TuneCache = Record<string, TuneEntry>;
