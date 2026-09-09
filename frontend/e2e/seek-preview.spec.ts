import { test, expect } from '@playwright/test';

import { storyboardFrame, type Storyboard } from '../lib/storyboard';
import { stubAdaptiveStream } from './adaptive-fixture';

/**
 * Hovering the seek bar shows the time under the pointer and, when the
 * site provides a storyboard, the frame that stands for it.
 */

const USER = 'preview@example.com';
const ORIGINAL_URL = 'https://youtu.be/preview-fixture';

const BOARD: Storyboard = {
  width: 160, height: 90, rows: 2, columns: 3, frame_duration: 1,
  sheets: ['https://i.ytimg.test/sb/M0.jpg', 'https://i.ytimg.test/sb/M1.jpg'],
};

test('a time maps to the right frame of the right sheet', () => {
  expect(storyboardFrame(BOARD, 0)).toEqual({ url: BOARD.sheets[0], x: 0, y: 0, width: 160, height: 90 });
  expect(storyboardFrame(BOARD, 4.9)).toEqual({ url: BOARD.sheets[0], x: 160, y: 90, width: 160, height: 90 });
  expect(storyboardFrame(BOARD, 7)).toEqual({ url: BOARD.sheets[1], x: 160, y: 0, width: 160, height: 90 });
  // Past the last sheet: clamped into it rather than pointing at nothing.
  expect(storyboardFrame(BOARD, 500)).toEqual({ url: BOARD.sheets[1], x: 320, y: 90, width: 160, height: 90 });
  expect(storyboardFrame({ ...BOARD, sheets: [] }, 1)).toBeNull();
  expect(storyboardFrame({ ...BOARD, frame_duration: 0 }, 1)).toBeNull();
  expect(storyboardFrame(BOARD, NaN)).toBeNull();
});

test('hovering the seek bar shows the storyboard frame and the time', async ({ page }) => {
  await stubAdaptiveStream(page, ORIGINAL_URL, undefined, { storyboard: BOARD });
  await page.goto(`/room/e2e-preview-${Date.now().toString(36)}?user=${encodeURIComponent(USER)}`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  await page.getByPlaceholder('Paste video URL...').fill(ORIGINAL_URL);
  await page.getByPlaceholder('Paste video URL...').press('Enter');
  const media = page.locator('video[data-stream-type="mse"]');
  await expect(media).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.duration), { timeout: 15_000 }).toBeGreaterThan(5);
  await media.evaluate((v: HTMLVideoElement) => v.pause());

  const seek = page.getByLabel('Seek');
  const box = await seek.boundingBox();
  if (!box) throw new Error('no seek bar');
  // Half way along a 6 s clip: 3 s, frame 3 of sheet 0 -> second row, first column.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const preview = page.getByTestId('seek-preview');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('0:03');
  const frame = page.getByTestId('seek-preview-frame');
  await expect(frame).toHaveCSS('background-image', /M0\.jpg/);
  await expect(frame).toHaveCSS('background-position', '0px -90px');

  await page.mouse.move(box.x - 50, box.y - 200);
  await expect(preview).toHaveCount(0);
});
