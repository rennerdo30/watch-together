import { expect, test, type Browser, type Page } from '@playwright/test';

import { stubAdaptiveStream } from './adaptive-fixture';
import {
  ROOM_ACTIVITY_LIMIT,
  describeRoomActivity,
  mergeRoomActivity,
  normalizeRoomActivity,
} from '../lib/room-log';

const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const VIDEO_URL = 'https://youtu.be/room-log-video';

async function join(browser: Browser, roomId: string, user: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await stubAdaptiveStream(page, VIDEO_URL);
  await page.goto(`/room/${roomId}?user=${encodeURIComponent(user)}`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  return page;
}

test('activity helpers keep a deduplicated newest-first 200-event window', () => {
  const raw = Array.from({ length: ROOM_ACTIVITY_LIMIT + 5 }, (_, index) => ({
    id: `event-${index}`,
    action: 'playback_seeked',
    actor: ALICE,
    created_at: index,
    timestamp: 754,
  }));
  const events = normalizeRoomActivity([...raw, raw[204], { nope: true }]);
  expect(events).toHaveLength(ROOM_ACTIVITY_LIMIT);
  expect(events[0].id).toBe('event-204');
  expect(events.at(-1)?.id).toBe('event-5');
  expect(mergeRoomActivity(events, raw[204])).toHaveLength(ROOM_ACTIVITY_LIMIT);
  expect(describeRoomActivity(events[0]).text).toBe('alice seeked to 12:34');
});

test('queue activity is attributed, retains removed titles, and survives reconnect', async ({ browser }) => {
  const roomId = `e2e-room-log-${Date.now().toString(36)}`;
  const alice = await join(browser, roomId, ALICE);
  const bob = await join(browser, roomId, BOB);

  await alice.getByPlaceholder('Paste video URL...').fill(VIDEO_URL);
  await alice.getByRole('button', { name: 'Queue', exact: true }).click();
  await expect(bob.getByRole('tab', { name: 'Queue (1)', exact: true })).toBeVisible();

  await bob.getByRole('tab', { name: 'Log', exact: true }).click();
  const log = bob.getByRole('list', { name: 'Room activity, newest first' });
  await expect(log.getByRole('listitem').filter({ hasText: 'alice added a video to the queue' })).toContainText('“Adaptive fixture”');

  await alice.getByRole('button', { name: 'Pin Adaptive fixture', exact: true }).click();
  await expect(log.getByRole('listitem').filter({ hasText: 'alice pinned a video' })).toContainText('“Adaptive fixture”');
  await alice.getByRole('button', { name: 'Remove Adaptive fixture from the queue', exact: true }).click();
  await expect(bob.getByRole('tab', { name: 'Queue (0)', exact: true })).toBeVisible();
  await expect(log.getByRole('listitem').filter({ hasText: 'alice removed a video from the queue' })).toContainText('“Adaptive fixture”');

  await bob.reload();
  await expect(bob.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  await bob.getByRole('tab', { name: 'Log', exact: true }).click();
  await expect(bob.getByRole('listitem').filter({ hasText: 'alice removed a video from the queue' })).toContainText('“Adaptive fixture”');

  await alice.context().close();
  await bob.context().close();
});

test('all four sidebar tabs remain visible at a narrow viewport', async ({ browser }) => {
  const roomId = `e2e-room-log-narrow-${Date.now().toString(36)}`;
  const page = await join(browser, roomId, ALICE);
  await page.setViewportSize({ width: 320, height: 720 });

  const tabs = page.getByRole('tablist', { name: 'Sidebar sections' });
  await expect(tabs).toBeVisible();
  for (const name of [/Queue/, /Audience/, 'Live chat', 'Log']) {
    await expect(tabs.getByRole('tab', { name })).toBeVisible();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.context().close();
});
