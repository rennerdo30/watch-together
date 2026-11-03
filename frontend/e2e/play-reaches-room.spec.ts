import { test, expect, type WebSocketRoute } from '@playwright/test';
import { stubAdaptiveStream } from './adaptive-fixture';

/**
 * A viewer's play reaches the room however busy the room is.
 *
 * The room page ignored the player's `play` for 300 ms after any message
 * from the server — chat, presence, another viewer's report — to filter out
 * plays the room itself had commanded. In a busy room a viewer's click
 * played locally and was never sent: the room stayed paused, the badge said
 * "Paused" while the clock ran.
 */

const VIDEO = 'https://youtu.be/play-reaches-room';

test('a click on play right after a room message is still published', async ({ page }) => {
  await stubAdaptiveStream(page, VIDEO);
  const sent: { type?: string }[] = [];
  let toPage: WebSocketRoute | null = null;
  await page.routeWebSocket(/\/ws\/e2e-play-/, (ws) => {
    const server = ws.connectToServer();
    toPage = ws;
    ws.onMessage((message) => {
      try { sent.push(JSON.parse(String(message))); } catch { /* not JSON */ }
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });

  await page.goto(`/room/e2e-play-${Date.now().toString(36)}?user=player@example.com`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible();
  await page.getByPlaceholder('Paste video URL...').fill(VIDEO);
  await page.getByPlaceholder('Paste video URL...').press('Enter');
  const video = page.locator('video[data-stream-type="mse"]');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);

  // The room pauses (as when another viewer pauses it).
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect.poll(() => sent.some(m => m.type === 'pause')).toBe(true);
  await expect(page.getByText('Paused', { exact: true })).toBeVisible();
  await page.waitForTimeout(500);

  // Any room message, then the viewer's click inside the old 300 ms window.
  sent.length = 0;
  toPage!.send(JSON.stringify({ type: 'pong', payload: {} }));
  await page.getByRole('button', { name: 'Play', exact: true }).first().click();

  await expect.poll(() => sent.some(m => m.type === 'play')).toBe(true);
  await expect(page.getByText('Playing', { exact: true })).toBeVisible();
});

test('a play the room commands is not sent back to it', async ({ page }) => {
  await stubAdaptiveStream(page, VIDEO);
  const sent: { type?: string }[] = [];
  let toPage: WebSocketRoute | null = null;
  await page.routeWebSocket(/\/ws\/e2e-play-/, (ws) => {
    const server = ws.connectToServer();
    toPage = ws;
    ws.onMessage((message) => {
      try { sent.push(JSON.parse(String(message))); } catch { /* not JSON */ }
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });
  await page.goto(`/room/e2e-play-${Date.now().toString(36)}?user=player@example.com`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible();
  await page.getByPlaceholder('Paste video URL...').fill(VIDEO);
  await page.getByPlaceholder('Paste video URL...').press('Enter');
  const video = page.locator('video[data-stream-type="mse"]');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await page.waitForTimeout(500);

  // Another viewer pressed play: the server tells this page.
  sent.length = 0;
  toPage!.send(JSON.stringify({ type: 'play', payload: { timestamp: 1 } }));
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
  await page.waitForTimeout(800);
  expect(sent.filter(m => m.type === 'play')).toEqual([]);
});
