import { test, expect } from '@playwright/test';

/**
 * The YouTube watch-history setting.
 *
 * It writes to the viewer's own account, so it is theirs alone: off until
 * they switch it on, only offered once their cookies are on file, and kept
 * on the server so it follows them into every room. The reporting itself
 * is covered by the backend suite; YouTube is never contacted here.
 */

const USER = 'history@example.com';
const COOKIE_FILE = [
  '# Netscape HTTP Cookie File',
  ['.youtube.com', 'TRUE', '/', 'TRUE', '1900000000', 'SID', 'abc123'].join('\t'),
  '',
].join('\n');

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
  await expect(page.getByText(/save your cookies above/i)).toBeVisible();

  // Cookies arrive (here as the extension would deliver them) and the switch opens up.
  await page.getByLabel('Cookie authentication').fill(COOKIE_FILE);
  await page.getByRole('button', { name: 'Save Cookies' }).click();
  await expect(page.getByText('Cookies saved!')).toBeVisible();
  await expect(toggle).toBeEnabled();

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  // The server holds it: a reload and the API both agree.
  await page.reload();
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  await openSettings(page);
  await expect(page.getByTestId('youtube-history-setting').getByRole('switch'))
    .toHaveAttribute('aria-checked', 'true', { timeout: 10_000 });
  const stored = await request.get(`http://localhost:8100/api/user/settings?user=${encodeURIComponent(user)}`);
  expect((await stored.json()).settings.youtube_history).toBe(true);

  // Someone else is unaffected.
  const other = await request.get('http://localhost:8100/api/user/settings?user=someone-else%40example.com');
  expect((await other.json()).settings.youtube_history).toBe(false);
});
