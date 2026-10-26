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
arbitrary interpolation times (24→30 is not a speed change). Processing is capped
at up to 1920×1080, padded to multiples of 16 (1920×1088 for Full HD), and
presented through a canvas. 720p sources retain 1280×720 processing; larger
sources are scaled down to the Full HD bound. Real-time throughput depends on
the GPU; sustained overload returns to original playback.
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
