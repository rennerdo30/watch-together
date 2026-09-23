import { test, expect, type Page } from '@playwright/test';

import { stubAdaptiveStream, type VideoRung } from './adaptive-fixture';
import { emulateQueueResolution } from './queue-emulation';

/**
 * Warming on intent.
 *
 * Every segment a viewer in Japan waits for crosses to Germany and on to the
 * CDN. The server can fetch the one about to be wanted a round trip or more
 * before the player asks — if it is told which: `GET /api/prewarm` names the
 * video, the position and the rung, and the server warms exactly those
 * bytes. It is asked right before a load, when the pointer rests on the seek
 * bar, and when it rests on a queue row. A pointer merely passing over asks
 * nothing.
 */

const USER = 'intent@example.com';
const FIRST = 'https://youtu.be/intent-first';
const SECOND = 'https://youtu.be/intent-second';
// Cheap rungs: the default opening estimate affords all of them, so the
// rung expected is the cap's (1080 for this viewport's player).
const LADDER: VideoRung[] = [
  { id: 'v-720', height: 720, tbr: 100 },
  { id: 'v-1080', height: 1080, tbr: 200 },
  { id: 'v-2160', height: 2160, tbr: 300 },
];

interface Logged { kind: 'prewarm' | 'manifest'; params: URLSearchParams }

async function openRoom(page: Page, label: string, resolveExtras: Record<string, unknown> = {}) {
  await stubAdaptiveStream(page, FIRST, LADDER, resolveExtras);
  const log: Logged[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/dash-manifest') log.push({ kind: 'manifest', params: url.searchParams });
  });
  await page.route('**/api/prewarm**', (route) => {
    log.push({ kind: 'prewarm', params: new URL(route.request().url()).searchParams });
    return route.fulfill({ status: 202, contentType: 'application/json', body: '{"status":"accepted"}' });
  });
  await page.goto(`/room/e2e-intent-${label}-${Date.now().toString(36)}?user=${encodeURIComponent(USER)}`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  return log;
}

async function playFirstAndPause(page: Page) {
  const input = page.getByPlaceholder('Paste video URL...');
  await input.fill(FIRST);
  await input.press('Enter');
  const media = page.locator('video[data-stream-type="mse"]');
  await expect(media).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.readyState >= 2), { timeout: 20_000 }).toBe(true);
  await media.evaluate((v: HTMLVideoElement) => v.pause());
  await expect(page.getByText('Paused', { exact: true }).first()).toBeVisible();
  return media;
}

const prewarms = (log: Logged[], original: string) =>
  log.filter((entry) => entry.kind === 'prewarm' && entry.params.get('url') === original);

test('the start of a video is warmed before its manifest is asked for', async ({ page }) => {
  const log = await openRoom(page, 'load');
  await playFirstAndPause(page);

  const firstManifest = log.findIndex((entry) => entry.kind === 'manifest' && entry.params.get('url') === FIRST);
  const firstPrewarm = log.findIndex((entry) => entry.kind === 'prewarm' && entry.params.get('url') === FIRST);
  expect(firstPrewarm).toBeGreaterThanOrEqual(0);
  expect(firstPrewarm).toBeLessThan(firstManifest);
  const params = log[firstPrewarm].params;
  expect(params.get('room')).toMatch(/^e2e-intent-load-/);
  expect(params.get('t')).toBe('0');
  expect(params.get('h')).toBe('1080');
  // Chromium decodes the fixture's H.264, the only family on its ladder.
  expect(params.get('codec')).toBe('avc1');
});

test('a pointer resting on the seek bar warms that position; one passing over does not', async ({ page }) => {
  const log = await openRoom(page, 'seekbar');
  await playFirstAndPause(page);
  await page.getByRole('button', { name: 'Playback statistics' }).click();
  const quality = page.getByText('Quality', { exact: true }).locator('..');
  await expect(quality).toContainText(/auto \(\d+p\)/);
  const rung = /auto \((\d+)p\)/.exec((await quality.textContent()) ?? '')![1];

  const seek = page.getByLabel('Seek');
  const box = await seek.boundingBox();
  if (!box) throw new Error('no seek bar');
  const y = box.y + box.height / 2;
  const before = prewarms(log, FIRST).length;

  // Across the bar and off it again, well inside the rest delay.
  await page.mouse.move(box.x + 5, y);
  await page.mouse.move(box.x + box.width * 0.3, y, { steps: 3 });
  await page.mouse.move(box.x + box.width * 0.9, y, { steps: 3 });
  await page.mouse.move(box.x + box.width * 0.5, box.y - 150);
  await page.waitForTimeout(700);
  expect(prewarms(log, FIRST).length).toBe(before);

  // Resting half way along the six-second clip: three seconds in.
  await page.mouse.move(box.x + box.width / 2, y);
  await expect.poll(() => prewarms(log, FIRST).length, { timeout: 3_000 }).toBe(before + 1);
  const params = prewarms(log, FIRST).at(-1)!.params;
  expect(params.get('t')).toBe('3');
  expect(params.get('h')).toBe(rung);
  expect(params.get('codec')).toBe('avc1');
});

test('a pointer resting on a queue row warms where that entry would start', async ({ page }) => {
  await emulateQueueResolution(page, { addedBy: USER, resolveMs: 100 });
  // FIRST claims to be long, so the room is nowhere near its end and the
  // player does not preload SECOND: only the hover can ask about it.
  const log = await openRoom(page, 'queue', { duration: 600 });
  await playFirstAndPause(page);
  const input = page.getByPlaceholder('Paste video URL...');
  await input.fill(SECOND);
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  // The queued row, once the server has resolved it.
  const row = page.locator('[aria-roledescription="sortable"]').nth(1);
  await expect(row).toContainText('Adaptive fixture');
  await page.waitForTimeout(500);
  expect(prewarms(log, SECOND)).toHaveLength(0);

  // Passing over the row on the way somewhere else.
  await row.hover();
  await page.mouse.move(10, 10);
  await page.waitForTimeout(600);
  expect(prewarms(log, SECOND)).toHaveLength(0);

  await row.hover();
  await expect.poll(() => prewarms(log, SECOND).length, { timeout: 3_000 }).toBe(1);
  const params = prewarms(log, SECOND)[0].params;
  expect(params.get('t')).toBe('0');
  // SECOND's ladder, as its resolve described it, has a single 240p rung.
  expect(params.get('h')).toBe('240');
  expect(params.get('codec')).toBe('avc1');
});
