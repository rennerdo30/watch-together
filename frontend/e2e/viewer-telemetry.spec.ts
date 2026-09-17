import { test, expect } from '@playwright/test';

import { stubAdaptiveStream, type VideoRung } from './adaptive-fixture';

/**
 * "It is always blurry for me" used to be unanswerable.
 *
 * Auto quality is decided in the browser from inputs that exist only there —
 * the size the video is drawn at, the pixel ratio, the measured bandwidth,
 * the frames the decoder dropped — and none of it reached anyone who could
 * look. The player now reports what it can see over the room socket, and the
 * admin panel shows it beside the viewer, together with the segments the
 * proxy actually served them.
 */

const ORIGINAL_URL = 'https://youtu.be/telemetry-fixture';
const VIEWER = 'blurry-viewer@example.com';
const LADDER: VideoRung[] = [
  { id: 'v-720', height: 720, tbr: 100 },
  { id: 'v-1080', height: 1080, tbr: 200 },
  { id: 'v-2160', height: 2160, tbr: 300 },
];

test('an admin can see which rung each viewer is on, and why', async ({ browser }) => {
  const roomId = `e2e-telemetry-${Date.now().toString(36)}`;
  const viewerCtx = await browser.newContext();
  const adminCtx = await browser.newContext();
  const viewer = await viewerCtx.newPage();
  const admin = await adminCtx.newPage();

  await stubAdaptiveStream(viewer, ORIGINAL_URL, LADDER);
  await viewer.goto(`/room/${roomId}?user=${encodeURIComponent(VIEWER)}`);
  await expect(viewer.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  await viewer.getByPlaceholder('Paste video URL...').fill(ORIGINAL_URL);
  await viewer.getByPlaceholder('Paste video URL...').press('Enter');
  const media = viewer.locator('video[data-stream-type="mse"]');
  await expect(media).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.readyState >= 2),
    { timeout: 20_000 }).toBe(true);

  await admin.goto('/admin?user=admin@example.com');
  const row = admin.getByRole('row', { name: new RegExp(roomId) });
  await expect(row).toBeVisible({ timeout: 15_000 });

  // The rung the viewer is on, and the cap that is keeping them there —
  // which is the distinction between "their line is slow" and "their player
  // is small" that nothing could make before.
  await expect.poll(async () => {
    await admin.reload();
    await expect(admin.getByRole('heading', { name: 'Rooms' })).toBeVisible({ timeout: 15_000 });
    const line = admin.getByRole('row', { name: new RegExp(roomId) });
    return (await line.textContent()) ?? '';
  }, { timeout: 30_000 }).toMatch(/blurry-viewer: \d+p \/ cap 1080p/);

  // And the inputs behind it, on the same line.
  const detail = await admin.getByTitle(/mode balanced \(mse\)/).getAttribute('title');
  expect(detail).toMatch(/surface \d+px @\d/);
  expect(detail).toMatch(/rungs offered/);

  await viewerCtx.close();
  await adminCtx.close();
});

test('the transfers table says who was served, by which tier, and how fast',
  async ({ page }) => {
    // The panel's own data, not the proxy's: this fixture's segments are
    // answered inside the browser (see adaptive-fixture), so no sample would
    // ever reach the backend here. That the proxy records a sample for every
    // tier is pinned in backend/tests/test_viewer_telemetry.py; what is left
    // to check is that the panel stops throwing those samples away.
    await page.route('**/api/admin/cache**', async (route) => {
      await route.fulfill({
        json: {
          segments: {
            entries_total: 0, bytes_total: 0, budget_bytes: 1024,
            oldest_age_seconds: null, disk_free_bytes: null, entries: [],
          },
          memory: {
            items: 0, size_mb: 0, max_mb: 256, audio_items: 0,
            hits: 3, misses: 1, hit_rate_percent: 75,
          },
          formats: [],
          proxy: {
            uptime_seconds: 10,
            totals: { requests: 2, bytes_sent: 1_500_000 },
            by_outcome: { ok: 2 },
            by_host: { 'rr1.googlevideo.com': { requests: 2, bytes_sent: 1_500_000 } },
            by_cache_tier: {
              upstream: { requests: 1, bytes_sent: 1_000_000 },
              memory: { requests: 1, bytes_sent: 500_000 },
            },
            recent_failures: [],
            recent_samples: [
              {
                at: Date.now() / 1000, host: 'rr1.googlevideo.com', status: 206,
                outcome: 'ok', upstream_ms: 40, transfer_ms: 500, bytes_sent: 1_000_000,
                range_start: 0, expected_bytes: 1_000_000, error: null,
                cache_tier: 'upstream', mbps: 16, identity: 'blurry-viewer@example.com',
              },
              {
                at: Date.now() / 1000, host: 'rr1.googlevideo.com', status: 206,
                outcome: 'ok', upstream_ms: 0, transfer_ms: 1, bytes_sent: 500_000,
                range_start: 0, expected_bytes: 500_000, error: null,
                cache_tier: 'memory', mbps: null, identity: 'other-viewer@example.com',
              },
            ],
          },
        },
      });
    });

    await page.goto('/admin?user=admin@example.com');
    await expect(page.getByRole('heading', { name: 'Proxy transfers' })).toBeVisible({ timeout: 15_000 });

    const row = page.getByRole('row', { name: /blurry-viewer/ });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText('upstream');
    await expect(row).toContainText('16 Mbps');

    // A memory hit measures a copy inside the server, not a link, so it
    // reports no rate rather than an imaginary one.
    const cached = page.getByRole('row', { name: /other-viewer/ });
    await expect(cached).toContainText('memory');
    await expect(cached).toContainText('—');

    // And the tiers are summarised, so "served entirely from cache" is
    // visible at a glance — it used to be invisible entirely.
    await expect(page.getByText(/upstream: 1/)).toBeVisible();
    await expect(page.getByText(/memory: 1/)).toBeVisible();
  });
