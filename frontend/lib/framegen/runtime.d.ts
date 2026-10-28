/** framegen 1.4.0 ships declarations but omits their export-map entry.
 * The texture API and autotuner from its published index.d.ts, MIT Monzik Allen. */
declare module 'framegen' {
  /** Kernel shapes measured on one GPU for one size; opaque to callers. */
  export type ConvTune = Record<string, unknown>;
  export interface RT {
    prepPair(a: GPUTexture, b: GPUTexture): void;
    runT(t: number, output: GPUTexture): void;
    destroy(): void;
  }
  export function createRT(device: GPUDevice, options: {
    w: number; h: number; weightsBin: ArrayBuffer;
    weightsManifest: Record<string, { offset: number; shape: number[] }>;
    convTune?: ConvTune | null;
    textureInput: boolean; textureOutput: boolean;
  }): Promise<RT>;
  /** Benchmarks the conv kernel variants on the real shape; the result is per GPU. */
  export function tuneConvRB(device: GPUDevice, shape: { ci: number; co: number; w16: number; h16: number; s2ci?: number }): Promise<ConvTune>;
}
