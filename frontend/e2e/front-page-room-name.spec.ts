import { test, expect } from '@playwright/test';

/**
 * The front page's "available rooms" list shows a renamed room by its
 * name, not its id. The room only appears in the listing while someone
 * is connected, so the admin's tab stays open.
 */

test('the front page lists a renamed room by its name', async ({ browser }) => {
  const roomId = `e2e-frontpage-${Date.now().toString(36)}`;
  const adminContext = await browser.newContext();
  const visitorContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const visitor = await visitorContext.newPage();

  await admin.goto(`/room/${roomId}?user=frontpage-admin@example.com`);
  await expect(admin.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });

  await admin.getByRole('button', { name: 'Room settings' }).click();
  const input = admin.getByLabel('Room name');
  await expect(input).toBeVisible();
  await input.fill('Front Page Label');
  await admin.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(admin.getByText(/Room renamed to "Front Page Label"/)).toBeVisible({ timeout: 10_000 });

  // The admin's tab keeps the room active while the visitor loads the
  // front page.
  await visitor.goto('/');
  const row = visitor.getByRole('link', { name: /Front Page Label/ });
  await expect(row).toBeVisible({ timeout: 15_000 });
  // The name replaces the id as the row's title rather than joining it.
  await expect(row.locator('span.font-medium')).toHaveText('Front Page Label');

  await adminContext.close();
  await visitorContext.close();
});
