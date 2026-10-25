import { test, expect } from '@playwright/test';
import { kWeighting, LoudnessNormalizer, LOUDNESS_CONFIG } from '../lib/audio/loudness';

function tone(normalizer: LoudnessNormalizer, amplitude: number, seconds: number, rate = 48000) {
  const size = 128, left = new Float32Array(size), right = new Float32Array(size);
  const outL = new Float32Array(size), outR = new Float32Array(size);
  let tailEnergy = 0, tailCount = 0, max = 0;
  for (let start = 0; start < rate * seconds; start += size) {
    for (let i = 0; i < size; i++) left[i] = right[i] = amplitude * Math.sin(2 * Math.PI * 1000 * (start + i) / rate);
    normalizer.process([left, right], [outL, outR]);
    for (let i = 0; i < size; i++) {
      max = Math.max(max, Math.abs(outL[i]), Math.abs(outR[i]));
      if (start >= rate * (seconds - 1)) { tailEnergy += outL[i] ** 2; tailCount++; }
    }
  }
  return { rms: Math.sqrt(tailEnergy / tailCount), max };
}

test('K weighting matches the published 48 kHz BS.1770 filter coefficients', () => {
  const [shelf, hp] = kWeighting(48000);
  const expectedShelf = [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585];
  const expectedHp = [1, -2, 1, -1.99004745483398, 0.99007225036621];
  shelf.forEach((x, i) => expect(x).toBeCloseTo(expectedShelf[i], 9));
  hp.forEach((x, i) => expect(x).toBeCloseTo(expectedHp[i], 9));
});
test('quiet and loud videos converge to comparable loudness without compression being enabled', () => {
  const quiet = new LoudnessNormalizer(48000), loud = new LoudnessNormalizer(48000);
  const a = tone(quiet, 0.03, 18), b = tone(loud, 0.3, 18);
  expect(Math.abs(20 * Math.log10(a.rms / b.rms))).toBeLessThan(1);
  expect(quiet.gainDb).toBeGreaterThan(10); expect(loud.gainDb).toBeLessThan(-5);
  expect(a.max).toBeLessThanOrEqual(quiet.peak + 1e-6); expect(b.max).toBeLessThanOrEqual(loud.peak + 1e-6);
});
test('silence and very quiet noise never wind gain upward; boosts remain bounded', () => {
  const silent = new LoudnessNormalizer(48000);
  tone(silent, 0, 3); expect(silent.gainDb).toBe(0); expect(silent.measuredLufs).toBeNull();
  tone(silent, 0.000001, 5); expect(silent.gainDb).toBe(0);
  tone(silent, 0.01, 16); expect(silent.gainDb).toBeCloseTo(LOUDNESS_CONFIG.maxBoostDb, 3);
  tone(silent, 0, 4); expect(silent.gainDb).toBeCloseTo(0, 3);
});
test('a loud transient after boosted audio stays below the sample-peak ceiling and stereo balance is preserved', () => {
  const normalizer = new LoudnessNormalizer(48000); tone(normalizer, 0.01, 16);
  const left = new Float32Array(128).fill(0.99), right = new Float32Array(128).fill(0.495);
  const outL = new Float32Array(128), outR = new Float32Array(128);
  normalizer.process([left, right], [outL, outR]);
  for (let i = 0; i < 128; i++) { expect(outL[i]).toBeLessThanOrEqual(normalizer.peak + 1e-6); expect(outL[i]).toBeCloseTo(outR[i] * 2, 6); }
});
test('new videos reset accumulated gain and invalid input cannot poison the filter', () => {
  const normalizer = new LoudnessNormalizer(48000); tone(normalizer, 0.03, 3);
  normalizer.reset(); expect(normalizer.gainDb).toBe(0); expect(normalizer.measuredLufs).toBeNull();
  const input = new Float32Array([NaN, Infinity, -Infinity, 0.1]), output = new Float32Array(4);
  normalizer.process([input], [output]); expect(Array.from(output).every(Number.isFinite)).toBe(true);
  expect(() => new LoudnessNormalizer(0)).toThrow();
});

test('normalization preserves user volume and mute instead of chasing them', () => {
  const full = new LoudnessNormalizer(48000), quiet = new LoudnessNormalizer(48000);
  quiet.setInputVolume(0.25);
  const a = tone(full, 0.03, 18), b = tone(quiet, 0.03 * 0.25, 18);
  expect(quiet.gainDb).toBeCloseTo(full.gainDb, 3);
  expect(b.rms / a.rms).toBeCloseTo(0.25, 3);
  const beforeMute = quiet.gainDb; quiet.setInputVolume(0);
  expect(tone(quiet, 0, 3).rms).toBe(0);
  expect(quiet.gainDb).toBe(beforeMute);
});
