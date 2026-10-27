import { test, expect } from '@playwright/test';
import { createRoomSender } from '../lib/room-sender';

const USER = 'resume@example.com';
const room = () => `/room/e2e-session-${Date.now()}?user=${encodeURIComponent(USER)}`;

test('a restored page revalidates an expired Access session with a full navigation', async ({ page }) => {
  let probes = 0;
  let navigations = 0;
  let expired = false;
  page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++; });
  await page.route('**/api/me?**', route => {
    probes++;
    expect(route.request().headers()['x-requested-with']).toBe('XMLHttpRequest');
    if (expired) {
      expired = false; // The top-level navigation can now finish signing in.
      return route.fulfill({ status: 401, body: '' });
    }
    return route.fulfill({ json: { authenticated: true, email: USER } });
  });
  await page.goto(room());
  await expect(page.getByLabel('Connected to the room', { exact: true })).toBeVisible();
  const before = navigations;
  expired = true;
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect.poll(() => navigations).toBeGreaterThan(before);
  await expect(page.getByLabel('Connected to the room', { exact: true })).toBeVisible();
  expect(probes).toBeGreaterThan(0);
});

test('a silent socket after sleep reconnects and receives a fresh room snapshot', async ({ page }) => {
  test.setTimeout(60_000);
  let connections = 0;
  await page.clock.install();
  await page.routeWebSocket(/\/ws\/e2e-session-/, ws => {
    const number = ++connections;
    ws.send(JSON.stringify({ type: 'sync', payload: {
      your_email: USER, roles: { [USER]: 'admin' }, queue: [], members: [{ email: USER }],
      name: number > 1 ? 'Recovered room' : 'Before sleep',
    } }));
    // Simulate a half-open connection: OPEN in the browser, no pong/heartbeat.
    ws.onMessage(() => {});
  });
  await page.route('**/api/me?**', route => route.fulfill({ json: { authenticated: true, email: USER } }));
  await page.goto(room());
  await expect(page.getByLabel('Connected to the room', { exact: true })).toBeVisible();
  const before = connections;
  await page.clock.fastForward(25_000);
  expect(connections).toBe(before);
  await page.clock.runFor(15_000);
  await expect.poll(() => connections).toBeGreaterThan(before);
  await expect(page.getByText('Recovered room', { exact: true })).toBeVisible();
});

// Network failures and server failures are not evidence of expired credentials.
test('an offline revalidation does not reload the page or loop on an auth outage', async ({ page }) => {
  let probes = 0;
  let navigations = 0;
  page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++; });
  await page.route('**/api/me?**', route => { probes++; return route.abort('failed'); });
  await page.goto(room());
  await expect(page.getByLabel('Connected to the room', { exact: true })).toBeVisible();
  const before = navigations;
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect.poll(() => probes).toBeGreaterThan(0);
  expect(navigations).toBe(before);
});

test('persistent authentication failure reloads once and then offers sign-in without a loop', async ({ page }) => {
  let navigations = 0;
  page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++; });
  await page.route('**/api/me?**', route => route.fulfill({ status: 401, body: '' }));
  await page.goto(room());
  await expect(page.getByRole('button', { name: 'Sign in again', exact: true })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Your session expired' })).toBeVisible();
  await page.waitForTimeout(1000);
  expect(navigations).toBe(2);
});

test('an active long-lived page detects expiry without a focus or restore event', async ({ page }) => {
  let expired = false;
  let probes = 0;
  let navigations = 0;
  await page.clock.install();
  page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++; });
  await page.route('**/api/me?**', route => {
    probes++;
    if (expired) { expired = false; return route.fulfill({ status: 401 }); }
    return route.fulfill({ json: { authenticated: true, email: USER } });
  });
  await page.goto(room());
  await expect(page.getByLabel('Connected to the room', { exact: true })).toBeVisible();
  await expect.poll(() => probes).toBeGreaterThan(0);
  const before = navigations;
  expired = true;
  await page.clock.fastForward(65_000);
  await expect.poll(() => navigations).toBeGreaterThan(before);
});

test('an administrator-closed socket stays closed after resume and watchdog ticks', async ({ page }) => {
  let connections = 0;
  let closeRoom = () => {};
  await page.clock.install();
  await page.routeWebSocket(/\/ws\/e2e-session-/, ws => {
    connections++;
    closeRoom = () => ws.close({ code: 4001, reason: 'Room closed' });
    ws.onMessage(() => {});
  });
  await page.route('**/api/me?**', route => route.fulfill({ json: { authenticated: true, email: USER } }));
  await page.goto(room());
  await expect(page.getByLabel('Connected to the room', { exact: true })).toBeVisible();
  const before = connections;
  closeRoom();
  await expect(page.getByLabel('Disconnected from the room', { exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await page.clock.fastForward(65_000);
  expect(connections).toBe(before);
});


test('a paused tab gets a fresh ping grace period without disconnecting a responsive socket', async ({ page }) => {
  let connections = 0;
  let reply = () => {};
  const actions: unknown[] = [];
  await page.clock.install();
  await page.routeWebSocket(/\/ws\/e2e-session-/, ws => {
    connections++;
    reply = () => ws.send(JSON.stringify({ type: 'pong', payload: { client_time: 0 } }));
    ws.onMessage(message => {
      const parsed = JSON.parse(String(message));
      if (parsed.type === 'queue_add') actions.push(parsed.payload);
    });
  });
  await page.route('**/api/me?**', route => route.fulfill({ json: { authenticated: true, email: USER } }));
  await page.route('**/api/resolve**', route => route.fulfill({ json: { original_url: 'https://youtu.be/still-connected', title: 'Still connected', stream_url: 'https://media.test/video.mp4' } }));
  await page.goto(room());
  await expect(page.getByLabel('Connected to the room', { exact: true })).toBeVisible();
  const before = connections;
  // Chrome coalesces timers after a suspended tab. Silence during the pause
  // must not be mistaken for a failed ping sent after it woke up.
  await page.clock.fastForward(65_000);
  await page.getByPlaceholder('Paste video URL...').fill('https://youtu.be/still-connected');
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  await expect.poll(() => actions.length).toBe(1);
  await expect(page.getByText('Room connection is recovering. Please try again once connected.', { exact: true })).toHaveCount(0);
  reply();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByLabel('Connected to the room', { exact: true })).toBeVisible();
  expect(connections).toBe(before);
});

test('failed background playback reports do not warn the viewer', () => {
  const warnings: string[] = [];
  const attempts: string[] = [];
  const sender = createRoomSender(type => { attempts.push(type); return false; }, () => warnings.push('recovering'));
  for (const type of ['playback_quality', 'playback_ready', 'playback_timing']) sender.send(type, {});
  expect(attempts).toHaveLength(3);
  expect(warnings).toEqual([]);
});

test('failed user actions warn once until the connection recovers', () => {
  let warnings = 0;
  const sender = createRoomSender(() => false, () => { warnings++; });
  sender.send('queue_add', { url: 'https://youtu.be/example' });
  sender.send('queue_reorder', {});
  sender.send('play', {});
  expect(warnings).toBe(1);
  sender.connected();
  sender.send('queue_add', {});
  expect(warnings).toBe(2);
});
