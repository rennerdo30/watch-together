import { test, expect } from '@playwright/test';

/**
 * The admin panel at /admin: gated to the identities in ADMIN_EMAILS
 * (the e2e backend allows admin@example.com), showing rooms and every
 * cache tier.
 */

test('an admin sees the panel with every cache tier', async ({ page }) => {
  await page.goto('/admin?user=admin@example.com');

  await expect(page.getByRole('heading', { level: 1 })).toContainText('Admin', { timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Rooms' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Segment cache (disk)' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Memory cache' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Format cache' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Proxy transfers' })).toBeVisible();

  // The cache inspection actually loaded data (the budget renders once the
  // /api/admin/cache response arrives).
  await expect(page.getByText(/of .* budget/)).toBeVisible({ timeout: 15_000 });
});

test('a non-admin is refused', async ({ page }) => {
  await page.goto('/admin?user=viewer@example.com');
  await expect(page.getByText('Admin access required')).toBeVisible({ timeout: 15_000 });
});

test('closing a room from the panel disconnects members for good', async ({ browser }) => {
  const roomId = `e2e-admin-close-${Date.now().toString(36)}`;
  const memberCtx = await browser.newContext();
  const adminCtx = await browser.newContext();
  const member = await memberCtx.newPage();
  const admin = await adminCtx.newPage();

  await member.goto(`/room/${roomId}?user=member@example.com`);
  await expect(member.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });

  await admin.goto('/admin?user=admin@example.com');
  const row = admin.getByRole('row', { name: new RegExp(roomId) });
  await expect(row).toBeVisible({ timeout: 15_000 });

  admin.once('dialog', (dialog) => dialog.accept());
  await row.getByRole('button', { name: 'Close' }).click();

  // The member is told and sent home rather than left on a dead socket.
  await member.waitForURL('/', { timeout: 15_000 });

  // Past the 3s reconnect window nothing has resurrected the room: a
  // fresh load of the panel no longer lists it.
  await admin.waitForTimeout(4_500);
  await admin.reload();
  await expect(admin.getByRole('heading', { name: 'Rooms' })).toBeVisible({ timeout: 15_000 });
  await expect(admin.getByRole('row', { name: new RegExp(roomId) })).toHaveCount(0);

  await memberCtx.close();
  await adminCtx.close();
});
