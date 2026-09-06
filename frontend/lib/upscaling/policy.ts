export type UpscaleMode = 'off' | 'auto' | 'animation' | 'general';
export type ContentMode = 'animation' | 'general';
export const ASSET_ROOT = '/upscaling/v1';

export function parseUpscaleMode(value: string | null): UpscaleMode {
  return value === 'auto' || value === 'animation' || value === 'general' ? value : 'off';
}

/** Keep allocations bounded even on large, high-DPI displays. */
export function outputSize(width: number, height: number, displayWidth: number, displayHeight: number, dpr: number) {
  if (![width, height, displayWidth, displayHeight, dpr].every(n => Number.isFinite(n) && n > 0)) return null;
  const scale = Math.min(2, Math.min(displayWidth / width, displayHeight / height) * Math.min(dpr, 2),
    4096 / Math.max(width, height), Math.sqrt(3840 * 2160 / (width * height)));
  if (scale <= 1.05) return null;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export function neuralFits(width: number, height: number) {
  return width > 0 && height > 0 && width * height <= 1920 * 1080 && Math.max(width, height) <= 2048;
}

/** The bundled MobileNet emits logits, not normalized probabilities. */
export function animationProbability(realLogit: number, animationLogit: number) {
  if (!Number.isFinite(realLogit) || !Number.isFinite(animationLogit)) throw new Error('Invalid classifier logits');
  return 1 / (1 + Math.exp(realLogit - animationLogit));
}

/** Model outputs are [real life, animation]. Uncertainty always favors general. */
export class ContentSelection {
  mode: ContentMode = 'general';
  private candidate: ContentMode = 'general';
  private votes = 0;
  private switchedAt = -Infinity;

  observe(animationProbability: number, now: number): ContentMode {
    const confident = animationProbability >= 0.8 ? 'animation' : animationProbability <= 0.2 ? 'general' : null;
    if (!Number.isFinite(animationProbability) || animationProbability < 0 || animationProbability > 1 || !confident) {
      this.votes = 0;
      return this.mode;
    }
    this.votes = confident === this.candidate ? this.votes + 1 : 1;
    this.candidate = confident;
    if (this.votes >= 3 && confident !== this.mode && now - this.switchedAt >= 20_000) {
      this.mode = confident;
      this.switchedAt = now;
      this.votes = 0;
    }
    return this.mode;
  }
}

/** Sustained slowness, not a single compilation spike, triggers degradation. */
export class RenderBudget {
  private samples = 0;
  private slow = 0;
  observe(renderMs: number, frameIntervalMs: number) {
    this.samples++;
    if (renderMs > Math.min(40, Math.max(8, frameIntervalMs * 0.65))) this.slow++;
    if (this.samples < 45) return false;
    const overloaded = this.slow / this.samples > 0.3;
    this.samples = this.slow = 0;
    return overloaded;
  }
}
