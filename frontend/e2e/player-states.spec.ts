import { test, expect } from '@playwright/test';

/**
 * Regression tests for what the player shows when it is not playing.
 *
 * The empty state and the resolving spinner used to render at the same
 * time, and the spinner's backdrop was translucent, so "Nothing playing
 * yet" read straight through "Resolving...".
 */

const USER = 'states@example.com';

function uniqueRoomId(label: string): string {
  return `e2e-${label}-${Date.now().toString(36)}`;
}

test('an idle room shows the empty state and no spinner', async ({ page }) => {
  await page.goto(`/room/${uniqueRoomId('idle')}?user=${encodeURIComponent(USER)}`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });

  await expect(page.getByText('Nothing playing yet')).toBeVisible();
  await expect(page.getByText('Resolving...')).toHaveCount(0);
});

test('the empty state gives way to the spinner while resolving', async ({ page }) => {
  const roomId = uniqueRoomId('resolving');

  // Hold the resolve open so the intermediate state can be observed at all.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/resolve**', async (route) => {
    await held;
    await route.fulfill({ status: 400, contentType: 'application/json',
                          body: JSON.stringify({ detail: 'stopped by the test' }) });
  });

  await page.goto(`/room/${roomId}?user=${encodeURIComponent(USER)}`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });

  await page.getByPlaceholder('Paste video URL...').fill('https://youtu.be/whatever');
  await page.getByPlaceholder('Paste video URL...').press('Enter');

  // While resolving, the spinner is shown and the placeholder is not:
  // the two used to overlap and read as garbled text.
  await expect(page.getByText('Resolving...')).toBeVisible();
  await expect(page.getByText('Nothing playing yet')).toHaveCount(0);

  release();
});
