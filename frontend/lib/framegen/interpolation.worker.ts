/// <reference types="@webgpu/types" />
import { createRT, tuneConvRB, type ConvTune, type RT } from 'framegen';
import { FRAMEGEN_POOL, FRAMEGEN_ROOT, outputTimes, type ProcessingSize, type TuneCache } from './policy';

/**
 * Motion smoothing on the GPU, end to end.
 *
 * A source frame arrives as a VideoFrame (or, from tests, an ImageBitmap) and
 * is scaled straight into an input texture by a render pass; a 16x16 copy
 * drawn in the same pass is read back for the scene-cut check. Generated
 * frames stay in a pool of GPU textures and are drawn into the page's canvas
 * (transferred here) when the page asks for the frame due at a media time.
 * Nothing round-trips through a 2D canvas or an ImageBitmap per frame: that
 * path cost as much as the model at 4K.
 *
 * At start the worker takes the largest processing size whose measured cost
 * fits the budget, tuning the model's kernels for this GPU first; tunes and
 * costs are handed back to the page, which keeps them, so it happens once.
 */

const SAMPLE = 16;
const BENCH_RUNS = 4;
const FRAMEGEN_VERSION = '1.4.0';
const STATIC_DIFF = 0.002;
const CUT_DIFF = 0.22;

let device: GPUDevice;
let adapterKey = '';
let weights: { bin: ArrayBuffer; manifest: Record<string, { offset: number; shape: number[] }> };
let model: RT | undefined;
let size: ProcessingSize = { width: 0, height: 0 };
let sizes: ProcessingSize[] = [];
let sizeIndex = 0;
let inputs: GPUTexture[] = [];
let pool: GPUTexture[] = [];
let queue: { time: number; texture: GPUTexture }[] = [];
let small: GPUTexture;
let readback: GPUBuffer;
let staging: GPUTexture | undefined;
let present: OffscreenCanvas | undefined;
let presentContext: GPUCanvasContext | undefined;
let blitPipeline: GPURenderPipeline;
let externalPipeline: GPURenderPipeline;
let scaleSmallPipeline: GPURenderPipeline;
let sampler: GPUSampler;
let priorSample: Uint8Array | undefined;
let priorTime: number | undefined;
let busy = false;
let tunes: TuneCache = {};
let shown: GPUTexture | undefined;

const VERTEX = `
  struct Out { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
  @vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
    let p = array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
    var o: Out; o.pos=vec4f(p[i],0,1); o.uv=vec2f((p[i].x+1)/2,(1-p[i].y)/2); return o;
  }`;

function pipelineFor(fragment: string, format: GPUTextureFormat) {
  const shader = device.createShaderModule({ code: VERTEX + fragment });
  return device.createRenderPipeline({ layout: 'auto', vertex: { module: shader, entryPoint: 'vs' }, fragment: { module: shader, entryPoint: 'fs', targets: [{ format }] } });
}

function releaseSize() {
  model?.destroy(); model = undefined;
  [...inputs, ...pool].forEach(t => t.destroy()); inputs = []; pool = []; queue = []; shown = undefined;
  staging?.destroy(); staging = undefined;
  priorSample = undefined; priorTime = undefined;
}
function release() {
  releaseSize(); small?.destroy(); readback?.destroy();
  presentContext?.unconfigure(); device?.destroy();
}

