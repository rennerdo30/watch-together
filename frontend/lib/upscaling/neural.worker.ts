/// <reference types="@webgpu/types" />
import WebSR from '@websr/websr';
import { ASSET_ROOT, neuralFits, type ContentMode } from './policy';

// Bundled from WebSR's TypeScript source (not its published eval-based bundle).
// One worker owns one instance: WebSR's global context cannot cross players.
let canvas: OffscreenCanvas;
let device: GPUDevice | undefined;
// Retain the GPU and adapter alongside the device for the worker lifetime.
const gpu = navigator.gpu;
let adapter: GPUAdapter | null = null;
let model: WebSR | undefined;
let key = '';
const weights = new Map<ContentMode, unknown>();
let busy = false;

async function reset() {
  // Keep the device alive across content and resolution changes. Release all
  // owned allocations; upstream context.destroy() also destroys the device.
  if (model?.context) {
    for (const buffer of Object.values(model.context.buffers)) buffer.destroy();
    for (const [name, texture] of Object.entries(model.context.textures)) if (name !== 'output') texture.destroy();
    for (const layer of model.network?.layers ?? []) for (const buffer of Object.values(layer.buffers)) buffer.destroy();
    model.context.context.unconfigure();
  }
  model = undefined;
  key = '';
}

async function initialize(width: number, height: number, mode: ContentMode) {
  if (!neuralFits(width, height)) throw new Error('Source exceeds neural processing budget');
  await reset();
  if (!gpu) throw new Error('WebGPU unavailable');
  adapter ??= await gpu.requestAdapter({ powerPreference: 'low-power' });
  if (!adapter || adapter.limits.maxStorageBufferBindingSize < width * height * 16 ||
      adapter.limits.maxTextureDimension2D < Math.max(width, height) * 2) throw new Error('GPU limits exceeded');
  if (!device) {
    device = await adapter.requestDevice();
    const ownedDevice = device;
    void device.lost.then(info => {
      if (device === ownedDevice && info.reason !== 'destroyed') self.postMessage({ type: 'fatal', error: `GPU connection lost: ${info.message}` });
    });
    device.addEventListener('uncapturederror', () => {
      if (device === ownedDevice) self.postMessage({ type: 'fatal', error: 'GPU rendering failed' });
    });
  }
  if (!weights.has(mode)) {
    const response = await fetch(`${ASSET_ROOT}/cnn-2x-s-${mode === 'animation' ? 'an' : 'rl'}.json`,
      { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('Enhancement model could not be loaded');
    weights.set(mode, await response.json());
  }
  // WebSR accepts OffscreenCanvas at runtime, but its published types only
  // describe HTMLCanvasElement. Recreate on model/resolution changes: upstream
  // updateResolution destroys its device and then tries to reuse that device.
  device.pushErrorScope('validation');
  try {
    model = new WebSR({ canvas: canvas as unknown as HTMLCanvasElement, gpu: device,
      weights: weights.get(mode), network_name: 'anime4k/cnn-2x-s', resolution: { width, height } });
    // Upstream recompiles its first/last pipelines every frame. Our input is
    // always the same persistent image texture, so compile those layers once.
    // The renderer still refreshes the swapchain attachment each frame.
    const layers = model.network!.layers;
    for (const layer of [layers[0], layers[layers.length - 1]]) {
      const setup = layer.lazyLoadSetup.bind(layer);
      let initialized = false;
      layer.lazyLoadSetup = () => { if (!initialized) { setup(); initialized = true; } };
    }
  } finally {
    const error = await device.popErrorScope();
    if (error) throw new Error(error.message);
  }
  key = `${width}:${height}:${mode}`;
}

self.onmessage = async (event: MessageEvent) => {
  const { id, type, frame, mode } = event.data as {
    id: number; type: string; frame?: ImageBitmap; mode: ContentMode; canvas?: OffscreenCanvas;
  };
  if (type === 'dispose') { await reset(); device?.destroy(); self.close(); return; }
  if (type === 'init') { canvas = event.data.canvas; self.postMessage({ id }); return; }
  if (!frame) return;
  if (busy) { frame.close(); self.postMessage({ id, error: 'Renderer busy' }); return; }
  busy = true;
  try {
    const nextKey = `${frame.width}:${frame.height}:${mode}`;
    const changed = nextKey !== key;
    if (changed) await initialize(frame.width, frame.height, mode);
    const start = performance.now();
    await model!.render(frame);
    // render() only submits commands. Wait for actual GPU completion, bounding
    // in-flight frames and measuring execution rather than submission time.
    await device!.queue.onSubmittedWorkDone();
    self.postMessage({ id, ms: performance.now() - start, changed });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : 'Neural rendering failed' });
  } finally { frame.close(); busy = false; }
};
