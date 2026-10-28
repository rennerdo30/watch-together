import { test, expect } from '@playwright/test';

/**
 * The front page keeps its height however many rooms there are.
 *
 * The room list sat in a column that grew with its content, so a few hundred
 * rooms made the page tens of thousands of pixels tall, and the create form,
 * centred in that column, ended up far below the fold.
 */

const ROOM_COUNT = 400;

test('a long room list scrolls in its panel and the create form stays in view', async ({ page }) => {
  const rooms = Array.from({ length: ROOM_COUNT }, (_, index) => ({
    id: `layout-${index}`, active_users: index % 3, current_video: `Video ${index}`, queue_size: 0,
  }));
  await page.route('**/api/rooms', (route) => route.fulfill({ json: rooms }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('link', { name: /layout-399/ })).toBeAttached();

  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(900);
  await expect(page.getByRole('button', { name: 'Create room' })).toBeInViewport();
  const list = page.getByTestId('active-rooms-list');
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
});

test('on a phone the room name field keeps its height above the button', async ({ page }) => {
  // In the stacked layout `flex-1` gave the field a zero basis along the
  // column and squeezed it to a sliver.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const field = page.getByRole('textbox', { name: 'Room name' });
  expect((await field.boundingBox())!.height).toBeGreaterThanOrEqual(40);
});
