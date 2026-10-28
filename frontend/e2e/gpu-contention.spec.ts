import { test, expect } from '@playwright/test';
import { GpuContention } from '../lib/gpu-contention';
import { stubAdaptiveStream } from './adaptive-fixture';
import { openPlayerSettings } from './player-settings';

/**
 * A game on another screen shares the GPU with local video processing. The
 * page cannot see the game; it sees its own work slow down well beyond its
 * idle cost, steps aside, and comes back when probes are normal again.
 */

test('sustained slowdown well beyond the idle cost is contention; noise and small costs are not', () => {
  const shared = new GpuContention(10);
  for (let i = 0; i < 100; i++) expect(shared.observe(i % 2 ? 9 : 13)).toBe(false);
  let steppedAside = false;
  for (let i = 0; i < 40 && !steppedAside; i++) steppedAside = shared.observe(30);
  expect(steppedAside).toBe(true);
  expect(shared.probe(30)).toBe(false);
  expect(shared.probe(11)).toBe(false);
  expect(shared.probe(11)).toBe(true);

  // 4x slower but only 3 ms more: too small to mean anything.
  const tiny = new GpuContention(1);
  for (let i = 0; i < 60; i++) expect(tiny.observe(4)).toBe(false);

  // Without a measured idle cost, the first frames are the baseline.
  const learned = new GpuContention();
  for (let i = 0; i < 30; i++) expect(learned.observe(8)).toBe(false);
  let busy = false;
  for (let i = 0; i < 40 && !busy; i++) busy = learned.observe(25);
  expect(busy).toBe(true);
});

test('motion smoothing steps aside for a busy GPU, says so, and resumes when it is free', async ({ page }) => {
  test.setTimeout(60_000);
  // A stand-in worker: idle cost 5 ms, then every frame takes 40 ms (a game
  // started), and probes come back normal after a while (the game ended).
  await page.route('**/framegen/v1/interpolation.worker.js', route => route.fulfill({
    contentType: 'text/javascript', body: `
      let frames = 0, probes = 0;
      onmessage = ({ data }) => {
        if (data.type === 'present') { postMessage({ type: 'presented', shown: false }); return; }
        if (data.type === 'clear') return;
        if (data.type === 'init') { postMessage({ id: data.id, size: { width: 320, height: 240 }, tunes: {}, baselineMs: 5 }); return; }
        if (data.type === 'frame') { data.frame.close(); frames++; postMessage({ id: data.id, count: 0, ms: frames > 4 ? 40 : 5 }); return; }
        if (data.type === 'probe') { probes++; postMessage({ id: data.id, ms: probes > 1 ? 5 : 40 }); return; }
        postMessage({ id: data.id });
      };` }));
  await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { value: navigator.gpu ?? {} }));
  await stubAdaptiveStream(page, 'https://youtu.be/gpu-contention');
  await page.goto(`/room/e2e-gpu-busy-${Date.now().toString(36)}?user=gpu@example.com`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  await page.getByPlaceholder('Paste video URL...').fill('https://youtu.be/gpu-contention');
  await page.getByPlaceholder('Paste video URL...').press('Enter');
  const video = page.locator('video[data-stream-type="mse"]');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
  await video.evaluate((v: HTMLVideoElement) => { v.muted = true; v.loop = true; v.pause(); });
  await openPlayerSettings(page, 'Picture');
  await page.getByLabel('Motion smoothing (beta)').selectOption('30');
  const status = page.getByRole('status', { name: 'Motion smoothing status' });
  await expect(status).toContainText('Ready', { timeout: 20_000 });
  await page.keyboard.press('Escape');
  await video.evaluate((v: HTMLVideoElement) => v.play());

  await expect(page.getByRole('status').filter({ hasText: 'Motion smoothing paused.' })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-frame-generation]')).toHaveAttribute('data-frame-generation', 'idle');
  // Two normal probes, three seconds apart: back in business.
  await expect.poll(() => page.locator('[data-frame-generation]').evaluate(() =>
    document.body.innerText.includes('GPU is busy with another app')), { timeout: 20_000 }).toBe(false);
});
