import { test, expect, type Page } from '@playwright/test';

import { looksLikeUrl } from '../lib/utils';
import { stubAdaptiveStream } from './adaptive-fixture';
import { emulateQueueResolution } from './queue-emulation';

/**
 * Getting a link into the room without waiting for it.
 *
 * Queueing used to resolve the link in the browser first — the length of an
 * extraction, a quarter of a second per round trip from Japan on top — with
 * a busy button and nothing in the queue to show for it. Now the link goes
 * to the server as it is, shows up as a pending row at once and fills in
 * when the server has resolved it. "Play" still resolves here, but a pasted
 * link is resolved while the viewer reaches for the button, and the click
 * joins that resolve rather than starting another.
 */

const USER = 'queue-ux@example.com';
const PLAYING = 'https://youtu.be/queue-ux-playing';
const QUEUED = 'https://youtu.be/queue-ux-queued';

async function openRoom(page: Page, label: string) {
  await page.goto(`/room/e2e-queue-ux-${label}-${Date.now().toString(36)}?user=${encodeURIComponent(USER)}`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  return page.getByPlaceholder('Paste video URL...');
}

test('only a complete-looking link is worth resolving', () => {
  expect(looksLikeUrl('https://youtu.be/abc')).toBe(true);
  expect(looksLikeUrl('  http://www.example.com/watch?v=1 ')).toBe(true);
  expect(looksLikeUrl('https://you')).toBe(false);
  expect(looksLikeUrl('https://youtu')).toBe(false);
  expect(looksLikeUrl('https://')).toBe(false);
  expect(looksLikeUrl('youtu.be/abc')).toBe(false);
  expect(looksLikeUrl('ftp://example.com/file')).toBe(false);
  expect(looksLikeUrl('https://youtu.be/a b')).toBe(false);
});

test('a pasted link is resolved before the click, and the click joins it', async ({ page }) => {
  await stubAdaptiveStream(page, PLAYING);
  // Slow enough that the click lands while the speculative resolve is still
  // in flight.
  const resolves: string[] = [];
  await page.route('**/api/resolve**', async (route) => {
    resolves.push(new URL(route.request().url()).searchParams.get('url') ?? '');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.fallback();
  });
  const input = await openRoom(page, 'speculative');

  // Half a link is not resolved.
  await input.fill('https://youtu');
  await page.waitForTimeout(800);
  expect(resolves).toEqual([]);

  await input.fill(PLAYING);
  await expect.poll(() => resolves.length, { timeout: 5_000 }).toBe(1);
  await input.press('Enter');
  await expect(page.locator('video[data-stream-type="mse"]')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByText(/^Playing: Adaptive fixture/)).toBeVisible();
  expect(resolves).toEqual([PLAYING]);
});

test('a speculative resolve that fails says nothing until the click', async ({ page }) => {
  let failures = 0;
  await page.route('**/api/resolve**', (route) => {
    failures += 1;
    return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ detail: 'Unsupported URL' }) });
  });
  const input = await openRoom(page, 'speculative-fail');
  await input.fill(PLAYING);
  await expect.poll(() => failures, { timeout: 5_000 }).toBe(1);
  await page.waitForTimeout(300);
  await expect(page.getByText('Unsupported URL')).toHaveCount(0);

  // The click asks again — a failure is not kept — and reports it.
  await input.press('Enter');
  await expect(page.getByText('Unsupported URL')).toBeVisible();
  expect(failures).toBe(2);
});

test('queueing shows the link at once, then the video it resolved to', async ({ page }) => {
  await stubAdaptiveStream(page, PLAYING);
  const emulation = await emulateQueueResolution(page, { addedBy: USER, resolveMs: 1_500 });
  const input = await openRoom(page, 'pending');
  await input.fill(PLAYING);
  await input.press('Enter');
  const media = page.locator('video[data-stream-type="mse"]');
  await expect(media).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByText('Resolving...')).toHaveCount(0, { timeout: 15_000 });
  // Paused: the six-second fixture would otherwise end, and the room move
  // on, while the queue add is being watched.
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.readyState >= 2), { timeout: 20_000 }).toBe(true);
  await media.evaluate((v: HTMLVideoElement) => v.pause());
  await expect(page.getByText('Paused', { exact: true }).first()).toBeVisible();

  await input.fill(QUEUED);
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  // Sent as a bare link, and the box is free again straight away.
  expect(emulation.adds).toEqual([{ url: QUEUED }]);
  await expect(input).toHaveValue('');
  await expect(page.getByText('Adding to queue…')).toBeVisible();

  // The pending row: the link itself, resolving, nothing to pin yet — and
  // the playing video is not covered while it resolves.
  const pending = page.locator('[data-queue-pending]');
  await expect(pending).toHaveCount(1);
  await expect(pending).toContainText(QUEUED);
  await expect(pending.getByRole('status')).toHaveText('Resolving…');
  await expect(pending.getByRole('button', { name: /^Pin / })).toHaveCount(0);
  await expect(pending.getByRole('button', { name: `Remove ${QUEUED} from the queue` })).toBeVisible();
  await expect(page.getByText('Resolving...')).toHaveCount(0);

  // Replaced in place by the resolved entry.
  await expect(pending).toHaveCount(0, { timeout: 10_000 });
  // Both rows carry the adder; the header names who added the playing video.
  const rows = page.getByRole('link', { name: /open adaptive fixture on youtu\.be/i });
  await expect(rows).toHaveCount(3); // header + two queue rows
  await expect(page.locator('header').getByText(/added by/i)).toContainText('queue-ux');
  await expect(page.getByTitle(`Added by ${USER}`)).toHaveCount(3);
});

test('a link the server cannot resolve is taken back, and the sender told why', async ({ page }) => {
  await emulateQueueResolution(page, {
    addedBy: USER,
    resolveMs: 500,
    failWith: () => 'Video unavailable',
  });
  await page.route('**/api/resolve**', (route) => route.fulfill({ status: 400, body: '{}' }));
  const input = await openRoom(page, 'failed');
  await input.fill(QUEUED);
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  await expect(page.locator('[data-queue-pending]')).toHaveCount(1);

  await expect(page.getByText('Could not add to the queue: Video unavailable')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-queue-pending]')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Queue (0)', exact: true })).toBeVisible();
});
