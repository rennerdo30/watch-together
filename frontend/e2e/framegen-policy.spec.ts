import { test, expect } from '@playwright/test';
import { FrameRateEstimate, needsGeneration, outputTimes, parseFramegenMode, processingSizes } from '../lib/framegen/policy';

test('frame generation is opt-in with validated targets', () => {
  for (const value of [null, '', 'auto', '120', 'constructor']) expect(parseFramegenMode(value)).toBe('off');
  expect(parseFramegenMode('30')).toBe('30'); expect(parseFramegenMode('60')).toBe('60');
});
test('24 to 30 fps samples an exact output grid without duplicates or speeding video', () => {
  const times = Array.from({ length: 24 }, (_, i) => outputTimes(i / 24, (i + 1) / 24, 30)).flat();
  expect(times).toHaveLength(30);
  expect(new Set(times).size).toBe(30);
  for (let i = 0; i < 30; i++) expect(times[i]).toBeCloseTo(i / 30, 8);
  expect(outputTimes(0, 1 / 24, 60)).toHaveLength(3);
  for (const b of [0, -1, 1, NaN]) expect(outputTimes(0, b, 30)).toEqual([]);
});
test('processing sizes start at the source and step down, aligned, rejecting invalid dimensions', () => {
  expect(processingSizes(0, 1080)).toBeNull();
  expect(processingSizes(8000, 4000)).toBeNull();
  // A 4K source used to be processed at 1080p at most, whatever the GPU.
  expect(processingSizes(3840, 2160)).toEqual([
    { width: 3840, height: 2160 }, { width: 2560, height: 1440 }, { width: 1920, height: 1088 }, { width: 1280, height: 720 },
  ]);
  expect(processingSizes(1920, 1080)).toEqual([{ width: 1920, height: 1088 }, { width: 1280, height: 720 }]);
  expect(processingSizes(1280, 720)).toEqual([{ width: 1280, height: 720 }]);
  for (const sizes of [processingSizes(3840, 1600)!, processingSizes(1000, 562)!]) {
    for (const size of sizes) { expect(size.width % 16).toBe(0); expect(size.height % 16).toBe(0); }
  }
});

test('the source rate is measured before anything is generated, and a fast enough source is left alone', () => {
  const rateOf = (fps: number, frames: number) => {
    const estimate = new FrameRateEstimate();
    let interval: number | undefined;
    for (let i = 0; i < frames; i++) interval = estimate.observe(i / fps);
    return interval;
  };
  // Unknown for the first frames: nothing may be processed yet.
  expect(rateOf(30, 8)).toBeUndefined();
  expect(1 / rateOf(30, 9)!).toBeCloseTo(30, 5);
  // 30 fps at the 30 setting and 60 fps at either setting have nothing to gain.
  expect(needsGeneration(1 / 30, 30)).toBe(false);
  expect(needsGeneration(1 / 60, 30)).toBe(false);
  expect(needsGeneration(1 / 60, 60)).toBe(false);
  expect(needsGeneration(1 / 24, 30)).toBe(true);
  expect(needsGeneration(1 / 30, 60)).toBe(true);
  expect(needsGeneration(1 / 29.97, 30)).toBe(false);
  // A seek or stall is not the frame rate.
  const estimate = new FrameRateEstimate();
  for (let i = 0; i < 9; i++) estimate.observe(i / 24);
  estimate.break(); estimate.observe(100); estimate.observe(100 + 1 / 24);
  expect(1 / estimate.interval!).toBeCloseTo(24, 5);
});
