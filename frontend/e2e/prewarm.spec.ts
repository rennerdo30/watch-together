import { test, expect, type Page } from '@playwright/test';

import { stubAdaptiveStream } from './adaptive-fixture';
import { emulateQueueResolution } from './queue-emulation';

/**
 * Preparing the next video while the current one finishes.
 *
 * With an adaptive video playing, the player itself preloads the next entry
 * (see preload-next.spec.ts for what that saves); either way the next
 * entry's manifest is asked for once, before the advance.
 *
 * A queue advance used to pay for everything at once: resolving the entry,
 * probing every rendition to build its manifest, then fetching the first
 * bytes — with the room watching a spinner through all of it. None of that
 * work depends on the advance having happened, so it happens in advance:
 * on the server, from the position it already broadcasts, and from the
 * client, which covers what that beat cannot see — a room paused near the
 * end of a video, or an entry whose duration the server was never told.
 */

const FIRST = 'https://youtu.be/prewarm-first';
const SECOND = 'https://youtu.be/prewarm-second';
const USER = 'prewarm@example.com';

/** How many times the manifest of one video was asked for. */
const asksFor = (requests: string[], original: string) =>
  requests.filter((url) => new URL(url).searchParams.get('url') === original).length;

async function openRoomWithQueue(page: Page, label: string) {
  // One fixture serves both entries: it answers a resolve for whichever
  // URL is asked about.
  const manifestRequests = await stubAdaptiveStream(page, FIRST);
  // The queue add is resolved by the server, which cannot resolve fixture
  // links; see queue-emulation.
  await emulateQueueResolution(page, { addedBy: USER, resolveMs: 100 });
  await page.goto(`/room/e2e-prewarm-${label}-${Date.now().toString(36)}?user=${encodeURIComponent(USER)}`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });

  const input = page.getByPlaceholder('Paste video URL...');
  await input.fill(FIRST);
  await input.press('Enter');
  const media = page.locator('video[data-stream-type="mse"]');
  await expect(media).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.readyState >= 2),
    { timeout: 20_000 }).toBe(true);
  await expect.poll(() => asksFor(manifestRequests, FIRST)).toBeGreaterThan(0);
  // Paused, and left paused: the fixture runs for six seconds, so a video
  // allowed to play through would advance the queue and load the next
  // entry's manifest for the ordinary reason, which is what these tests
  // have to tell the preparation apart from. A paused room near the end of
  // a video is also exactly what the server's own beat cannot see.
  await media.evaluate((video: HTMLVideoElement) => video.pause());
  await expect(page.getByText('Paused', { exact: true }).first()).toBeVisible();

  return { media, manifestRequests, input };
}

test('the next queue entry is prepared before the room reaches it', async ({ page }) => {
  const { media, manifestRequests, input } = await openRoomWithQueue(page, 'next');

  // Nothing is prepared for a video that is not in the queue yet.
  expect(asksFor(manifestRequests, SECOND)).toBe(0);

  await input.fill(SECOND);
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  await expect(page.getByRole('button', { name: /play next/i })).toBeEnabled();

  // The fixture runs for six seconds, so the room is inside the window
  // where its successor is prepared from the moment it plays.
  await expect.poll(() => asksFor(manifestRequests, SECOND), { timeout: 20_000 })
    .toBeGreaterThan(0);

  // Prepared before the advance, not by it: the room is still paused on
  // the first video and the entry is still sitting in the queue.
  await expect(page.getByRole('button', { name: /play next/i })).toBeEnabled();
  expect(await media.evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
});

test('a video is prepared once, however long it plays', async ({ page }) => {
  // The trigger sits on a position that ticks several times a second. A
  // request per tick would be a request per tick per viewer in the room.
  const { manifestRequests, input } = await openRoomWithQueue(page, 'once');

  await input.fill(SECOND);
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  await expect.poll(() => asksFor(manifestRequests, SECOND), { timeout: 20_000 }).toBe(1);

  await page.waitForTimeout(3_000);
  expect(asksFor(manifestRequests, SECOND)).toBe(1);
});
