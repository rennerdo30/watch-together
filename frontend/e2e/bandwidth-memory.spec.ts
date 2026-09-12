import { test, expect } from '@playwright/test';

import { BANDWIDTH_MEMORY_KEY, openingEstimate, parseStoredEstimate } from '../lib/bandwidth-memory';
import {
  BANDWIDTH_MEMORY_DISCOUNT,
  BANDWIDTH_MEMORY_MAX_AGE_MS,
  SHAKA_INITIAL_BANDWIDTH_ESTIMATE,
  SHAKA_MAX_REMEMBERED_BANDWIDTH,
} from '../lib/constants';
import { stubAdaptiveStream, type VideoRung } from './adaptive-fixture';

/**
 * Auto quality opens on what the connection managed last time.
 *
 * Every load used to start from the same cautious guess, so a viewer whose
 * connection carried 1080p yesterday still sat through the low rungs at the
 * start of every video while the estimate climbed. The measured estimate is
 * now kept in the browser and used as the opening guess.
 */

const USER = 'bandwidth-memory@example.com';
const ORIGINAL_URL = 'https://youtu.be/bandwidth-memory-fixture';
// The high rung is well beyond the fixed opening guess (700 kbit/s) and well
// within a remembered 8 Mbit/s.
const LADDER: VideoRung[] = [
  { id: 'v-low', height: 240, tbr: 100 },
  { id: 'v-high', height: 1080, tbr: 3000 },
];
const NOW = 1_700_000_000_000;

test('the remembered estimate is discounted, bounded, and forgotten when stale', () => {
  const day = BANDWIDTH_MEMORY_MAX_AGE_MS;
  expect(parseStoredEstimate(null, NOW)).toBeNull();
  expect(parseStoredEstimate('junk', NOW)).toBeNull();
  expect(parseStoredEstimate(JSON.stringify({ bps: 'x', at: NOW }), NOW)).toBeNull();
  expect(parseStoredEstimate(JSON.stringify({ bps: 5e6, at: NOW - day - 1 }), NOW)).toBeNull();
  expect(parseStoredEstimate(JSON.stringify({ bps: 5e6, at: NOW + 1000 }), NOW)).toBeNull();
  expect(parseStoredEstimate(JSON.stringify({ bps: 5e6, at: NOW - 1000 }), NOW)).toEqual({ bps: 5e6, at: NOW - 1000 });

  expect(openingEstimate(null)).toBe(SHAKA_INITIAL_BANDWIDTH_ESTIMATE);
  expect(openingEstimate({ bps: 10e6, at: NOW })).toBe(10e6 * BANDWIDTH_MEMORY_DISCOUNT);
  // A measured slow connection must constrain startup; a wild estimate is capped.
  expect(openingEstimate({ bps: 100_000, at: NOW })).toBe(80_000);
  expect(openingEstimate({ bps: 1e9, at: NOW })).toBe(SHAKA_MAX_REMEMBERED_BANDWIDTH);
});

async function openWithMemory(page: import('@playwright/test').Page, stored: unknown, label: string) {
  await page.addInitScript(({ key, value }) => {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  }, { key: BANDWIDTH_MEMORY_KEY, value: stored === null ? null : JSON.stringify(stored) });
  await stubAdaptiveStream(page, ORIGINAL_URL, LADDER);
  await page.goto(`/room/e2e-${label}-${Date.now().toString(36)}?user=${encodeURIComponent(USER)}`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  await page.getByPlaceholder('Paste video URL...').fill(ORIGINAL_URL);
  await page.getByPlaceholder('Paste video URL...').press('Enter');
  const media = page.locator('video[data-stream-type="mse"]');
  await expect(media).toHaveCount(1, { timeout: 15_000 });
  await expect
    .poll(() => media.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 20_000 })
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Playback statistics' }).click();
  return page.getByText('Quality', { exact: true }).locator('..');
}

test('a connection that managed 1080p yesterday opens on 1080p today', async ({ page }) => {
  const quality = await openWithMemory(page, { bps: 8_000_000, at: Date.now() - 60_000 }, 'bw-remembered');
  await expect(quality).toContainText('auto (1080p)');
});

test('with nothing remembered the cautious opening rung still applies', async ({ page }) => {
  const quality = await openWithMemory(page, null, 'bw-fresh');
  await expect(quality).toContainText('auto (240p)');
});

test('short playback without enough measured bytes does not overwrite memory with the opening guess', async ({ page }) => {
  const stored = { bps: 8_000_000, at: Date.now() - 60_000 };
  await openWithMemory(page, stored, 'bw-no-measurement');
  // The complete A/V fixture is smaller than Shaka's 128k measurement minimum.
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(2.5);
  const actual = await page.evaluate(key => localStorage.getItem(key), BANDWIDTH_MEMORY_KEY);
  expect(JSON.parse(actual!)).toEqual(stored);
});
