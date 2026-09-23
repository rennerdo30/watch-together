import { test, expect } from '@playwright/test';

import { stubAdaptiveStream } from './adaptive-fixture';

/**
 * A fresh HTMLVideoElement starts at volume=1 and muted=false; persisted
 * preferences update React state after hydration, but the old mount-only
 * synchronization effect had already copied the initial defaults into the
 * element. The slider then showed 25% while the next video actually played
 * at 100%.
 *
 * Adaptive videos now share one element (the player is kept across videos),
 * which is asserted below; the volume must survive either way, and a reload
 * still builds a new element.
 */

const USER = 'volume@example.com';
const FIRST = 'https://youtu.be/volume-first';
const SECOND = 'https://youtu.be/volume-second';

function uniqueRoomId(label: string): string {
  return `e2e-${label}-${Date.now().toString(36)}`;
}

async function openRoom(page: import('@playwright/test').Page, label: string) {
  await stubAdaptiveStream(page, FIRST);
  await page.goto(`/room/${uniqueRoomId(label)}?user=${encodeURIComponent(USER)}`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
}

async function playUrl(page: import('@playwright/test').Page, url: string) {
  const input = page.getByPlaceholder('Paste video URL...');
  await input.fill(url);
  await input.press('Enter');
  const media = page.locator('video[data-stream-type="mse"]');
  await expect(media).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.readyState),
    { timeout: 20_000 }).toBeGreaterThan(0);
  // Metadata can arrive before the asynchronous autoplay attempt. Pause only
  // after it starts, so this test exercises a paused remount rather than load.
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => !v.paused)).toBe(true);
  return media;
}

async function setVolume(page: import('@playwright/test').Page, value: number) {
  const slider = page.getByLabel('Volume');
  await expect(slider).toBeAttached();
  // The slider expands when its volume-control group is hovered.
  await page.getByLabel(/^(Mute|Unmute)$/).hover();
  await expect(slider).toBeVisible();
  await slider.fill(String(value));
  await expect(slider).toHaveValue(String(value));
}

test('the next video keeps the volume displayed by the slider, on the same element',
  async ({ page }) => {
    await openRoom(page, 'queue');
    const firstMedia = await playUrl(page, FIRST);
    await firstMedia.evaluate((video: HTMLVideoElement) => video.pause());

    await setVolume(page, 0.25);
    await expect.poll(() => firstMedia.evaluate((v: HTMLVideoElement) => v.volume))
      .toBe(0.25);
    expect(await page.evaluate(() => localStorage.getItem('w2g-player-volume')))
      .toBe('0.25');

    // Mark the physical element: the next adaptive video is loaded into it
    // rather than into a new one.
    await firstMedia.evaluate((video: HTMLVideoElement) => {
      video.dataset.volumeTestInstance = 'first';
    });

    const nextMedia = await playUrl(page, SECOND);
    expect(await nextMedia.evaluate(
      (v: HTMLVideoElement) => v.dataset.volumeTestInstance ?? 'new')).toBe('first');
    await expect(page.locator('header').getByRole('link', { name: /open adaptive fixture/i }))
      .toHaveAttribute('href', SECOND);

    const slider = page.getByLabel('Volume');
    await expect(slider).toHaveValue('0.25');
    expect(await page.evaluate(() => localStorage.getItem('w2g-player-volume')))
      .toBe('0.25');
    await expect.poll(() => nextMedia.evaluate((v: HTMLVideoElement) => v.volume))
      .toBe(0.25);
  });

test('a paused player remount applies the persisted muted state', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('w2g-player-muted', 'true');
  });
  await openRoom(page, 'muted');
  const media = await playUrl(page, FIRST);
  await media.evaluate((video: HTMLVideoElement) => video.pause());
  await expect(page.getByText('Paused', { exact: true }).first()).toBeVisible();

  // Reconnect to the same paused room. autoPlay is false, so HLS/Shaka's
  // autoplay-only mute restoration cannot hide a broken CustomPlayer effect.
  await page.reload();
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  const replacement = page.locator('video[data-stream-type="mse"]');
  await expect(replacement).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(() => replacement.evaluate((v: HTMLVideoElement) => v.muted))
    .toBe(true);
  await expect(page.getByLabel('Unmute')).toBeVisible();
});
