/// <reference types="@webgpu/types" />
import { createRT, type RT } from 'framegen';
import { FRAMEGEN_ROOT, outputTimes, type GeneratedFrame } from './policy';

let device: GPUDevice;
let model: RT | undefined;
let textures: GPUTexture[] = [];
let output: GPUTexture;
let canvas: OffscreenCanvas;
let context: GPUCanvasContext;
let scaler: OffscreenCanvas;
let scaleContext: OffscreenCanvasRenderingContext2D;
let samplerCanvas: OffscreenCanvas;
let sampleContext: OffscreenCanvasRenderingContext2D;
let priorSample: Uint8ClampedArray | undefined;
let priorTime: number | undefined;
let pipeline: GPURenderPipeline;
let sampler: GPUSampler;
let busy = false;
let width = 0;
let height = 0;

function release() {
  model?.destroy(); model = undefined;
  textures.forEach(t => t.destroy()); textures = [];
  output?.destroy();
  context?.unconfigure(); device?.destroy();
}
async function init(w: number, h: number) {
  if (!navigator.gpu) throw new Error('WebGPU is unavailable');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter?.features.has('shader-f16')) throw new Error('This GPU lacks float16 support');
  device = await adapter.requestDevice({ requiredFeatures: ['shader-f16'] });
  void device.lost.then(info => { if (info.reason !== 'destroyed') self.postMessage({ type: 'fatal', error: 'GPU connection lost' }); });
  device.addEventListener('uncapturederror', event => self.postMessage({ type: 'fatal', error: `Frame generation GPU error: ${event.error.message}` }));
  width = w; height = h;
  const responses = await Promise.all(['rt_v7s.bin', 'rt_v7s.json'].map(file => fetch(`${FRAMEGEN_ROOT}/${file}`, { signal: AbortSignal.timeout(15000) })));
  if (responses.some(r => !r.ok)) throw new Error('Frame generation model could not load');
  model = await createRT(device, { w, h, weightsBin: await responses[0].arrayBuffer(), weightsManifest: await responses[1].json(), textureInput: true, textureOutput: true });
  textures = [0, 1].map(() => device.createTexture({ size: [w, h], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT }));
  output = device.createTexture({ size: [w, h], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING });
  canvas = new OffscreenCanvas(w, h);
  context = canvas.getContext('webgpu')!;
  context.configure({ device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: 'opaque' });
  scaler = new OffscreenCanvas(w, h); scaleContext = scaler.getContext('2d')!;
  samplerCanvas = new OffscreenCanvas(16, 16); sampleContext = samplerCanvas.getContext('2d', { willReadFrequently: true })!;
  sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  const shader = device.createShaderModule({ code: `
    @group(0) @binding(0) var image: texture_2d<f32>;
    @group(0) @binding(1) var smp: sampler;
    struct Out { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
    @vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
      let p = array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
      var o: Out; o.pos=vec4f(p[i],0,1); o.uv=vec2f((p[i].x+1)/2,(1-p[i].y)/2); return o;
    }
    @fragment fn fs(o: Out) -> @location(0) vec4f { return vec4f(textureSample(image,smp,o.uv).rgb,1); }
  ` });
  pipeline = await device.createRenderPipelineAsync({ layout: 'auto', vertex: { module: shader, entryPoint: 'vs' }, fragment: { module: shader, entryPoint: 'fs', targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }] } });
}
async function snapshot(texture: GPUTexture): Promise<ImageBitmap> {
  const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: texture.createView() }, { binding: 1, resource: sampler }] });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }] });
  pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.draw(3); pass.end();
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  return canvas.transferToImageBitmap();
}
self.onmessage = async ({ data }) => {
  if (data.type === 'dispose') { release(); self.close(); return; }
  if (busy) { data.frame?.close(); self.postMessage({ id: data.id, error: 'Frame generation busy' }); return; }
  busy = true;
  const frames: GeneratedFrame[] = [];
  try {
    if (data.type === 'init') await init(data.width, data.height);
    else if (data.type === 'frame') {
      const started = performance.now();
      const frame: ImageBitmap = data.frame;
      if (frame.width === 0 || !model) throw new Error('Invalid video frame');
      scaleContext.drawImage(frame, 0, 0, width, height);
      sampleContext.drawImage(frame, 0, 0, 16, 16);
      const sample = sampleContext.getImageData(0, 0, 16, 16).data;
      let diff = 0;
      if (priorSample) for (let i = 0; i < sample.length; i += 4) for (let j = 0; j < 3; j++) diff += Math.abs(sample[i + j] - priorSample[i + j]);
      diff /= 16 * 16 * 3 * 255;
      device.queue.copyExternalImageToTexture({ source: scaler }, { texture: textures[1] }, [width, height]);
      if (!data.reset && priorTime !== undefined) {
        const times = outputTimes(priorTime, data.time, data.fps);
        const moving = diff > 0.002 && diff < 0.22;
        if (moving && times.length) model.prepPair(textures[0], textures[1]);
        for (const time of times) {
          const t = (time - priorTime) / (data.time - priorTime);
          if (moving && t > 0.001) { model.runT(t, output); frames.push({ time, frame: await snapshot(output) }); }
          else frames.push({ time, frame: await snapshot(t < 0.5 ? textures[0] : textures[1]) });
        }
      }
      priorTime = data.time; priorSample = sample;
      textures.reverse();
      self.postMessage({ id: data.id, frames, ms: performance.now() - started }, { transfer: frames.map(f => f.frame) });
      return;
    }
    self.postMessage({ id: data.id });
  } catch (error) {
    frames.forEach(f => f.frame.close());
    self.postMessage({ id: data.id, error: error instanceof Error ? error.message : 'Frame generation failed' });
  } finally { data.frame?.close(); busy = false; }
};
