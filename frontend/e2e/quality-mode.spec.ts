import { test, expect, type Page } from '@playwright/test';

import { BANDWIDTH_MEMORY_KEY } from '../lib/bandwidth-memory';
import { stubAdaptiveStream, type VideoRung } from './adaptive-fixture';

/**
 * Auto quality is capped to what the player can show, plus a rung. That cap
 * keeps seeks quick — a 4K rendition means 13-28 MB segments and a spinner
 * after every jump — but it is a trade, and a viewer watching in a small
 * window on a fast line had no way to take the other side of it. Now they
 * choose, per browser.
 *
 * Every rung here is cheap, so bandwidth alone would always take the top
 * one: what the player settles on is the cap talking, not the link.
 */

const ORIGINAL_URL = 'https://youtu.be/quality-mode-fixture';
const LADDER: VideoRung[] = [
  { id: 'v-720', height: 720, tbr: 100 },
  { id: 'v-1080', height: 1080, tbr: 200 },
  { id: 'v-2160', height: 2160, tbr: 300 },
];

async function openRoom(page: Page, label: string) {
  await stubAdaptiveStream(page, ORIGINAL_URL, LADDER);
  await page.goto(`/room/e2e-qmode-${label}-${Date.now().toString(36)}?user=qmode@example.com`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  await page.getByPlaceholder('Paste video URL...').fill(ORIGINAL_URL);
  await page.getByPlaceholder('Paste video URL...').press('Enter');
  const media = page.locator('video[data-stream-type="mse"]');
  await expect(media).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.readyState >= 2),
    { timeout: 20_000 }).toBe(true);
  return media;
}

const settingsButton = (page: Page) =>
  page.getByRole('button', { name: 'Quality and sync settings' });

/** The rung auto settled on, read from the Auto button in the panel. */
async function autoRung(page: Page): Promise<number> {
  const text = await page.getByTestId('auto-rung').textContent();
  return Number.parseInt(text ?? '', 10);
}

async function chooseMode(page: Page, mode: 'balanced' | 'highest' | 'saver') {
  await page.getByLabel('Auto quality').selectOption(mode);
  await expect(page.getByLabel('Auto quality')).toHaveValue(mode);
}

test('the mode decides how far above the player auto may go', async ({ page }) => {
  await openRoom(page, 'modes');
  await settingsButton(page).click();

  // Balanced: the covering rung plus one. The 1280x720 viewport's player is
  // covered by 720, so auto settles on 1080 and 2160 stays out of reach.
  await expect.poll(() => autoRung(page), { timeout: 15_000 }).toBe(1080);

  // Highest: the cap is lifted, not merely left unset — the restriction
  // Balanced applied a moment ago has to be cleared for this to move.
  await chooseMode(page, 'highest');
  await expect.poll(() => autoRung(page), { timeout: 15_000 }).toBe(2160);

  // Data saver: never sharper than the player can show.
  await chooseMode(page, 'saver');
  await expect.poll(() => autoRung(page), { timeout: 15_000 }).toBe(720);

  // And back, which is the regression the clearing above can hide: a mode
  // that lifts the cap must not leave the player uncapped afterwards.
  await chooseMode(page, 'balanced');
  await expect.poll(() => autoRung(page), { timeout: 15_000 }).toBe(1080);
});

test('the chosen mode is this browser\'s, and survives a reload', async ({ page }) => {
  await openRoom(page, 'persist');
  await settingsButton(page).click();
  await chooseMode(page, 'highest');
  expect(await page.evaluate(() => localStorage.getItem('w2g-player-quality-mode')))
    .toBe('highest');

  await page.reload();
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  const media = page.locator('video[data-stream-type="mse"]');
  await expect(media).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.readyState >= 2),
    { timeout: 20_000 }).toBe(true);
  await settingsButton(page).click();
  await expect(page.getByLabel('Auto quality')).toHaveValue('highest');
  await expect.poll(() => autoRung(page), { timeout: 15_000 }).toBe(2160);
});

test('the statistics say what limited the choice, and can forget a bad measurement',
  async ({ page }) => {
    // A measurement from an earlier session that no longer describes the
    // connection: until now it could only be cleared through devtools.
    await page.addInitScript(() => {
      localStorage.setItem('w2g-bandwidth-estimate',
        JSON.stringify({ bps: 150_000, at: Date.now() - 60_000 }));
    });
    await openRoom(page, 'stats');

    await page.mouse.move(300, 120);
    await page.getByRole('button', { name: /statistic/i }).click();
    const stats = page.locator('div[aria-label="Playback statistics"]');
    await expect(stats).toBeVisible();

    // The cap, with the surface it was computed from — the difference
    // between "my line is slow" and "my player is small".
    await expect(stats.getByTestId('stat-auto-cap')).toContainText(/1080p · \d+px/);
    await expect(stats).toContainText('Remembered');
    await expect(stats).toContainText('0.15 Mbps');

    // The estimate is a measurement, reported apart from the rendition's
    // declared bitrate. The single "Bandwidth" row used to show the bitrate,
    // so a viewer stuck on 360p read it as proof their connection was slow.
    // This fixture is six seconds long and never reaches the bytes Shaka
    // needs for a real estimate — which is exactly the state that must be
    // distinguishable rather than dressed up as a measurement. (The
    // estimator's own threshold is covered in auto-quality.spec.ts.)
    await expect(stats.getByTestId('stat-estimate')).toHaveText('measuring…');
    await expect(stats).toContainText(/Rendition\s*0\.\d+ Mbps/);

    await page.getByRole('button', { name: 'Forget remembered bandwidth' }).click();
    expect(await page.evaluate((key) => localStorage.getItem(key), BANDWIDTH_MEMORY_KEY)).toBeNull();
    await expect(stats).toContainText('nothing');
  });
