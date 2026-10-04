import { test, expect, type Page } from '@playwright/test';

import { loadBackground } from './extension-harness';

/**
 * The extension keeps open room tabs from being discarded.
 *
 * The room is left open all day in a background tab, and Chrome's Memory
 * Saver discards background tabs it thinks are idle. A discarded tab runs no
 * code, so a video someone queued never reached that member, and the page can
 * only say so once they come back. A page cannot opt out of discarding; an
 * extension can, per tab, with `autoDiscardable`.
 */

type Harness = {
  __extensionEvents: Record<string, { listeners: Array<(...args: unknown[]) => unknown> }>;
  __extensionTabUpdates: Array<{ tabId: number; props: Record<string, unknown> }>;
};

const CONNECTION = { origin: 'https://watch.example', token: 'alice-token' };
const CONNECTED_RULES = [
  { includes: '/api/extension/status', body: { valid: true, user_email: 'alice@example.com' } },
  { includes: '/api/me', body: { authenticated: true, email: 'alice@example.com' } },
  { includes: '/api/cookies', body: {} },
];

const updates = (page: Page) =>
  page.evaluate(() => (window as unknown as Harness).__extensionTabUpdates);

/** A tab of this id navigated to `url`, as Chrome reports it. */
const navigate = (page: Page, tabId: number, url: string) => page.evaluate(([id, to]) => {
  const { onTabUpdated } = (window as unknown as Harness).__extensionEvents;
  onTabUpdated.listeners.forEach((listener) => listener(id, { url: to }, { id, url: to }));
}, [tabId, url] as const);

test('a room tab is kept loaded, and given back once it leaves the room', async ({ page }) => {
  await loadBackground(page, { local: { activeConnection: CONNECTION }, fetchRules: CONNECTED_RULES });

  // Not the instance, and the instance but not a room: left alone.
  await navigate(page, 1, 'https://www.youtube.com/watch?v=abc');
  await navigate(page, 2, 'https://watch.example/');
  await page.waitForTimeout(100);
  expect(await updates(page)).toEqual([]);

  await navigate(page, 3, 'https://watch.example/room/movie-night');
  await expect.poll(() => updates(page)).toEqual([{ tabId: 3, props: { autoDiscardable: false } }]);

  // Another room in the same tab changes nothing; leaving undoes it.
  await navigate(page, 3, 'https://watch.example/room/other');
  await page.waitForTimeout(100);
  expect(await updates(page)).toHaveLength(1);
  await navigate(page, 3, 'https://www.youtube.com/');
  await expect.poll(() => updates(page)).toEqual([
    { tabId: 3, props: { autoDiscardable: false } },
    { tabId: 3, props: { autoDiscardable: true } },
  ]);
});

test('rooms already open when the browser starts are kept loaded', async ({ page }) => {
  await loadBackground(page, {
    local: { activeConnection: CONNECTION },
    fetchRules: CONNECTED_RULES,
    tabs: [
      { id: 7, url: 'https://watch.example/room/all-day' },
      { id: 8, url: 'https://www.twitch.tv/somebody' },
    ],
  });
  await page.evaluate(() => {
    (window as unknown as Harness).__extensionEvents.onStartup.listeners.forEach((listener) => listener());
  });
  await expect.poll(() => updates(page)).toEqual([{ tabId: 7, props: { autoDiscardable: false } }]);
});

test('without a connection, no tab is touched', async ({ page }) => {
  await loadBackground(page, { tabs: [{ id: 7, url: 'https://watch.example/room/all-day' }] });
  await navigate(page, 7, 'https://watch.example/room/all-day');
  await page.evaluate(() => {
    (window as unknown as Harness).__extensionEvents.onStartup.listeners.forEach((listener) => listener());
  });
  await page.waitForTimeout(200);
  expect(await updates(page)).toEqual([]);
});
