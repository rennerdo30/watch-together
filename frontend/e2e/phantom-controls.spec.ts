import { test, expect } from '@playwright/test';
import { stubAdaptiveStream } from './adaptive-fixture';

/**
 * "Phantom controls": the control bar fades after three idle seconds, and a
 * click on where a control was fell through to the video's click-to-pause —
 * the pointer movement that brings the bar back and the click arrive
 * together, before React has re-rendered the overlay. The viewer reaching
 * for Settings paused the whole room.
 */

const ORIGINAL_URL = 'https://youtu.be/phantom-fixture';
const HIDE_DELAY_MS = 3000;

async function playingFixture(page: import('@playwright/test').Page) {
  const pauseFrames: string[] = [];
  page.on('websocket', (ws) => ws.on('framesent', (frame) => {
    const text = String(frame.payload);
    if (text.includes('"type":"pause"')) pauseFrames.push(text);
  }));
  await stubAdaptiveStream(page, ORIGINAL_URL);
  await page.goto(`/room/e2e-phantom-${Date.now().toString(36)}?user=phantom@example.com`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  await page.getByPlaceholder('Paste video URL...').fill(ORIGINAL_URL);
  await page.getByPlaceholder('Paste video URL...').press('Enter');
  const media = page.locator('video[data-stream-type="mse"]');
  await expect(media).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(
    () => media.evaluate((v: HTMLVideoElement) => !v.paused && v.readyState >= 2),
    { timeout: 15_000 },
  ).toBe(true);
  return { media, pauseFrames };
}

test('a click on a faded control reveals the controls instead of pausing the room', async ({ page }) => {
  const { media, pauseFrames } = await playingFixture(page);
  const settings = page.getByRole('button', { name: 'Quality and sync settings' });
  const bar = page.getByTestId('control-bar');

  // Wake the controls, note where Settings is, then rest the pointer away
  // from the bar until the controls fade.
  await page.mouse.move(300, 120);
  await expect(bar).toHaveCSS('pointer-events', 'auto');
  const box = await settings.boundingBox();
  if (!box) throw new Error('no settings button');
  await page.waitForTimeout(HIDE_DELAY_MS + 600);
  await expect(bar).toHaveCSS('pointer-events', 'none');

  // Reach for Settings: the move and the click arrive together.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(400);
  expect(await media.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
  expect(pauseFrames).toHaveLength(0);
  await expect(bar).toHaveCSS('pointer-events', 'auto');

  // With the controls up, the same click opens Settings — and still pauses nothing.
  await page.waitForTimeout(600);
  await settings.click();
  await expect(page.getByLabel('Quality and sync settings').last()).toBeVisible();
  expect(pauseFrames).toHaveLength(0);
});

test('the controls do not fade while the pointer rests on them', async ({ page }) => {
  await playingFixture(page);
  const bar = page.getByTestId('control-bar');
  const settings = page.getByRole('button', { name: 'Quality and sync settings' });
  await settings.hover();
  await page.waitForTimeout(HIDE_DELAY_MS + 800);
  await expect(bar).toHaveCSS('pointer-events', 'auto');
});
