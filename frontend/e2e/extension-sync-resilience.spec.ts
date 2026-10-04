import { readFileSync } from 'node:fs';
import path from 'node:path';

import { test, expect } from '@playwright/test';

import { loadBackground } from './extension-harness';

/**
 * The extension kept "falling asleep": syncs stopped and only a browser
 * restart brought them back. Three things conspired. A request to the
 * instance had no deadline, so one that never answered kept the sync open;
 * the sync guard was a boolean, so that open sync made every later alarm
 * answer "already in progress"; and when Chrome did skip alarms — a laptop
 * asleep, an idle browser — nothing caught up afterwards. The server now
 * drops cookies it has not seen refreshed, which makes a silent stop worse:
 * the member is in a room with nothing to offer.
 *
 * The worker runs against the real background script with a mocked Chrome
 * API. Cookies come back empty, so a sync that runs ends with "No cookies
 * found" — which is exactly the evidence that it ran.
 */

type Harness = {
  __extensionLocal: Record<string, unknown>;
  __extensionEvents: Record<string, { listeners: Array<(...args: unknown[]) => unknown> }>;
  syncCookies(): Promise<{ success: boolean; error?: string }>;
};

const CONNECTION = { origin: 'https://watch.example', token: 'alice-token' };
const CONNECTED_RULES = [
  { includes: '/api/extension/status', body: { valid: true, user_email: 'alice@example.com' } },
  { includes: '/api/me', body: { authenticated: true, email: 'alice@example.com' } },
];
const RAN_WITHOUT_COOKIES = 'No cookies found';
const TEN_MINUTES_MS = 10 * 60_000;

async function lastSyncStatus(page: import('@playwright/test').Page) {
  return page.evaluate(() => (window as unknown as Harness).__extensionLocal.lastSyncStatus);
}

test('opening the connected instance syncs right away', async ({ page }) => {
  await loadBackground(page, { local: { activeConnection: CONNECTION }, fetchRules: CONNECTED_RULES });

  // A page elsewhere changes nothing.
  await page.evaluate(() => {
    const { onTabUpdated } = (window as unknown as Harness).__extensionEvents;
    onTabUpdated.listeners.forEach((listener) => listener(1, { status: 'complete' }, { url: 'https://www.youtube.com/' }));
  });
  await page.waitForTimeout(100);
  expect(await lastSyncStatus(page)).toBeUndefined();

  await page.evaluate(() => {
    const { onTabUpdated } = (window as unknown as Harness).__extensionEvents;
    onTabUpdated.listeners.forEach((listener) => listener(2, { status: 'complete' }, { url: 'https://watch.example/room/abc' }));
  });
  await expect.poll(() => lastSyncStatus(page)).toBe(RAN_WITHOUT_COOKIES);
});

test('a sync that never finished is superseded instead of blocking forever', async ({ page }) => {
  await loadBackground(page, { local: { activeConnection: CONNECTION }, fetchRules: CONNECTED_RULES });

  // The worker's state lives in top-level `let` bindings of a classic
  // script: global lexical scope, not window properties, so they are set
  // by evaluating source in that scope.

  // A sync started a second ago is still running: skip.
  await page.evaluate('syncStartedAt = Date.now() - 1_000; lastSyncTime = 0;');
  const skipped = await page.evaluate(() => (window as unknown as Harness).syncCookies());
  expect(skipped).toMatchObject({ success: false, error: 'Sync already in progress' });

  // One that started long past every request deadline is dead: proceed.
  await page.evaluate('syncStartedAt = Date.now() - 200_000; lastSyncTime = 0;');
  const superseded = await page.evaluate(() => (window as unknown as Harness).syncCookies());
  expect(superseded).toMatchObject({ success: false, error: expect.stringContaining('No cookies found') });
  expect(await lastSyncStatus(page)).toBe(RAN_WITHOUT_COOKIES);
});

