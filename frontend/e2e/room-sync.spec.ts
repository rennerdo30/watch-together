import { test, expect, type Page, type Browser } from '@playwright/test';

/**
 * Two-client room synchronization through the real UI.
 *
 * Each test opens two isolated browser contexts in the same room and
 * asserts that what one client does becomes visible to the other. These
 * cover the product promise that unit tests cannot: that the browser,
 * the WebSocket hook, and the server agree.
 */

const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';

/** Room ids are per-test so parallel or repeated runs never collide. */
function uniqueRoomId(label: string): string {
  return `e2e-${label}-${Date.now().toString(36)}`;
}

async function joinRoom(browser: Browser, roomId: string, user: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/room/${roomId}?user=${encodeURIComponent(user)}`);
  await expect(
    page.getByLabel('Connected to the room')
  ).toBeVisible({ timeout: 15_000 });
  return page;
}

test.describe('room presence', () => {
  test('a second client appears in the first client audience list', async ({ browser }) => {
    const roomId = uniqueRoomId('presence');

    const alice = await joinRoom(browser, roomId, ALICE);
    await expect(alice.getByRole('tab', { name: /Audience \(1\)/ })).toBeVisible();

    const bob = await joinRoom(browser, roomId, BOB);

    // Both clients converge on the same member count without a reload.
    await expect(alice.getByRole('tab', { name: /Audience \(2\)/ })).toBeVisible();
    await expect(bob.getByRole('tab', { name: /Audience \(2\)/ })).toBeVisible();

    await alice.context().close();
    await bob.context().close();
  });

  test('leaving the room updates the remaining client', async ({ browser }) => {
    const roomId = uniqueRoomId('leave');

    const alice = await joinRoom(browser, roomId, ALICE);
    const bob = await joinRoom(browser, roomId, BOB);
    await expect(alice.getByRole('tab', { name: /Audience \(2\)/ })).toBeVisible();

    await bob.context().close();

    await expect(alice.getByRole('tab', { name: /Audience \(1\)/ })).toBeVisible();
    await alice.context().close();
  });

  test('both members are listed by email', async ({ browser }) => {
    const roomId = uniqueRoomId('members');

    const alice = await joinRoom(browser, roomId, ALICE);
    const bob = await joinRoom(browser, roomId, BOB);

    await alice.getByRole('tab', { name: /Audience/ }).click();
    await expect(alice.getByText(ALICE, { exact: false }).first()).toBeVisible();
    await expect(alice.getByText(BOB, { exact: false }).first()).toBeVisible();

    await alice.context().close();
    await bob.context().close();
  });
});

test.describe('room lifecycle', () => {
  test('the first client becomes admin and can open room settings', async ({ browser }) => {
    const roomId = uniqueRoomId('admin');
    const alice = await joinRoom(browser, roomId, ALICE);

    await expect(alice.getByLabel('Room settings')).toBeVisible();

    await alice.context().close();
  });

  test('a reconnect restores the room without losing membership', async ({ browser }) => {
    const roomId = uniqueRoomId('reconnect');

    const alice = await joinRoom(browser, roomId, ALICE);
    await expect(alice.getByRole('tab', { name: /Audience \(1\)/ })).toBeVisible();

    await alice.reload();
    await expect(
      alice.getByLabel('Connected to the room')
    ).toBeVisible({ timeout: 15_000 });
    await expect(alice.getByRole('tab', { name: /Audience \(1\)/ })).toBeVisible();

    await alice.context().close();
  });

  test('the room appears on the home page while occupied', async ({ browser }) => {
    const roomId = uniqueRoomId('listed');
    const alice = await joinRoom(browser, roomId, ALICE);

    const context = await browser.newContext();
    const home = await context.newPage();
    await home.goto('/');
    await expect(home.getByText(roomId, { exact: false })).toBeVisible({ timeout: 20_000 });

    await context.close();
    await alice.context().close();
  });
});
