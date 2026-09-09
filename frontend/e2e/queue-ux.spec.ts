import { test, expect } from '@playwright/test';

import { stubAdaptiveStream } from './adaptive-fixture';

/**
 * Small things about the queue that were wrong in daily use: resolving a
 * link for the queue covered the video that was playing with a spinner,
 * and nobody could tell who had added what.
 */

const USER = 'queue-ux@example.com';
const PLAYING = 'https://youtu.be/queue-ux-playing';
const QUEUED = 'https://youtu.be/queue-ux-queued';

test('queueing a link does not cover the playing video, and rows say who added them', async ({ page }) => {
  await stubAdaptiveStream(page, PLAYING);
  // Make the queue resolve slow enough to observe while the first video plays.
  await page.route('**/api/resolve**', async (route) => {
    const url = new URL(route.request().url()).searchParams.get('url') ?? '';
    if (url === QUEUED) await new Promise((r) => setTimeout(r, 1500));
    await route.fallback();
  });
  await page.goto(`/room/e2e-queue-ux-${Date.now().toString(36)}?user=${encodeURIComponent(USER)}`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });

  const input = page.getByPlaceholder('Paste video URL...');
  await input.fill(PLAYING);
  await input.press('Enter');
  await expect(page.locator('video[data-stream-type="mse"]')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByText('Resolving...')).toHaveCount(0, { timeout: 15_000 });

  await input.fill(QUEUED);
  const queueButton = page.getByRole('button', { name: 'Queue', exact: true });
  await queueButton.click();
  // While the queue resolve runs: the button is busy, the player is not covered.
  await expect(queueButton).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByText('Resolving...')).toHaveCount(0);
  await expect(page.getByText(/added to queue/i)).toBeVisible({ timeout: 10_000 });

  // Both rows carry the adder; the header names who added the playing video.
  const rows = page.getByRole('link', { name: /open adaptive fixture on youtu\.be/i });
  await expect(rows).toHaveCount(3); // header + two queue rows
  await expect(page.locator('header').getByText(/added by/i)).toContainText('queue-ux');
  await expect(page.getByTitle(`Added by ${USER}`)).toHaveCount(3);
});