test('coming back to the browser catches up a stale sync, and only a stale one', async ({ page }) => {
  await loadBackground(page, {
    local: { activeConnection: CONNECTION, lastSync: Date.now() - 1_000 },
    fetchRules: CONNECTED_RULES,
  });
  await page.evaluate(() => {
    const { onFocusChanged, onIdleStateChanged } = (window as unknown as Harness).__extensionEvents;
    onFocusChanged.listeners.forEach((listener) => listener(7));
    onIdleStateChanged.listeners.forEach((listener) => listener('active'));
  });
  await page.waitForTimeout(100);
  expect(await lastSyncStatus(page)).toBeUndefined();

  await loadBackground(page, {
    local: { activeConnection: CONNECTION, lastSync: Date.now() - TEN_MINUTES_MS - 1_000 },
    fetchRules: CONNECTED_RULES,
  });
  await page.evaluate(() => {
    const { onFocusChanged } = (window as unknown as Harness).__extensionEvents;
    // Focus leaving every window is not the user coming back.
    onFocusChanged.listeners.forEach((listener) => listener(-1));
  });
  await page.waitForTimeout(100);
  expect(await lastSyncStatus(page)).toBeUndefined();

  await page.evaluate(() => {
    const { onFocusChanged } = (window as unknown as Harness).__extensionEvents;
    onFocusChanged.listeners.forEach((listener) => listener(7));
  });
  await expect.poll(() => lastSyncStatus(page)).toBe(RAN_WITHOUT_COOKIES);
});

test('a disconnected extension does not knock on the instance when focused', async ({ page }) => {
  await loadBackground(page, { local: { lastSync: Date.now() - TEN_MINUTES_MS - 1_000 } });
  await page.evaluate(() => {
    const { onFocusChanged, onIdleStateChanged } = (window as unknown as Harness).__extensionEvents;
    onFocusChanged.listeners.forEach((listener) => listener(7));
    onIdleStateChanged.listeners.forEach((listener) => listener('active'));
  });
  await page.waitForTimeout(100);
  // No fetch rules were given: any request would have thrown "Unexpected fetch"
  // and been recorded as the sync status.
  expect(await lastSyncStatus(page)).toBeUndefined();
});

test('a browser that lacks an optional API still runs the worker', async ({ page }) => {
  // Until Chrome reloads the extension, a permission added to the manifest is
  // not granted and its API object is undefined. Registering on it must not
  // kill the worker: the alarm and the instance-tab sync below it must still work.
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await loadBackground(page, {
    local: { activeConnection: CONNECTION },
    fetchRules: CONNECTED_RULES,
    omitApis: ['idle'],
  });
  expect(errors).toEqual([]);

  await page.evaluate(() => {
    const { onTabUpdated } = (window as unknown as Harness).__extensionEvents;
    onTabUpdated.listeners.forEach((listener) => listener(2, { status: 'complete' }, { url: 'https://watch.example/room/abc' }));
  });
  await expect.poll(() => lastSyncStatus(page)).toBe(RAN_WITHOUT_COOKIES);
});

test('a newer build on the instance badges the icon and offers the download', async ({ page }) => {
  // An unpacked extension never updates itself, so members ran old builds
  // without knowing. The status check is where the extension learns better.
  await loadBackground(page, {
    local: { activeConnection: CONNECTION },
    fetchRules: [
      { includes: '/api/extension/status', body: { valid: true, user_email: 'alice@example.com', extension_version: '99.0.0' } },
      { includes: '/api/me', body: { authenticated: true, email: 'alice@example.com' } },
    ],
  });
  await page.evaluate(() => {
    const { onTabUpdated } = (window as unknown as Harness).__extensionEvents;
    onTabUpdated.listeners.forEach((listener) => listener(2, { status: 'complete' }, { url: 'https://watch.example/room/abc' }));
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as Harness).__extensionLocal.availableUpdate))
    .toEqual({ version: '99.0.0', downloadUrl: 'https://watch.example/api/extension/download/chrome' });
  expect(await page.evaluate(() => (window as unknown as { __extensionBadge: { text: string } }).__extensionBadge.text))
    .toBe('NEW');
});

test('the same build on the instance offers nothing', async ({ page }) => {
  const version = JSON.parse(readFileSync(path.join(__dirname, '../../extension/manifest.json'), 'utf8')).version;
  await loadBackground(page, {
    local: { activeConnection: CONNECTION, availableUpdate: { version: '0.0.1', downloadUrl: 'x' } },
    fetchRules: [
      { includes: '/api/extension/status', body: { valid: true, user_email: 'alice@example.com', extension_version: version } },
      { includes: '/api/me', body: { authenticated: true, email: 'alice@example.com' } },
    ],
  });
  await page.evaluate(() => {
    const { onTabUpdated } = (window as unknown as Harness).__extensionEvents;
    onTabUpdated.listeners.forEach((listener) => listener(2, { status: 'complete' }, { url: 'https://watch.example/room/abc' }));
  });
  await expect.poll(() => lastSyncStatus(page)).toBe(RAN_WITHOUT_COOKIES);
  expect(await page.evaluate(() => (window as unknown as Harness).__extensionLocal.availableUpdate)).toBeUndefined();
});
