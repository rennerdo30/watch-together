# Local loudness normalization

**Normalize volume** and **Night mode** are independent local preferences:

- Normalize volume is off by default. It measures K-weighted stereo energy in
  400 ms windows at 100 ms steps, then uses up to three seconds of gated history
  to adjust toward -18 LUFS. Boost is capped at +12 dB and attenuation at -24 dB;
  gain rises at no more than 1 dB/s and falls at no more than 6 dB/s.
- Night mode is the existing dynamics compressor plus manual make-up gain. Its
  historical storage identifiers (`w2g-player-normalization` and `...-gain`) still
  represent this same compression preference, preserving existing choices.
- Silence below -60 LUFS and sections below the relative -10 LU gate cannot
  increase gain. Sustained silence clears history and returns positive gain
  toward unity. New sources and seeks reset measurement/filter/gain history.

The one signal chain is:

```
media source → optional Night compressor/gain → optional mono downmix
             → optional loudness worklet/peak protection → optional framegen delay
             → speakers
```

Both audio channels use the same gain and instantaneous limiter coefficient, so
stereo balance is preserved. The worklet explicitly receives a stereo speaker
mix (the browser downmixes multichannel audio). Peak protection has a -1 dBFS
**sample-peak** ceiling with immediate attenuation and 100 ms recovery. It does
not oversample or guarantee intersample true peaks. Streaming adaptation and the
playback-specific silence gate mean this is not certified whole-program EBU R128
normalization. It adds no intentional buffering and does not change media time,
playback rate, source selection or room messages.

The sample-rate-adjusted K filter uses the BS.1770/De Man coefficient design;
48 kHz coefficients are checked against the published values. Mathematical
reference: https://github.com/csteinmetz1/pyloudnorm (DeMan filters and meter).
The DSP and worklet wrapper here are local implementations; no audio is uploaded
and there are no runtime third-party requests or new package dependencies.

`scripts/build-upscaling.mjs` bundles the worklet into
`public/audio/v1/normalizer.worklet.js`. It is loaded only after normalization is
switched on. Existing audio routing stays connected during loading. A load or
processor failure bypasses the worklet and is reported to client error telemetry.
Toggle Off/on to retry. Measurement compensates for the media element's volume before K weighting, so
normalization does not counteract the user's volume slider. Muting/zero volume
freezes adaptation and outputs silence. Muting/volume remain the media element's
own controls;
normalization cannot recover inaudible speech that does not exist in the source.

Verification:

```
npm run test:e2e -- e2e/loudness-policy.spec.ts e2e/volume-normalization.spec.ts e2e/mono-audio.spec.ts e2e/frame-generation.spec.ts
npm run build
```

Tests check measured quiet/loud convergence, silence, peak bounds after a sudden
level jump, stereo balance, filter coefficients, reset/non-finite handling, actual
OfflineAudioContext worklet rendering, independent toggles and persisted settings,
load/processor failure recovery, and interaction with the existing audio graph.
Perceptual listening across speech, music and noisy recordings is still useful;
this does not promise that every recording will sound equally good.
