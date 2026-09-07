import { test, expect } from '@playwright/test';

import { stubAdaptiveStream } from './adaptive-fixture';

/**
 * Every video in a room links back to the page it was added from, so a
 * viewer can open the original — comments, description, channel — without
 * having to remember or re-find the URL they pasted.
 */

const USER = 'open-original@example.com';
const ORIGINAL_URL = 'https://youtu.be/open-original-fixture';
const LINK_NAME = /open adaptive fixture on youtu\.be/i;

async function openRoom(page: import('@playwright/test').Page) {
  await stubAdaptiveStream(page, ORIGINAL_URL);
  await page.goto(`/room/e2e-open-original-${Date.now().toString(36)}?user=${encodeURIComponent(USER)}`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  await page.getByPlaceholder('Paste video URL...').fill(ORIGINAL_URL);
}

test('a queued video links to its original page without playing or dragging it', async ({ page, context }) => {
  // The new tab must not reach the real site from a test run.
  await context.route(`${ORIGINAL_URL}**`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<title>original</title>' }));
  await openRoom(page);
  await page.getByRole('button', { name: 'Queue', exact: true }).click();

  // Nothing is playing yet, so the queue row holds the only link.
  const link = page.getByRole('link', { name: LINK_NAME });
  await expect(link).toHaveAttribute('href', ORIGINAL_URL);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);

  // The link sits inside a row that plays on click: activating it must open
  // the page in a new tab and leave the room's player alone.
  const popup = page.waitForEvent('popup');
  await link.click();
  const opened = await popup;
  await opened.waitForLoadState('domcontentloaded');
  expect(opened.url()).toBe(ORIGINAL_URL);
  await opened.close();
  await expect(page.locator('video[data-stream-type="mse"]')).toHaveCount(0);
});

test('the header links to the page of the video that is playing', async ({ page }) => {
  await openRoom(page);
  await page.getByPlaceholder('Paste video URL...').press('Enter');
  await expect(page.locator('video[data-stream-type="mse"]')).toHaveCount(1, { timeout: 15_000 });

  const link = page.locator('header').getByRole('link', { name: LINK_NAME });
  await expect(link).toHaveAttribute('href', ORIGINAL_URL);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);
});
