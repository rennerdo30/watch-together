import { test, expect } from '@playwright/test';
import { autoQualityCap } from '../lib/abr';
import { stubAdaptiveStream, type VideoRung } from './adaptive-fixture';

/**
 * Auto quality is capped to the drawing surface plus one rung of bitrate
 * headroom. A fast link used to be handed 4K AV1 for a laptop-sized
 * player: 13–28 MB segments that each took seconds, so every seek stared
 * at a spinner until one had arrived. A 4K monitor with a large player
 * still gets 4K; a laptop gets the rung above what it can show, for the
 * bitrate — never two above.
 */

const ORIGINAL_URL = 'https://youtu.be/element-size-fixture';
// Every rung is cheap, so bandwidth alone would pick the top one. The
// player inside a 1280×720 viewport is covered by 720; one rung above is
// 1080; 2160 is the pick the cap must prevent.
const LADDER: VideoRung[] = [
  { id: 'v-covers', height: 720, tbr: 100 },
  { id: 'v-headroom', height: 1080, tbr: 200 },
  { id: 'v-4k', height: 2160, tbr: 300 },
];

test('the cap is the covering rung plus headroom, within the ladder', () => {
  const ladder = [360, 720, 1080, 1440, 2160];
  expect(autoQualityCap(ladder, 450, 1)).toBe(1080);   // laptop-sized player
  expect(autoQualityCap(ladder, 450, 0)).toBe(720);    // no headroom: what covers it
  expect(autoQualityCap(ladder, 1400, 1)).toBe(2160);  // large player on a 4K monitor
  expect(autoQualityCap(ladder, 2000, 1)).toBe(2160);  // headroom cannot exceed the ladder
  expect(autoQualityCap(ladder, 3000, 1)).toBe(2160);  // nothing covers it: the top rung
  expect(autoQualityCap([1080, 1080, 0, 720], 450, 1)).toBe(1080);
  expect(autoQualityCap([], 450, 1)).toBeNull();
});

test('auto quality stops one rung above the surface even when bandwidth allows more', async ({ page }) => {
  await stubAdaptiveStream(page, ORIGINAL_URL, LADDER);
  await page.goto(`/room/e2e-elsize-${Date.now().toString(36)}?user=elsize@example.com`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  await page.getByPlaceholder('Paste video URL...').fill(ORIGINAL_URL);
  await page.getByPlaceholder('Paste video URL...').press('Enter');
  const media = page.locator('video[data-stream-type="mse"]');
  await expect(media).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.readyState >= 2), { timeout: 15_000 }).toBe(true);

  // Let the ABR take a few measured samples and settle.
  await page.waitForTimeout(3_000);
  await page.mouse.move(300, 120);
  await page.getByRole('button', { name: /statistic/i }).click();
  // The toggle button carries the same label; the overlay is the div.
  const stats = page.locator('div[aria-label="Playback statistics"]');
  await expect(stats).toBeVisible();
  await expect(stats).toContainText(/auto \(1080p\)/, { timeout: 10_000 });
});
