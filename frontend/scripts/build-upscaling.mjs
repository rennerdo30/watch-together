import { build } from 'esbuild';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'public/upscaling/v1');
const websr = path.join(root, 'node_modules/@websr/websr');
const litert = path.join(root, 'node_modules/@litertjs/core');
// Narrow, checked fixes to the pinned upstream kernels. Failing on a source
// mismatch makes dependency upgrades explicit instead of silently dropping
// border handling or dispatch guards.
function replaceChecked(source, before, after) {
  if (!source.includes(before)) throw new Error(`WebSR source changed: ${before}`);
  return source.replaceAll(before, after);
}
await mkdir(output, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ['lib/upscaling/neural.worker.ts', 'lib/upscaling/classifier.worker.ts'],
  // LiteRT's Emscripten loader uses importScripts in workers; emit classic
  // self-contained workers rather than module workers.
  outdir: output, bundle: true, minify: true, format: 'iife', platform: 'browser', target: 'es2022',
  // Upstream's published main uses eval and ships a development bundle.
  alias: { '@websr/websr': path.join(websr, 'src/main.ts') },
  legalComments: 'linked',
  plugins: [{ name: 'websr-frame-boundaries', setup(builder) {
    builder.onLoad({ filter: /[\\/]@websr[\\/]websr[\\/]src[\\/]layers[\\/].*\.ts$/ }, async ({ path: file }) => {
      const name = path.basename(file);
      if (!['base_compute_layer.ts', 'conv2d-3x4.ts', 'conv2d-8x4.ts', 'display.ts'].includes(name)) return;
      let contents = await readFile(file, 'utf8');
      if (name === 'base_compute_layer.ts') {
        contents = replaceChecked(contents, 'Math.floor(this.resolution.width/this.num_work_groups)', 'Math.ceil(this.resolution.width/this.num_work_groups)');
        contents = replaceChecked(contents, 'Math.floor(this.resolution.height/this.num_work_groups)', 'Math.ceil(this.resolution.height/this.num_work_groups)');
      }
      if (name.startsWith('conv2d-')) {
        contents = replaceChecked(contents, 'let x = id.x;', 'if (id.x >= ${this.resolution.width}u || id.y >= ${this.resolution.height}u) { return; }\n                let x = id.x;');
      }
      if (name === 'conv2d-8x4.ts') {
        contents = replaceChecked(contents, 'let pixel_loc = coord + vec2<i32>(kernel_offsets[i].xy);',
          'let pixel_loc = clamp(coord + vec2<i32>(kernel_offsets[i].xy), vec2<i32>(0), vec2<i32>(${this.resolution.width - 1}, ${this.resolution.height - 1}));');
      }
      if (name === 'display.ts') {
        contents = replaceChecked(contents, '"repeat"', '"clamp-to-edge"');
      }
      return { contents, loader: 'ts' };
    });
  } }],
});
for (const mode of ['an', 'rl']) {
  const file = `cnn-2x-s-${mode}.json`;
  await copyFile(path.join(websr, 'weights/anime4k', file), path.join(output, file));
}
await copyFile(path.join(websr, 'weights/tflite/content_detection_mobilenet_v3.tflite'),
  path.join(output, 'content_detection_mobilenet_v3.tflite'));
for (const variant of ['internal', 'compat_internal']) {
  for (const extension of ['js', 'wasm']) {
    const file = `litert_wasm_${variant}.${extension}`;
    // Emscripten in a classic worker resolves its .wasm relative to the worker
    // URL, so place the runtime beside the worker rather than in a subfolder.
    await copyFile(path.join(litert, 'wasm', file), path.join(output, file));
  }
}
await writeFile(path.join(output, 'LICENSE-WebSR.txt'), await readFile(path.join(websr, 'LICENSE')));
await copyFile(path.join(root, 'lib/upscaling/THIRD_PARTY_NOTICES.txt'), path.join(output, 'THIRD_PARTY_NOTICES.txt'));
console.log('Built local upscaling workers, models, and WASM runtime.');
