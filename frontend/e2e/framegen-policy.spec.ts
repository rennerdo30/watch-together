import { test, expect } from '@playwright/test';
import { outputTimes, parseFramegenMode, processingSize } from '../lib/framegen/policy';

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
test('processing sizes are bounded, aligned and reject invalid dimensions', () => {
  expect(processingSize(0, 1080)).toBeNull();
  expect(processingSize(8000, 4000)).toBeNull();
  const size = processingSize(1920, 1080)!;
  expect(size.width).toBeLessThanOrEqual(960); expect(size.height).toBeLessThanOrEqual(544);
  expect(size.width % 16).toBe(0); expect(size.height % 16).toBe(0);
});
