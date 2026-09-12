import { test, expect } from '@playwright/test';

import { stubAdaptiveStream } from './adaptive-fixture';

/**
 * SponsorBlock, end to end.
 *
 * The backend asks a stub (e2e/sponsorblock-stub.mjs, started by the
 * Playwright config) for the segments of the video the room plays, marks
 * them on every viewer's seek bar, and moves the whole room past the ones
 * the admin has chosen to skip. The stub's video has a sponsor segment at
 * 1-3s, which the room skips by default, and an intro at 4-5.5s, which it
 * does not.
 */

const ADMIN = 'sb-admin@example.com';
const VIEWER = 'sb-viewer@example.com';
// The id the stub answers for; see sponsorblock-stub.mjs.
const ORIGINAL_URL = 'https://www.youtube.com/watch?v=e2esponsor1';

function uniqueRoomId(label: string): string {
  return `e2e-${label}-${Date.now().toString(36)}`;
}

async function joinRoom(page: import('@playwright/test').Page, roomId: string, user: string) {
  await stubAdaptiveStream(page, ORIGINAL_URL);
  await page.goto(`/room/${roomId}?user=${encodeURIComponent(user)}`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
}

async function playVideo(page: import('@playwright/test').Page) {
  await page.getByPlaceholder('Paste video URL...').fill(ORIGINAL_URL);
  await page.getByPlaceholder('Paste video URL...').press('Enter');
  const media = page.locator('video[data-stream-type="mse"]');
  await expect(media).toHaveCount(1, { timeout: 15_000 });
  return media;
}

test('the room is moved past a sponsor segment, is told why, and sees every segment on the seek bar',
  async ({ page }) => {
    await joinRoom(page, uniqueRoomId('sb-skip'), ADMIN);
    // Keep observations outside the media element: completing the queue now
    // removes the player, so polling its final currentTime races that cleanup.
    await page.evaluate(() => {
      const state = window as unknown as { sponsorPositions: number[] };
      state.sponsorPositions = [];
      document.addEventListener('timeupdate', event => {
        if (event.target instanceof HTMLVideoElement) state.sponsorPositions.push(event.target.currentTime);
      }, true);
    });
    const media = await playVideo(page);
    const recordedPositions = () => page.evaluate(() =>
      (window as unknown as { sponsorPositions: number[] }).sponsorPositions);

    // Both segments are drawn, whether or not they are skipped.
    await expect(page.locator('[data-sponsor-segment="sponsor"]')).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator('[data-sponsor-segment="intro"]')).toHaveCount(1);

    // The server skips the sponsor at 1s: a notice explains the jump, and
    // the player is never seen inside the segment on its way past 3s.
    await expect(page.getByText(/skipped sponsor \(2s\)/i)).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(() => media.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(3);
    const positions = await recordedPositions();
    expect(positions.some((t) => t < 1.5)).toBe(true);
    expect(positions.filter((t) => t > 1.6 && t < 2.8)).toEqual([]);

    // The intro is not in the default selection, so it plays through.
    await expect
      .poll(async () => (await recordedPositions()).some(t => t >= 5.6), { timeout: 15_000 })
      .toBe(true);
    await expect(page.getByText(/skipped intermission/i)).toHaveCount(0);
  });

test('the admin controls the setting for the room and a viewer cannot', async ({ browser }) => {
  const roomId = uniqueRoomId('sb-settings');
  const adminPage = await browser.newPage();
  const viewerPage = await browser.newPage();
  await joinRoom(adminPage, roomId, ADMIN);
  await joinRoom(viewerPage, roomId, VIEWER);

  await adminPage.getByRole('button', { name: 'Room settings' }).click();
  const settings = adminPage.getByTestId('sponsorblock-settings');
  const toggle = settings.getByRole('switch', { name: /skip sponsorblock segments/i });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(settings.getByRole('checkbox', { name: 'Sponsor' })).toBeChecked();
  await expect(settings.getByRole('checkbox', { name: /endcards/i })).not.toBeChecked();

  // A category change is a room setting: the box only ticks once the
  // server has applied and broadcast it.
  await settings.getByRole('checkbox', { name: /endcards/i }).click();
  await expect(settings.getByRole('checkbox', { name: /endcards/i })).toBeChecked();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');

  // It survives leaving and rejoining, because the room remembers it.
  await adminPage.reload();
  await expect(adminPage.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  await adminPage.getByRole('button', { name: 'Room settings' }).click();
  await expect(adminPage.getByTestId('sponsorblock-settings').getByRole('switch'))
    .toHaveAttribute('aria-checked', 'false');
  await expect(adminPage.getByTestId('sponsorblock-settings').getByRole('checkbox', { name: /endcards/i }))
    .toBeChecked();

  // A viewer has no such control.
  await viewerPage.getByRole('button', { name: 'Room settings' }).click();
  await expect(viewerPage.getByRole('dialog')).toBeVisible();
  await expect(viewerPage.getByTestId('sponsorblock-settings')).toHaveCount(0);

  await adminPage.close();
  await viewerPage.close();
});

test('with skipping off the segment still shows but plays through', async ({ page }) => {
  await joinRoom(page, uniqueRoomId('sb-off'), ADMIN);
  await page.getByRole('button', { name: 'Room settings' }).click();
  const toggle = page.getByTestId('sponsorblock-settings').getByRole('switch');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('dialog').getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const media = await playVideo(page);
  await expect(page.locator('[data-sponsor-segment="sponsor"]')).toHaveCount(1, { timeout: 10_000 });
  await expect
    .poll(() => media.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 15_000 })
    .toBeGreaterThan(2);
  await expect(page.getByText(/skipped sponsor/i)).toHaveCount(0);
});
