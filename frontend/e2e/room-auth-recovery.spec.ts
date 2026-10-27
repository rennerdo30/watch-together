import { test, expect } from '@playwright/test';
import { stubAdaptiveStream } from './adaptive-fixture';

const USER = 'auth-recovery@example.com';
const room = () => `/room/e2e-auth-${Date.now()}?user=${encodeURIComponent(USER)}`;

for (const status of [401, 302] as const) {
test(`a failed restored connection with expired Access (${status}) navigates through sign-in once`, async ({ page }) => {
  let expired = true;
  let navigations = 0;
  let probes = 0;
  page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++; });
  await page.routeWebSocket(/\/ws\/e2e-auth-/, ws => {
    if (expired) ws.close({ code: 1008, reason: 'Authentication required' });
    else ws.connectToServer();
  });
  await page.route('**/api/me?**', route => {
    probes++;
    expect(route.request().headers()['x-requested-with']).toBe('XMLHttpRequest');
    expired = false; // The ensuing top-level navigation can renew the session.
    return route.fulfill(status === 401
      ? { status: 401, body: '' }
      : { status: 302, headers: { location: new URL('/cdn-cgi/access/login', route.request().url()).href }, body: '' });
  });
  await page.goto(room());
  await expect.poll(() => navigations).toBe(2);
  await expect(page.getByLabel('Connected to the room', { exact: true })).toBeVisible();
  expect(probes).toBe(1);
});
}

test('healthy playback survives long idle time and resume without a session probe, socket replacement or media reload', async ({ page }) => {
  test.setTimeout(45_000);
  let sockets = 0;
  let expired = false;
  let navigations = 0;
  let probes = 0;
  const source = 'https://youtu.be/auth-stability-fixture';
  const manifests = await stubAdaptiveStream(page, source);
  await page.clock.install();
  page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++; });
  await page.routeWebSocket(/\/ws\/e2e-auth-/, ws => { sockets++; ws.connectToServer(); });
  // A separately expired HTTP cookie must not tear down an established room
  // connection while its video is playing normally.
  await page.route('**/api/me?**', route => {
    probes++;
    return route.fulfill(expired ? { status: 401, body: '' } : { json: { authenticated: true, email: USER } });
  });
  await page.goto(room());
  await expect(page.getByLabel('Connected to the room', { exact: true })).toBeVisible();
  await page.getByPlaceholder('Paste video URL...').fill(source);
  await page.getByPlaceholder('Paste video URL...').press('Enter');
  const video = page.locator('video[data-stream-type="mse"]');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThan(2);
  await video.evaluate((v: HTMLVideoElement) => { v.muted = true; v.currentTime = 0; void v.play(); });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0.1);
  const original = await video.elementHandle();
  const initial = { sockets, navigations, manifests: manifests.length };
  expired = true;
  await page.clock.fastForward(65_000);
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const before = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(before + 0.3);
  expect(await original!.evaluate(v => v.isConnected)).toBe(true);
  expect({ sockets, navigations, manifests: manifests.length }).toEqual(initial);
  expect(probes).toBe(0);
  await expect(page.getByText(/room connection is recovering/i)).toHaveCount(0);
});

test('a delayed expired-session response cannot reload a room that already reconnected', async ({ page }) => {
  let closeConnection = () => {};
  let navigations = 0;
  let respond: (() => void) | undefined;
  page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++; });
  await page.routeWebSocket(/\/ws\/e2e-auth-/, ws => {
    ws.connectToServer();
    closeConnection = () => ws.close({ code: 1008, reason: 'Rejected' });
  });
  await page.route('**/api/me?**', async route => {
    await new Promise<void>(resolve => { respond = resolve; });
    await route.fulfill({ status: 401, body: '' });
  });
  await page.goto(room());
  await expect(page.getByLabel('Connected to the room', { exact: true })).toBeVisible();
  closeConnection();
  await expect.poll(() => Boolean(respond)).toBe(true);
  await expect(page.getByLabel('Connected to the room', { exact: true })).toBeVisible();
  respond!();
  await page.waitForTimeout(300);
  expect(navigations).toBe(1);
  await expect(page.getByLabel('Connected to the room', { exact: true })).toBeVisible();
});

test('network and server failures leave ordinary reconnects alone without reloading', async ({ page }) => {
  let probes = 0;
  let navigations = 0;
  page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++; });
  await page.routeWebSocket(/\/ws\/e2e-auth-/, ws => ws.close({ code: 1012, reason: 'Server unavailable' }));
  await page.route('**/api/me?**', route => {
    probes++;
    return route.fulfill({ status: 503, body: '' });
  });
  await page.goto(room());
  await expect.poll(() => probes).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  expect(navigations).toBe(1);
  await expect(page.getByRole('button', { name: 'Sign in again', exact: true })).toHaveCount(0);
});

test('persistent login failure reloads at most once and offers manual sign-in', async ({ page }) => {
  let navigations = 0;
  page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++; });
  await page.routeWebSocket(/\/ws\/e2e-auth-/, ws => ws.close({ code: 1008, reason: 'Authentication required' }));
  await page.route('**/api/me?**', route => route.fulfill({ status: 401, body: '' }));
  await page.goto(room());
  await expect(page.getByRole('button', { name: 'Sign in again', exact: true })).toBeVisible();
  await page.waitForTimeout(500);
  expect(navigations).toBe(2);
});