async function setupDevice() {
  if (!navigator.gpu) throw new Error('WebGPU is unavailable');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter?.features.has('shader-f16')) throw new Error('This GPU lacks float16 support');
  const info = adapter.info;
  adapterKey = [info?.vendor, info?.architecture, info?.device, info?.description, FRAMEGEN_VERSION].join('/');
  device = await adapter.requestDevice({ requiredFeatures: ['shader-f16'] });
  void device.lost.then(lost => { if (lost.reason !== 'destroyed') self.postMessage({ type: 'fatal', error: 'GPU connection lost' }); });
  device.addEventListener('uncapturederror', event => self.postMessage({ type: 'fatal', error: `Frame generation GPU error: ${event.error.message}` }));
  const responses = await Promise.all(['rt_v7s.bin', 'rt_v7s.json'].map(file => fetch(`${FRAMEGEN_ROOT}/${file}`, { signal: AbortSignal.timeout(15000) })));
  if (responses.some(r => !r.ok)) throw new Error('Frame generation model could not load');
  weights = { bin: await responses[0].arrayBuffer(), manifest: await responses[1].json() };
  sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  const format = navigator.gpu.getPreferredCanvasFormat();
  blitPipeline = pipelineFor(`
    @group(0) @binding(0) var image: texture_2d<f32>; @group(0) @binding(1) var smp: sampler;
    @fragment fn fs(o: Out) -> @location(0) vec4f { return vec4f(textureSample(image,smp,o.uv).rgb,1); }`, format);
  scaleSmallPipeline = pipelineFor(`
    @group(0) @binding(0) var image: texture_2d<f32>; @group(0) @binding(1) var smp: sampler;
    @fragment fn fs(o: Out) -> @location(0) vec4f { return vec4f(textureSample(image,smp,o.uv).rgb,1); }`, 'rgba8unorm');
  externalPipeline = pipelineFor(`
    @group(0) @binding(0) var image: texture_external; @group(0) @binding(1) var smp: sampler;
    @fragment fn fs(o: Out) -> @location(0) vec4f { return vec4f(textureSampleBaseClampToEdge(image,smp,o.uv).rgb,1); }`, 'rgba8unorm');
  small = device.createTexture({ size: [SAMPLE, SAMPLE], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  // copyTextureToBuffer rows are 256-byte aligned: 16 px x 4 B = 64, padded.
  readback = device.createBuffer({ size: 256 * SAMPLE, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
}

const tuneKey = (s: ProcessingSize) => `${adapterKey}|${s.width}x${s.height}`;

async function buildModel(s: ProcessingSize, mids: number, report: (message: string) => void) {
  releaseSize();
  const key = tuneKey(s);
  let entry = tunes[key];
  if (!entry) report(`Optimizing for your GPU at ${s.width}×${s.height} (one time)…`);
  const convTune = (entry?.tune as ConvTune | undefined) ?? await tuneConvRB(device, { ci: 192, co: 192, w16: s.width / 16, h16: s.height / 16 });
  model = await createRT(device, { w: s.width, h: s.height, weightsBin: weights.bin, weightsManifest: weights.manifest, convTune, textureInput: true, textureOutput: true });
  size = s;
  inputs = [0, 1].map(() => device.createTexture({ size: [s.width, s.height], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT }));
  pool = Array.from({ length: FRAMEGEN_POOL }, () => device.createTexture({ size: [s.width, s.height], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST }));
  if (present) { present.width = s.width; present.height = s.height; }
  if (!entry) {
    // The measured cost of one source frame: the trunk plus the generated frames.
    for (let run = 0; run <= BENCH_RUNS; run++) {
      if (run === 1) entry = { tune: convTune, ms: performance.now() };
      model.prepPair(inputs[0], inputs[1]);
      for (let k = 0; k < mids; k++) model.runT((k + 1) / (mids + 1), pool[k]);
      await device.queue.onSubmittedWorkDone();
    }
    entry = { tune: convTune, ms: (performance.now() - entry!.ms) / BENCH_RUNS };
    tunes[key] = entry;
  }
  return entry.ms;
}

function drawInto(target: GPUTexture, pipeline: GPURenderPipeline, resource: GPUBindingResource, encoder: GPUCommandEncoder) {
  const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource }, { binding: 1, resource: sampler }] });
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store' }] });
  pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.draw(3); pass.end();
}

/** Scales a source frame into `target` and a 16x16 sample, on the GPU. */
async function upload(source: VideoFrame | ImageBitmap, target: GPUTexture): Promise<Uint8Array> {
  const encoder = device.createCommandEncoder();
  if (source instanceof VideoFrame) {
    const external = device.importExternalTexture({ source });
    drawInto(target, externalPipeline, external, encoder);
    drawInto(small, externalPipeline, external, encoder);
  } else {
    if (!staging || staging.width !== source.width || staging.height !== source.height) {
      staging?.destroy();
      staging = device.createTexture({ size: [source.width, source.height], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
    }
    device.queue.copyExternalImageToTexture({ source }, { texture: staging }, [source.width, source.height]);
    drawInto(target, scaleSmallPipeline, staging.createView(), encoder);
    drawInto(small, scaleSmallPipeline, staging.createView(), encoder);
  }
  encoder.copyTextureToBuffer({ texture: small }, { buffer: readback, bytesPerRow: 256 }, [SAMPLE, SAMPLE]);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const padded = new Uint8Array(readback.getMappedRange());
  const sample = new Uint8Array(SAMPLE * SAMPLE * 4);
  for (let row = 0; row < SAMPLE; row++) sample.set(padded.subarray(row * 256, row * 256 + SAMPLE * 4), row * SAMPLE * 4);
  readback.unmap();
  return sample;
}

function difference(a: Uint8Array, b: Uint8Array) {
  let diff = 0;
  for (let i = 0; i < a.length; i += 4) for (let j = 0; j < 3; j++) diff += Math.abs(a[i + j] - b[i + j]);
  return diff / (SAMPLE * SAMPLE * 3 * 255);
}

/** A free pool texture; under pressure the oldest queued frame gives its up. */
function takeTexture(): GPUTexture {
  const busyTextures = new Set([...queue.map(q => q.texture), shown]);
  const free = pool.find(t => !busyTextures.has(t));
  if (free) return free;
  return queue.shift()!.texture;
}

function copy(from: GPUTexture, to: GPUTexture, encoder: GPUCommandEncoder) {
  encoder.copyTextureToTexture({ texture: from }, { texture: to }, [size.width, size.height]);
}

async function frame(data: { frame: VideoFrame | ImageBitmap; time: number; fps: number; reset?: boolean }) {
  const started = performance.now();
  if (!model) throw new Error('Frame generation is not ready');
  const sample = await upload(data.frame, inputs[1]);
  let count = 0;
  if (!data.reset && priorTime !== undefined && priorSample) {
    const times = outputTimes(priorTime, data.time, data.fps);
    const diff = difference(sample, priorSample);
    const moving = diff > STATIC_DIFF && diff < CUT_DIFF;
    if (moving && times.length) model.prepPair(inputs[0], inputs[1]);
    const encoder = device.createCommandEncoder();
    for (const time of times) {
      const t = (time - priorTime) / (data.time - priorTime);
      const texture = takeTexture();
      // A hard cut or a still picture has nothing to interpolate: repeat the nearer frame.
      if (moving && t > 0.001) model.runT(t, texture);
      else copy(t < 0.5 ? inputs[0] : inputs[1], texture, encoder);
      queue.push({ time, texture });
      count++;
    }
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
  }
  priorTime = data.time; priorSample = sample;
  inputs.reverse();
  return { count, ms: performance.now() - started };
}

/** Draws the newest frame due at `time` and frees the ones it passed. */
function presentAt(time: number): boolean {
  let due: { time: number; texture: GPUTexture } | undefined;
  while (queue.length && queue[0].time <= time + 0.001) due = queue.shift();
  if (!due || !presentContext) return false;
  const encoder = device.createCommandEncoder();
  const group = device.createBindGroup({ layout: blitPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: due.texture.createView() }, { binding: 1, resource: sampler }] });
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view: presentContext.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }] });
  pass.setPipeline(blitPipeline); pass.setBindGroup(0, group); pass.draw(3); pass.end();
  device.queue.submit([encoder.finish()]);
  shown = due.texture;
  return true;
}

