import { loadLiteRt, loadAndCompile, Tensor, type CompiledModel } from '@litertjs/core';
import { ASSET_ROOT, animationProbability } from './policy';

let model: CompiledModel | undefined;
let busy = false;
self.onmessage = async (event: MessageEvent<{ id: number; pixels: Uint8ClampedArray; type?: string }>) => {
  const { id, pixels, type } = event.data;
  if (type === 'dispose') { model?.delete(); self.close(); return; }
  if (busy) { self.postMessage({ id, error: 'Classifier busy' }); return; }
  busy = true;
  let input: Tensor | undefined;
  let outputs: Tensor[] = [];
  try {
    if (!model) {
      // Single-threaded WASM in a worker: no COOP/COEP, GPU, or experimental
      // browser flags needed. All runtime/model requests remain same-origin.
      await loadLiteRt(new URL(`${ASSET_ROOT}/`, self.location.origin).href);
      const response = await fetch(`${ASSET_ROOT}/content_detection_mobilenet_v3.tflite`,
        { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error('Content model could not be loaded');
      model = await loadAndCompile(new Uint8Array(await response.arrayBuffer()), { accelerator: 'wasm' });
      const details = model.getInputDetails();
      if (details.length !== 1 || Array.from(details[0].shape).join(',') !== '1,224,224,3' || details[0].dtype !== 'float32') {
        throw new Error('Unexpected classifier input');
      }
    }
    if (pixels.length !== 224 * 224 * 4) throw new Error('Invalid sample');
    const rgb = new Float32Array(224 * 224 * 3);
    for (let p = 0, i = 0; p < pixels.length; p += 4) {
      rgb[i++] = pixels[p] / 255; rgb[i++] = pixels[p + 1] / 255; rgb[i++] = pixels[p + 2] / 255;
    }
    input = new Tensor(rgb, [1, 224, 224, 3]);
    outputs = await model.run(input);
    const scores = await outputs[0].data();
    if (scores.length !== 2 || !Number.isFinite(Number(scores[1]))) throw new Error('Invalid classification');
    self.postMessage({ id, probability: animationProbability(Number(scores[0]), Number(scores[1])) });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : 'Content detection failed' });
  } finally {
    input?.delete(); outputs.forEach(tensor => tensor.delete()); busy = false;
  }
};
