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
