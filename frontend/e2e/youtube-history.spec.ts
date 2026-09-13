import { test, expect } from '@playwright/test';

import { BACKEND, syncCookiesAsExtension } from './extension-cookies';

/**
 * The YouTube watch-history setting.
 *
 * It writes to the viewer's own account, so it is theirs alone: off until
 * they switch it on, only offered while the server holds their cookies, and
 * kept on the server so it follows them into every room. The reporting
 * itself is covered by the backend suite; YouTube is never contacted here.
 *
 * The web form that once accepted a pasted cookie file is gone, so this
 * test delivers cookies as the extension would.
 */

const USER = 'history@example.com';

function uniqueRoomId(label: string): string {
  return `e2e-${label}-${Date.now().toString(36)}`;
}

async function openSettings(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Room settings' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

test('the setting is off, unavailable without cookies, and sticks once switched on', async ({ page, request }) => {
  // A fresh identity for every run: the setting is stored per user.
  const user = `${Date.now().toString(36)}-${USER}`;
  await page.goto(`/room/${uniqueRoomId('history')}?user=${encodeURIComponent(user)}`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });

  await openSettings(page);
  const toggle = page.getByTestId('youtube-history-setting').getByRole('switch');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(toggle).toBeDisabled();
  await expect(page.getByText(/connect the browser extension/i)).toBeVisible();
  await expect(page.getByTestId('cookie-status')).toContainText('No cookies on the server');

  // Cookies arrive from the extension; reopening Settings notices them.
  await syncCookiesAsExtension(request, user);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await openSettings(page);
  await expect(page.getByTestId('cookie-status')).toContainText('In memory');
  await expect(toggle).toBeEnabled();

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  // The server holds it: a reload and the API both agree.
  await page.reload();
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  await openSettings(page);
  await expect(page.getByTestId('youtube-history-setting').getByRole('switch'))
    .toHaveAttribute('aria-checked', 'true', { timeout: 10_000 });
  const stored = await request.get(`${BACKEND}/api/user/settings?user=${encodeURIComponent(user)}`);
  expect((await stored.json()).settings.youtube_history).toBe(true);

  // Someone else is unaffected.
  const other = await request.get(`${BACKEND}/api/user/settings?user=someone-else%40example.com`);
  expect((await other.json()).settings.youtube_history).toBe(false);
});
