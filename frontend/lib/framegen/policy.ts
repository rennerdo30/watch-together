export type FramegenMode = 'off' | '30' | '60';
export const FRAMEGEN_ROOT = '/framegen/v1';
export const FRAMEGEN_DELAY_MS = 120;
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
export function processingSize(width: number, height: number) {
  if (!Number.isFinite(width + height) || width <= 0 || height <= 0 || width > 3840 || height > 2160) return null;
  const scale = Math.min(1, 1920 / width, 1080 / height);
  return { width: Math.max(16, Math.ceil(width * scale / 16) * 16), height: Math.max(16, Math.ceil(height * scale / 16) * 16) };
}
export interface GeneratedFrame { time: number; frame: ImageBitmap }
