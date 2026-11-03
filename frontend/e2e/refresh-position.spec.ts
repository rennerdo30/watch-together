import { test, expect, type Page } from '@playwright/test';
import { stubAdaptiveStream } from './adaptive-fixture';

/**
 * A refresh must never move the room.
 *
 * A reloaded player starts the video at the room's position, and the engine
 * moving the element there fires `seeked` like a viewer's seek. Reported as
 * one, it sent the whole room to that position, which is seconds stale by
 * the time the manifest and first segments are in.
 */

const VIDEO = 'https://youtu.be/refresh-position';

function seeksSent(page: Page): { timestamp: number }[] {
  const sent: { timestamp: number }[] = [];
  page.on('websocket', (socket) => {
    socket.on('framesent', ({ payload }) => {
      try {
        const message = JSON.parse(String(payload));
        if (message?.type === 'seek') sent.push(message.payload ?? message);
      } catch { /* not JSON */ }
    });
  });
  return sent;
}

test('reloading the page starts where the room is without seeking it', async ({ page }) => {
  await stubAdaptiveStream(page, VIDEO);
  const roomId = `e2e-refresh-${Date.now().toString(36)}`;
  await page.goto(`/room/${roomId}?user=refresher@example.com`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible();
  await page.getByPlaceholder('Paste video URL...').fill(VIDEO);
  await page.getByPlaceholder('Paste video URL...').press('Enter');
  const video = page.locator('video[data-stream-type="mse"]');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);

  // The room paused part way in: a position the reload has to start at.
  await video.evaluate(async (v: HTMLVideoElement) => {
    v.pause();
    v.currentTime = Math.min(4, v.duration / 2);
    await new Promise(resolve => v.addEventListener('seeked', resolve, { once: true }));
  });
  const roomPosition = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
  expect(roomPosition).toBeGreaterThan(1);
  await page.waitForTimeout(500); // Let the room take the seek.

  const sent = seeksSent(page);
  await page.reload();
  await expect(page.getByLabel('Connected to the room')).toBeVisible();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(roomPosition - 1);
  await page.waitForTimeout(1500);
  expect(sent).toEqual([]);
});
