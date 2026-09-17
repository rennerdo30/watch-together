import { test, expect, type Page } from '@playwright/test';

/**
 * The room's shared browser, from the room's side.
 *
 * neko itself is stubbed at the two boundaries this page actually touches:
 * the status endpoint that decides whether the feature may be offered, and
 * the `/neko/` document the iframe loads. Everything in between — the
 * WebSocket message, the other member learning about it, the player area
 * handing over, the session call that sets the cookie — is the real code.
 *
 * What is deliberately not asserted here is that a picture appears, because
 * no amount of stubbing would make that mean anything: the picture is WebRTC
 * from a container that is not running, and whether it can reach a viewer at
 * all is a property of the deployment rather than of this page. That is the
 * same reason the *unavailable* case is tested first and at length — it is
 * the case most rooms will be in, and the one the code exists to make
 * honest.
 */

const ROOM = () => `e2e-browser-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;

interface StatusOverrides {
  enabled?: boolean;
  available?: boolean;
  reason?: string | null;
  transport?: string | null;
  running?: boolean;
  held_by_room?: string | null;
}

/**
 * Answer the status endpoint, and serve the embed from a local fixture.
 *
 * `control` is what the session call really returns per member — the room's
 * admin drives, everyone else watches — and the banner says different things
 * for the two, so it is not something the stub may flatten.
 */
async function stubSharedBrowser(page: Page, overrides: StatusOverrides = {}, control = true) {
  await page.route('**/api/browser?*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      enabled: true,
      available: true,
      reason: null,
      transport: 'turn',
      running: true,
      path: '/neko/?embed=1',
      held_by_room: null,
      session: null,
      ...overrides,
    }),
  }));
  // The session call sets a cookie for a container that is not there; the
  // page only needs the path back.
  await page.route('**/api/browser/session?*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ path: '/neko/?embed=1', control }),
  }));
  await page.route('**/neko/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<p>neko fixture</p>',
  }));
}

async function joinRoom(page: Page, roomId: string, user: string) {
  await page.goto(`/room/${roomId}?user=${encodeURIComponent(user)}`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible();
}

test('an instance with no way out for the media says so instead of opening a black rectangle', async ({ page }) => {
  await stubSharedBrowser(page, {
    available: false, reason: 'no_media_path', transport: null, running: false,
  });
  await joinRoom(page, ROOM(), 'nobody@example.com');

  await page.getByTestId('open-shared-browser').click();

  // Named in full: an operator reading over a member's shoulder should be
  // able to act on it, and a member should understand it is not their fault.
  const notice = page.getByTestId('shared-browser-unavailable');
  await expect(notice).toContainText('no way to send the browser');
  await expect(notice).toContainText('UDP port range');
  await expect(notice).toContainText('TURN relay');
  await expect(page.getByTestId('confirm-shared-browser')).toBeDisabled();
  await expect(page.getByTestId('shared-browser-frame')).toHaveCount(0);
});

test('a switched-off instance is a different sentence from a broken one', async ({ page }) => {
  await stubSharedBrowser(page, {
    enabled: false, available: false, reason: 'disabled', transport: null, running: false,
  });
  await joinRoom(page, ROOM(), 'nobody@example.com');

  await page.getByTestId('open-shared-browser').click();

  await expect(page.getByTestId('shared-browser-unavailable')).toContainText('switched off');
  await expect(page.getByTestId('confirm-shared-browser')).toBeDisabled();
});

test('a configured instance whose container is not running says that, too', async ({ page }) => {
  await stubSharedBrowser(page, { available: true, reason: null, running: false });
  await joinRoom(page, ROOM(), 'nobody@example.com');

  await page.getByTestId('open-shared-browser').click();

  await expect(page.getByTestId('shared-browser-unavailable')).toContainText('not running');
  await expect(page.getByTestId('confirm-shared-browser')).toBeDisabled();
});

test('opening it puts the browser on both members\' players, and closing it takes it back off', async ({ browser }) => {
  const roomId = ROOM();
  const context = await browser.newContext();
  const opener = await context.newPage();
  const watcher = await context.newPage();
  await stubSharedBrowser(opener, {}, true);
  await stubSharedBrowser(watcher, {}, false);

  await joinRoom(opener, roomId, 'opener@example.com');
  await joinRoom(watcher, roomId, 'watcher@example.com');

  await opener.getByTestId('open-shared-browser').click();
  await opener.getByTestId('confirm-shared-browser').click();

  // The opener sees it because it pressed the button; the watcher sees it
  // because the room told it, which is the half that could silently break.
  for (const page of [opener, watcher]) {
    await expect(page.getByTestId('shared-browser-frame')).toBeVisible();
    await expect(page.frameLocator('[data-testid="shared-browser-frame"]')
      .getByText('neko fixture')).toBeVisible();
  }
  await expect(watcher.getByTestId('shared-browser-banner')).toContainText('opener@example.com');
  // One player, one source: a screen share cannot be started over it.
  await expect(watcher.getByRole('button', { name: 'Share screen' })).toBeDisabled();

  await opener.getByTestId('close-shared-browser').click();

  for (const page of [opener, watcher]) {
    await expect(page.getByTestId('shared-browser-frame')).toHaveCount(0);
  }
  await expect(watcher.getByRole('button', { name: 'Share screen' })).toBeEnabled();
  await context.close();
});

test('a member who joins while it is open sees it rather than an empty player', async ({ browser }) => {
  const roomId = ROOM();
  const context = await browser.newContext();
  const opener = await context.newPage();
  await stubSharedBrowser(opener);
  await joinRoom(opener, roomId, 'opener@example.com');
  await opener.getByTestId('open-shared-browser').click();
  await opener.getByTestId('confirm-shared-browser').click();
  await expect(opener.getByTestId('shared-browser-frame')).toBeVisible();

  const latecomer = await context.newPage();
  await stubSharedBrowser(latecomer);
  await joinRoom(latecomer, roomId, 'late@example.com');

  await expect(latecomer.getByTestId('shared-browser-frame')).toBeVisible();
  await context.close();
});
