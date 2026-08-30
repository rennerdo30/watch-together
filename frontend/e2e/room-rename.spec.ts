import { test, expect } from '@playwright/test';

/**
 * An admin can rename a room after creating it, and everyone sees it.
 *
 * The room id is the address — the link, persistence and reconnects all
 * key on it — so the rename changes the label in headers and listings,
 * never the URL.
 */

function uniqueRoomId(label: string): string {
  return `e2e-${label}-${Date.now().toString(36)}`;
}

test('renaming a room updates every member without changing the link', async ({ browser }) => {
  const roomId = uniqueRoomId('rename');
  const adminContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const member = await memberContext.newPage();

  // First to join becomes admin.
  await admin.goto(`/room/${roomId}?user=rename-admin@example.com`);
  await expect(admin.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  await member.goto(`/room/${roomId}?user=rename-member@example.com`);
  await expect(member.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });

  await admin.getByRole('button', { name: 'Room settings' }).click();
  const input = admin.getByLabel('Room name');
  await expect(input).toBeVisible();
  await input.fill('Movie Night');
  await admin.getByRole('button', { name: 'Save', exact: true }).click();

  // Both headers show the label; the address bar keeps the id.
  await expect(admin.getByText('Movie Night').first()).toBeVisible({ timeout: 10_000 });
  await expect(member.getByText('Movie Night').first()).toBeVisible({ timeout: 10_000 });
  expect(admin.url()).toContain(`/room/${roomId}`);

  // The member has no rename control.
  await member.getByRole('button', { name: 'Room settings' }).click();
  await expect(member.getByLabel('Room name')).toHaveCount(0);

  await adminContext.close();
  await memberContext.close();
});
