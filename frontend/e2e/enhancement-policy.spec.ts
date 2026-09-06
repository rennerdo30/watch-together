import { test, expect } from '@playwright/test';
import { animationProbability, ContentSelection, RenderBudget, neuralFits, outputSize, parseUpscaleMode } from '../lib/upscaling/policy';

test('classifier logits become stable probabilities before confidence gating', () => {
  expect(animationProbability(-2, -2)).toBe(0.5);
  expect(animationProbability(-4, 4)).toBeGreaterThan(0.99);
  expect(animationProbability(1000, -1000)).toBe(0);
  expect(animationProbability(-1000, 1000)).toBe(1);
  expect(() => animationProbability(NaN, 0)).toThrow();
});

test('enhancement is opt-in and stored values are validated', () => {
  for (const value of [null, '', 'true', 'undefined', 'constructor']) expect(parseUpscaleMode(value)).toBe('off');
  for (const value of ['auto', 'animation', 'general']) expect(parseUpscaleMode(value)).toBe(value);
});

test('output fits the display and allocation limits without changing aspect ratio', () => {
  expect(outputSize(1920, 1080, 960, 540, 1)).toBeNull();
  expect(outputSize(1280, 720, 2560, 1440, 1)).toEqual({ width: 2560, height: 1440 });
  expect(outputSize(0, 720, 2560, 1440, 1)).toBeNull();
  expect(outputSize(1280, 720, 2560, 1440, NaN)).toBeNull();
  const huge = outputSize(1920, 1080, 7680, 4320, 3)!;
  expect(huge.width * huge.height).toBeLessThanOrEqual(3840 * 2160);
  expect(neuralFits(3840, 2160)).toBe(false);
  expect(neuralFits(1920, 1080)).toBe(true);
  expect(neuralFits(9000, 100)).toBe(false);
});

test('automatic content selection requires confidence, consensus and a dwell time', () => {
  const selection = new ContentSelection();
  expect(selection.observe(0.95, 0)).toBe('general');
  expect(selection.observe(0.95, 5000)).toBe('general');
  expect(selection.observe(0.95, 10000)).toBe('animation');
  for (const now of [15000, 20000, 25000]) expect(selection.observe(0.05, now)).toBe('animation');
  expect(selection.observe(0.05, 30000)).toBe('general');
  for (const probability of [0.5, NaN, Infinity, 1.5]) expect(selection.observe(probability, 60000)).toBe('general');
});

test('sporadic slow frames do not disable enhancement but sustained overload does', () => {
  const budget = new RenderBudget();
  for (let i = 0; i < 44; i++) expect(budget.observe(i === 0 ? 500 : 4, 16.67)).toBe(false);
  expect(budget.observe(4, 16.67)).toBe(false);
  for (let i = 0; i < 44; i++) expect(budget.observe(25, 16.67)).toBe(false);
  expect(budget.observe(25, 16.67)).toBe(true);
});
