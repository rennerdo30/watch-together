# Client-side video enhancement (beta)

Open **Quality and sync settings → Video enhancement** in the player. The
feature is off by default. Auto, Animation, and General / live action are saved
locally for this viewer; they are never broadcast to the room.

All processing and classification run on the viewer's device. The backend
continues delivering the original stream and static scripts/models. There is
no inference endpoint, frame upload, runtime CDN or vendor-specific SDK.

## Capabilities

Runtime checks apply equally to AMD, NVIDIA, Intel, Apple Silicon and mobile GPUs:

- WebGPU plus transferable OffscreenCanvas: small Anime4K CNN, using WebSR's
  animation or live-action weights, at 2× source resolution.
- Otherwise, or after neural failure/overload: WebGL 2 bicubic scaling with
  restrained sharpening. This is a spatial filter, not FSR or neural reconstruction.
- No usable GPU, inaccessible frames, or sustained spatial overload: original
  video. Turning Off and back on retries after failure.

One frame is processed at a time. Actual completion times govern fallback, not
GPU vendor or user-agent guesses. Output is capped at 2×, 4096 pixels per axis,
and roughly 4K total pixels. Neural input is limited to 1080p within GPU limits.
Processing is skipped when the display does not need enlargement. Fullscreen
on the player container preserves enhancement; native video fullscreen and
picture-in-picture use the original picture.

Decoded frames must be accessible regardless of provider. Same-origin proxied
streams work without changing the player's CORS mode. Direct external streams
may remain playable while rejecting processing; original playback continues.
Protected media and native captions bypass enhancement. Recognized HDR transfer
functions also bypass the 8-bit pipeline; browsers vary in exposing this metadata,
so HDR fidelity is not certified by the beta.

## Automatic selection

Auto samples a 224×224 center crop every five seconds during playback. WebSR's
MobileNetV3 classifier executes in a separate, single-threaded LiteRT WASM worker.
Its logits are normalized with a stable two-class softmax. Switching requires
three consecutive results with at least 80% confidence and at least 20 seconds
since the previous switch. Uncertain results keep the current mode, initially
General. Gaming and mixed content are not separate classes. Manual selection
always wins; classifier failure keeps General and explains the limitation.

Auto downloads approximately 13 MB of classifier/runtime files before compression
on first use. Manual modes do not load these files. Model accuracy and perceived
quality vary, particularly on mixed content and compressed live-action footage.

## Playback isolation

The hook depends only on the actual media element, source identity and local mode.
It does not depend on heartbeats, playback position or play state. The controller
never writes source/time/rate/volume or calls play/pause. It hides stale output
during seeks, releases render resources in hidden tabs, and cleans up workers on
unmount or mode changes. Deadlines and generation checks reject late asynchronous
work. Spatial GPU fences yield instead of blocking playback with gl.finish().

One neural worker owns one WebSR global context. It rebuilds model resources on
dimension/content changes, releases owned textures and buffers, and retains the
GPU device. This avoids upstream's resize path, which destroys the device it
then attempts to reuse. First/last pipelines compile once per model rather than
every frame. Validation errors and device loss trigger fallback.

## Asset build and upstream fixes

`npm run build:upscaling` runs before dev and production builds. It generates
`public/upscaling/v1/` from lockfile-pinned npm dependencies without downloading
models at build time. Docker already copies these public assets. Generated files
are ignored in Git. Keep THIRD_PARTY_NOTICES.txt with distributed assets.

The build bundles WebSR's TypeScript source instead of its eval-based development
bundle. Checked build transforms cover non-multiple-of-eight frame sizes, guard
excess invocations, prevent convolution buffer reads from wrapping across rows,
and clamp display sampling at edges. Source mismatch fails the build so dependency
upgrades cannot silently discard fixes. Review these transforms when upgrading.

Classic workers are intentional: LiteRT uses importScripts and resolves WASM
relative to the worker URL. Runtime files must live alongside the worker. Bump
ASSET_ROOT and the build output path together when changing the worker protocol.

## Verification and beta limits

```
npm run test:e2e -- e2e/enhancement-policy.spec.ts e2e/video-enhancement.spec.ts e2e/playback-stability.spec.ts
npm run build
```

Actual-worker tests run the shipped models, test neural output color/orientation,
and change models and dimensions. Neural tests use full Chromium's new headless
mode and skip only if no adapter exists; headless-shell may expose an unusable
adapter. Other tests exercise fallback, lifecycle, local mode selection, phone
layout and unchanged media identity/manifest requests.

Automated tests cannot certify every driver/device. Before promoting the beta
to a default feature, validate sustained playback, perceptual quality, battery
and thermal behavior on physical AMD, NVIDIA, Intel, Apple, Android and iOS
devices with representative real streams.
