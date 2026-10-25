/** framegen 1.4.0 ships declarations but omits their export-map entry.
 * Minimal texture API from its published index.d.ts, MIT Monzik Allen. */
declare module 'framegen' {
  export interface RT {
    prepPair(a: GPUTexture, b: GPUTexture): void;
    runT(t: number, output: GPUTexture): void;
    destroy(): void;
  }
  export function createRT(device: GPUDevice, options: {
    w: number; h: number; weightsBin: ArrayBuffer;
    weightsManifest: Record<string, { offset: number; shape: number[] }>;
    textureInput: boolean; textureOutput: boolean;
  }): Promise<RT>;
}
