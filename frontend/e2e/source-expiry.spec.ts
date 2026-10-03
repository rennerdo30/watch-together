import { test, expect } from '@playwright/test';

import { stubAdaptiveStream } from './adaptive-fixture';

/**
 * Signed stream URLs expire; past the `expire` in them the CDN answers 403
 * to everything. The player then asks the room page to re-resolve, which
 * refreshes the server's resolve — but the manifest's *address* is the same,
 * so the player used to keep the dead manifest loaded and swallow every
 * later 403: the video just stopped. It has to load the manifest again.
 */

const ORIGINAL_URL = 'https://youtu.be/source-expiry-fixture';
// The fixture's init segments and indexes live in its first kilobytes;
// anything past this is a media segment.
const FIRST_MEDIA_BYTE = 2000;

test('a source the CDN stops serving is re-resolved and loaded again', async ({ page }) => {
  const manifests = await stubAdaptiveStream(page, ORIGINAL_URL);
  let refreshed = false;
  let refused = 0;
  await page.route('**/api/resolve**', (route) => {
    if (new URL(route.request().url()).searchParams.get('refresh') === 'true') refreshed = true;
    return route.fallback();
  });
  await page.route('**/api/proxy**', (route) => {
    const range = /^bytes=(\d+)-/.exec(route.request().headers().range ?? '');
    if (!refreshed && range && Number(range[1]) >= FIRST_MEDIA_BYTE) {
      refused += 1;
      return route.fulfill({ status: 403, body: 'expired' });
    }
    return route.fallback();
  });

  await page.goto(`/room/e2e-source-expiry-${Date.now().toString(36)}?user=expiry@example.com`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  await page.getByPlaceholder('Paste video URL...').fill(ORIGINAL_URL);
  await page.getByPlaceholder('Paste video URL...').press('Enter');

  await expect.poll(() => refreshed, { timeout: 30_000 }).toBe(true);
  expect(refused).toBeGreaterThan(0);
  const media = page.locator('video[data-stream-type="mse"]');
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(2);
  expect(manifests.length, 'the manifest was loaded again after the refresh').toBeGreaterThanOrEqual(2);
});

test('a manual quality survives the video being loaded again for fresh links', async ({ page }) => {
  // Reloading the same video for fresh signed links reset every per-video
  // setting — including the viewer's quality pick, which quietly went back
  // to Auto (reported as 1080p "switching back to auto").
  const { rungUrl, rungOfRequest } = await import('./adaptive-fixture');
  const ladder = [
    { id: 'v-360', height: 360, tbr: 100, url: rungUrl('v-360') },
    { id: 'v-720', height: 720, tbr: 200, url: rungUrl('v-720') },
    { id: 'v-1080', height: 1080, tbr: 300, url: rungUrl('v-1080') },
  ];
  await stubAdaptiveStream(page, ORIGINAL_URL, ladder);
  let expired = false;
  let refreshed = false;
  const afterReload: string[] = [];
  await page.route('**/api/resolve**', (route) => {
    if (new URL(route.request().url()).searchParams.get('refresh') === 'true') refreshed = true;
    return route.fallback();
  });
  await page.route('**/api/proxy**', (route) => {
    const range = /^bytes=(\d+)-/.exec(route.request().headers().range ?? '');
    const media = range && Number(range[1]) >= FIRST_MEDIA_BYTE;
    if (expired && !refreshed && media) return route.fulfill({ status: 403, body: 'expired' });
    if (refreshed && media) afterReload.push(rungOfRequest(route.request().url()) ?? '?');
    return route.fallback();
  });

  await page.goto(`/room/e2e-quality-expiry-${Date.now().toString(36)}?user=expiry@example.com`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  await page.getByPlaceholder('Paste video URL...').fill(ORIGINAL_URL);
  await page.getByPlaceholder('Paste video URL...').press('Enter');
  const media = page.locator('video[data-stream-type="mse"]');
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);

  await page.getByRole('button', { name: 'Quality and sync settings' }).click();
  await page.getByRole('button', { name: /720p/ }).click();
  await expect(page.getByRole('button', { name: /720p/ })).toHaveAttribute('aria-pressed', 'true');

  // The links expire: the next media request is refused and the same video
  // is loaded again from a fresh resolve.
  expired = true;
  await media.evaluate((v: HTMLVideoElement) => { v.currentTime = 4.5; });
  await expect.poll(() => refreshed, { timeout: 30_000 }).toBe(true);
  await expect.poll(() => afterReload.length, { timeout: 20_000 }).toBeGreaterThan(0);

  if (!(await page.getByRole('button', { name: 'Auto', exact: true }).isVisible())) {
    await page.getByRole('button', { name: 'Quality and sync settings' }).click();
  }
  await expect(page.getByRole('button', { name: /720p/ })).toHaveAttribute('aria-pressed', 'true');
  // Audio requests carry no rung; every video request after the reload is the pick.
  const videoRungs = afterReload.filter((rung) => rung !== '?');
  expect(videoRungs.length).toBeGreaterThan(0);
  expect(videoRungs.every((rung) => rung === 'v-720'), `after reload: ${videoRungs.join(',')}`).toBe(true);
});
