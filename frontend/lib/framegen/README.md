# Local motion smoothing (beta)

Quality and sync settings → Motion smoothing offers Off (default), 30 fps and
60 fps. It is saved per browser, never broadcast to the room. The original media
element remains the only playback/synchronization clock; generation never writes
its src, currentTime, playbackRate, volume or play state. Live/shared streams are
excluded. Native fullscreen/PiP, captions, inaccessible frames and HDR/protected
video retain native presentation. Hidden tabs release the worker; toggle Off/on
to retry. Upscaling is temporarily suspended while smoothing owns the picture,
and resumes on Off or a processing failure. Combined neural upscaling is not
implemented in this beta.

The pinned `framegen` npm runtime 1.4.0 and v7-small model are bundled by
`scripts/build-upscaling.mjs` into `/framegen/v1/`. No assets or capability probes
load until opt-in; all inference runs locally with WebGPU float16. No decoded
frames leave the browser. Code: MIT, Monzik Allen. Model: non-commercial research
and personal use only. The unmodified weights notice, copied from upstream
Framegen commit `9641808` (extension release v1.5.5), ships next to the model.
Do not describe the bundled model as unrestricted or use it in a paid service.
Upstream: https://github.com/MONZikWasTaken/Framegen.

A worker buffers two frames and samples an exact 30/60 fps media-time grid at
arbitrary interpolation times (24→30 is not a speed change). The whole path is on
the GPU: a `VideoFrame` of the source is scaled into the model's input by a render
pass (a 16×16 copy in the same pass feeds the scene-cut check), generated frames
stay in a pool of GPU textures, and the worker draws the frame due at each media
time into the page's canvas, which it owns (`transferControlToOffscreen`). The
earlier path through a 2D canvas, a CPU read-back and an `ImageBitmap` per frame
cost as much as the model at 4K.

Processing size is chosen per GPU: the candidates are the source size (up to 4K),
then 1440p, 1080p and 720p below it, padded to multiples of 16. On first use the
worker tunes the model's convolution kernels for this GPU and size
(`tuneConvRB`, a few seconds; it halves the model's cost) and measures one source
frame's work; it takes the largest size within `FRAMEGEN_BUDGET_MS`. Tunes and
costs are kept in `localStorage` (`wt_framegen_tune_v1`), keyed by adapter, so
later starts are immediate. Sustained overload steps down one size; below the
smallest size, original playback returns.
Measured on an Apple M-series GPU (Metal), per source frame: 1080p→60 fps 9.6 ms,
4K→60 fps processed at 1440p 20.7 ms (4K itself 30.7 ms, over budget).
A small scene-difference sample bypasses neural interpolation for static frames
and hard cuts; detection is heuristic and does not eliminate all artifacts.

Presentation is buffered by 120 ms of wall-clock playback time. The existing
single Web Audio graph gains a matching DelayNode while the overlay is visible;
its delay returns to zero on seeks, pauses, failures and Off. Local presentation
therefore trails the room's media clock by about 120 ms; group playback retains
its existing media clock and is not guaranteed visually frame-locked between
viewers. Native Web Audio/output-device latency and perceptual lip-sync still
need physical-device validation. The node is prepared only after a successful
pixel-access probe so inaccessible sources are not newly routed into Web Audio.

Bounded queues, capture backpressure, frame deadlines, epoch checks and a
sustained processing-budget check prevent old frames from covering new playback.
Failure retains original playback and is reported to client-error telemetry.
Off/on retries; there is no frame-blending fallback advertised as AI generation.

## Sharing the GPU (a game on another screen)

A page cannot see other programs or the GPU's load. It can see its own work:
`lib/gpu-contention.ts` compares each frame's cost with the cost on an idle GPU
(motion smoothing: the first-use measurement; upscaling: the median of its first
30 frames). Work sustained at twice that, and at least 4 ms more, means the GPU
is shared, typically with a game. Processing then steps aside, the original
picture shows, and a notice over the player says why. A probe every three
seconds times the same work; two normal probes bring processing back. Slowness
from contention does not lower the size or drop the neural model for good.

## Verification

```
npm run build
npm run test:e2e -- e2e/framegen-policy.spec.ts e2e/frame-generation.spec.ts
```

Tests cover exact 24→30 timing, limits, opt-in/no-GPU behavior, actual GPU model
output/motion/orientation, hard cuts, audio delay changes, seek/off cleanup,
failure and unchanged manifest/media identity. Actual GPU cases require a
float16 adapter; passing tiny fixtures is not evidence of sustained 1080p/4K
throughput. Validate desktop/mobile GPU load, long playback, audio, thermals and
fast motion before treating this beta as generally supported.