/** The queued frames as images: for tests and diagnostics, never per frame. */
async function snapshot() {
  const canvas = new OffscreenCanvas(size.width, size.height);
  const context = canvas.getContext('webgpu')!;
  context.configure({ device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: 'opaque' });
  const frames: { time: number; frame: ImageBitmap }[] = [];
  for (const { time, texture } of queue) {
    const encoder = device.createCommandEncoder();
    const group = device.createBindGroup({ layout: blitPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: texture.createView() }, { binding: 1, resource: sampler }] });
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }] });
    pass.setPipeline(blitPipeline); pass.setBindGroup(0, group); pass.draw(3); pass.end();
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    frames.push({ time, frame: canvas.transferToImageBitmap() });
  }
  context.unconfigure();
  return frames;
}

self.onmessage = async ({ data }) => {
  // Presentation is cheap and never waits behind generation.
  if (data.type === 'present') { self.postMessage({ type: 'presented', shown: model ? presentAt(data.time) : false }); return; }
  if (data.type === 'clear') { queue = []; priorTime = undefined; priorSample = undefined; return; }
  if (data.type === 'dispose') { release(); self.close(); return; }
  if (busy) { data.frame?.close(); self.postMessage({ id: data.id, error: 'Frame generation busy' }); return; }
  busy = true;
  try {
    if (data.type === 'init') {
      sizes = data.sizes; tunes = data.tunes ?? {};
      if (data.canvas) {
        present = data.canvas as OffscreenCanvas;
        presentContext = present.getContext('webgpu')!;
      }
      await setupDevice();
      presentContext?.configure({ device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: 'opaque' });
      const report = (message: string) => self.postMessage({ type: 'progress', message });
      // The largest size that fits, or the smallest one if none does.
      for (sizeIndex = 0; sizeIndex < sizes.length; sizeIndex++) {
        const ms = await buildModel(sizes[sizeIndex], data.mids, report);
        if (ms <= data.budgetMs || sizeIndex === sizes.length - 1) break;
      }
      self.postMessage({ id: data.id, size, tunes, baselineMs: tunes[tuneKey(size)]?.ms });
    } else if (data.type === 'step-down') {
      if (sizeIndex >= sizes.length - 1) throw new Error('GPU cannot keep up');
      sizeIndex++;
      await buildModel(sizes[sizeIndex], data.mids, message => self.postMessage({ type: 'progress', message }));
      self.postMessage({ id: data.id, size, tunes, baselineMs: tunes[tuneKey(size)]?.ms });
    } else if (data.type === 'probe') {
      // One source frame's work, timed, with nothing on screen: tells the page
      // whether the GPU is still shared (see lib/gpu-contention.ts).
      if (!model) throw new Error('Frame generation is not ready');
      const started = performance.now();
      model.prepPair(inputs[0], inputs[1]);
      for (let k = 0; k < data.mids; k++) model.runT((k + 1) / (data.mids + 1), pool[k]);
      await device.queue.onSubmittedWorkDone();
      self.postMessage({ id: data.id, ms: performance.now() - started });
    } else if (data.type === 'frame') {
      self.postMessage({ id: data.id, ...await frame(data) });
    } else if (data.type === 'snapshot') {
      const frames = await snapshot();
      self.postMessage({ id: data.id, frames }, { transfer: frames.map(f => f.frame) });
    } else self.postMessage({ id: data.id });
  } catch (error) {
    self.postMessage({ id: data.id, error: error instanceof Error ? error.message : 'Frame generation failed' });
  } finally { data.frame?.close(); busy = false; }
};
