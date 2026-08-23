import { test, expect } from '@playwright/test';

import { stubAdaptiveStream } from './adaptive-fixture';

/**
 * Regression tests for the playback engine being torn down by state it
 * should only read once.
 *
 * The MSE effect was keyed on `autoPlay` and `initialTime`. Both follow
 * the room: `autoPlay` mirrors play/pause, and `initialTime` is rewritten
 * by every seek and every server heartbeat. So the player was destroyed
 * and the manifest reloaded on each of those — which rebuffered from
 * zero, and worse, detaching the media element fired a `pause` event that
 * the room broadcast as a real pause, while the reload that followed
 * autoplayed and broadcast a real `play`. A paused room resumed itself,
 * and playback never settled.
 */

const USER = 'stability@example.com';
const ORIGINAL_URL = 'https://youtu.be/stability-fixture';

/** Long enough for a reload to be requested, fetched and counted. */
const SETTLE_MS = 3_000;
/** Heartbeats arrive every 5s; two of them is enough to see a reload loop. */
const OBSERVATION_MS = 12_000;

function uniqueRoomId(label: string): string {
  return `e2e-${label}-${Date.now().toString(36)}`;
}

async function openRoomWithVideo(page: import('@playwright/test').Page, label: string) {
  const manifestRequests = await stubAdaptiveStream(page, ORIGINAL_URL);

  await page.goto(`/room/${uniqueRoomId(label)}?user=${encodeURIComponent(USER)}`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });

  await page.getByPlaceholder('Paste video URL...').fill(ORIGINAL_URL);
  await page.getByPlaceholder('Paste video URL...').press('Enter');

  const media = page.locator('video[data-stream-type="mse"]');
  await expect(media).toHaveCount(1, { timeout: 15_000 });
  await expect
    .poll(() => media.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 20_000 })
    .toBeGreaterThan(0);

  // The count once the stream is up is the baseline. It is not asserted to
  // be exactly one: the dev server mounts effects twice on purpose. What
  // matters is that it stops growing.
  await page.waitForTimeout(SETTLE_MS);
  return { media, manifestRequests, settled: manifestRequests.length };
}

test('pausing and resuming does not rebuild the player', async ({ page }) => {
  const { media, manifestRequests, settled } = await openRoomWithVideo(page, 'toggle');

  // Each toggle flips the room's play state, which used to be a dependency
  // of the engine's setup effect.
  for (const action of ['pause', 'play', 'pause'] as const) {
    await media.evaluate((v: HTMLVideoElement, a) => {
      if (a === 'pause') v.pause();
      else void v.play().catch(() => undefined);
    }, action);
    await page.waitForTimeout(SETTLE_MS);
  }

  expect(manifestRequests.length).toBe(settled);
});

test('a paused video stays paused', async ({ page }) => {
  const { media, manifestRequests, settled } = await openRoomWithVideo(page, 'paused');

  await media.evaluate((v: HTMLVideoElement) => v.pause());
  await expect(page.getByText('Paused', { exact: true }).first()).toBeVisible();

  await page.waitForTimeout(OBSERVATION_MS);

  // Nothing in the sync path may resume it, and nothing may reload the
  // stream behind it — a reload is what used to resume it.
  expect(await media.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await expect(page.getByText('Paused', { exact: true }).first()).toBeVisible();
  expect(manifestRequests.length).toBe(settled);
});
