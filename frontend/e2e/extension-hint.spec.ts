import { test, expect } from '@playwright/test';

import { syncCookiesAsExtension } from './extension-cookies';

/**
 * Members without the extension have no session to offer the room, and most
 * videos need one. The room tells them once, above the URL box, and the
 * hint goes away for good when they dismiss it — or by itself once the
 * extension has synced their cookies. The "Install" buttons in Settings
 * download a build packaged by this very instance; they used to point at
 * addresses nothing served.
 */

function uniqueRoomId(label: string): string {
  return `e2e-${label}-${Date.now().toString(36)}`;
}

function freshUser(label: string): string {
  return `${Date.now().toString(36)}-${label}@example.com`;
}

test('a member without cookies is pointed at the extension, once', async ({ page }) => {
  const user = freshUser('hint');
  await page.goto(`/room/${uniqueRoomId('hint')}?user=${encodeURIComponent(user)}`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });

  const hint = page.getByTestId('extension-hint');
  await expect(hint).toBeVisible();
  await expect(hint).toContainText(/install the browser extension/i);

  // "Install" opens Settings, where the download buttons are.
  await hint.getByRole('button', { name: 'Install' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Install Extension')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // Dismissed is dismissed, reload included.
  await hint.getByRole('button', { name: 'Dismiss the extension hint' }).click();
  await expect(hint).toBeHidden();
  await page.reload();
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('extension-hint')).toBeHidden();
});

test('a member whose extension has synced sees no hint', async ({ page, request }) => {
  const user = freshUser('synced');
  await syncCookiesAsExtension(request, user);

  await page.goto(`/room/${uniqueRoomId('synced')}?user=${encodeURIComponent(user)}`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Room settings' }).click();
  await expect(page.getByTestId('cookie-status')).toContainText('In memory');
  await expect(page.getByTestId('extension-hint')).toBeHidden();
});

test('the install buttons download builds packaged by this instance', async ({ page, request }) => {
  await page.goto(`/room/${uniqueRoomId('download')}?user=${encodeURIComponent(freshUser('download'))}`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Room settings' }).click();
  const dialog = page.getByRole('dialog');

  for (const [label, browser] of [['Chrome / Edge', 'chrome'], ['Firefox', 'firefox']] as const) {
    const link = dialog.getByRole('link', { name: label });
    const href = await link.getAttribute('href');
    expect(href).toContain(`/api/extension/download/${browser}`);
    const download = await request.get(href!);
    expect(download.status()).toBe(200);
    expect(download.headers()['content-type']).toBe('application/zip');
    expect(download.headers()['content-disposition']).toContain(`watch-together-${browser}.zip`);
  }
  await expect(dialog.getByRole('link', { name: 'Safari' })).toHaveCount(0);
});
