import { test, expect, type Page } from '@playwright/test';

import { resumePosition } from '../lib/playback';
import { buildManifest, stubAdaptiveStream, type VideoRung } from './adaptive-fixture';

/**
 * One player across videos, and the next one preloaded.
 *
 * Every video used to remount the player, which destroyed the Shaka
 * instance and with it everything a queue advance could have had ready. The
 * advance then paid for the manifest, the segment index, the initialisation
 * segment and the first media segment one after another — four round trips
 * to a server in Germany from viewers in Japan — while the room watched a
 * spinner. Now the player stays, preloads the next entry while the current
 * one finishes, and an advance to it starts from bytes already in the page.
 */

const USER = 'preload@example.com';
const FIRST = 'https://youtu.be/preload-first';
const SECOND = 'https://youtu.be/preload-second';
/** Generous for a local fixture already in the page; "well under a second". */
const PRELOADED_FIRST_FRAME_BOUND_MS = 1_000;

/** The first media byte of each fixture file: below it is init and index. */
function firstMediaBytes(): Map<string, number> {
  const manifest = buildManifest();
  const bytes = new Map<string, number>();
  for (const match of manifest.matchAll(/<BaseURL>([^<]+)<\/BaseURL>\s*<SegmentBase indexRange="\d+-(\d+)"/g)) {
    const target = new URL(match[1].replace(/&amp;/g, '&')).searchParams.get('url') ?? '';
    bytes.set(target, Number(match[2]) + 1);
  }
  return bytes;
}

/** Page-side clocks for the moments the test compares. */
async function recordStartMoments(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __setVideoAt: Record<string, number>; __loadedDataAt: number[] };
    w.__setVideoAt = {};
    w.__loadedDataAt = [];
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener('message', (event) => {
          try {
            const message = JSON.parse(String(event.data));
            const original = message?.payload?.video_data?.original_url;
            if (message.type === 'set_video' && original) w.__setVideoAt[original] = performance.now();
          } catch {
            // Not a room message.
          }
        });
      }
    };
    document.addEventListener('loadeddata', () => w.__loadedDataAt.push(performance.now()), true);
  });
}

async function openRoom(page: Page, label: string, ladder?: VideoRung[]) {
  const manifestRequests = await stubAdaptiveStream(page, FIRST, ladder);
  await page.goto(`/room/e2e-preload-${label}-${Date.now().toString(36)}?user=${encodeURIComponent(USER)}`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  return manifestRequests;
}

async function loadNow(page: Page, url: string) {
  const input = page.getByPlaceholder('Paste video URL...');
  await input.fill(url);
  await input.press('Enter');
  await expect(input).toHaveValue('', { timeout: 15_000 });
  const media = page.locator('video[data-stream-type="mse"]');
  await expect(media).toHaveCount(1, { timeout: 15_000 });
  return media;
}

test('a queued entry resumes where the server will resume it', () => {
  // The preload has to be of the position the server announces, so this
  // mirrors ConnectionManager._resume_position exactly.
  expect(resumePosition({ progress: 42, duration: 600 })).toBe(42);
  expect(resumePosition({ progress: 4.9, duration: 600 })).toBe(0);
  expect(resumePosition({ progress: 590, duration: 600 })).toBe(0);
  expect(resumePosition({ progress: 42, duration: 600, is_live: true })).toBe(0);
  expect(resumePosition({ progress: Number.NaN })).toBe(0);
  expect(resumePosition({ progress: 42 })).toBe(42);
  expect(resumePosition(undefined)).toBe(0);
});

test('an advance to a preloaded entry fetches nothing it already has', async ({ page }) => {
  test.setTimeout(60_000);
  await recordStartMoments(page);
  const mediaStart = firstMediaBytes();

  // Node-side log of what the page fetched, and when the advance arrived.
  // SECOND is announced twice: when it is loaded by hand, and when the
  // room advances to it.
  let advancedAt: number | null = null;
  let secondAnnounced = 0;
  const fetched: { at: number; url: string; range: string }[] = [];
  page.on('websocket', (socket) => socket.on('framereceived', (frame) => {
    const text = typeof frame.payload === 'string' ? frame.payload : frame.payload.toString();
    if (!text.includes('"set_video"') || !text.includes(SECOND)) return;
    secondAnnounced += 1;
    if (secondAnnounced === 2) advancedAt = Date.now();
  }));
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/api/dash-manifest') || url.includes('/api/proxy')) {
      fetched.push({ at: Date.now(), url, range: request.headers().range ?? '' });
    }
  });

  const manifestRequests = await openRoom(page, 'advance');

  // SECOND first, then FIRST: the room plays FIRST with SECOND queued behind
  // it, both carrying the resolve the server was given.
  const media = await loadNow(page, SECOND);
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.readyState >= 2), { timeout: 20_000 }).toBe(true);
  // Marked so the advance can be shown to keep the element, not replace it.
  await media.evaluate((v: HTMLVideoElement) => { v.dataset.preloadTestInstance = 'kept'; });
  await loadNow(page, FIRST);

  // The six-second fixture is inside the preparation window from the start,
  // so SECOND is preloaded as soon as FIRST is up: its manifest asked for
  // again, by the preload.
  const asksForSecond = () => manifestRequests.filter(
    (url) => new URL(url).searchParams.get('url') === SECOND).length;
  await expect.poll(asksForSecond, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);

  // FIRST plays to its end and the room advances to SECOND.
  await expect.poll(() => advancedAt, { timeout: 30_000 }).not.toBeNull();
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.readyState >= 2 && !v.paused),
    { timeout: 15_000 }).toBe(true);
  await page.waitForTimeout(1_000);

  // Nothing the preload fetched is fetched again: no manifest, and no
  // initialisation segment or index — only media past them.
  const afterAdvance = fetched.filter((entry) => entry.at >= advancedAt!);
  expect(afterAdvance.filter((entry) => entry.url.includes('/api/dash-manifest'))).toEqual([]);
  for (const entry of afterAdvance) {
    const target = new URL(entry.url).searchParams.get('url') ?? '';
    const start = Number(/^bytes=(\d+)-/.exec(entry.range)?.[1] ?? 0);
    expect(start, `${target} ${entry.range}`).toBeGreaterThanOrEqual(mediaStart.get(target) ?? Infinity);
  }

  // The same element, and a first frame well within the bound.
  expect(await media.evaluate((v: HTMLVideoElement) => v.dataset.preloadTestInstance)).toBe('kept');
  const firstFrameMs = await page.evaluate((second) => {
    const w = window as unknown as { __setVideoAt: Record<string, number>; __loadedDataAt: number[] };
    const at = w.__setVideoAt[second];
    const frame = w.__loadedDataAt.find((t) => t >= at);
    return frame === undefined ? null : frame - at;
  }, SECOND);
  expect(firstFrameMs).not.toBeNull();
  expect(firstFrameMs!).toBeLessThan(PRELOADED_FIRST_FRAME_BOUND_MS);
});

test('what one video left behind does not reach the next', async ({ page }) => {
  const TALL: VideoRung[] = [
    { id: 'v-240', height: 240, tbr: 50 },
    { id: 'v-720', height: 720, tbr: 100 },
    { id: 'v-1080', height: 1080, tbr: 200 },
  ];
  const SHORT: VideoRung[] = [
    { id: 's-240', height: 240, tbr: 50 },
    { id: 's-360', height: 360, tbr: 80 },
  ];
  const BROKEN = 'https://youtu.be/preload-broken';
  await openRoom(page, 'leak', TALL);
  // SECOND has its own, shorter ladder; BROKEN's manifest cannot be built.
  const shortManifest = buildManifest(undefined, SHORT);
  await page.route('**/api/dash-manifest**', (route) => {
    const original = new URL(route.request().url()).searchParams.get('url');
    if (original === BROKEN) return route.fulfill({ status: 502, body: 'upstream failed' });
    if (original === SECOND) {
      return route.fulfill({
        status: 200, contentType: 'application/dash+xml',
        headers: { 'Access-Control-Allow-Origin': '*' }, body: shortManifest,
      });
    }
    return route.fallback();
  });

  const settings = page.getByRole('button', { name: 'Quality and sync settings' });
  const media = await loadNow(page, FIRST);
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.readyState >= 2), { timeout: 20_000 }).toBe(true);
  await media.evaluate((v: HTMLVideoElement) => v.pause());
  await page.mouse.move(300, 120);
  await settings.click();
  await expect(page.getByRole('button', { name: /^1080p/ })).toBeVisible();
  await settings.click();

  await loadNow(page, BROKEN);
  await expect(page.getByRole('alert').filter({ hasText: 'Playback Issue' })).toBeVisible({ timeout: 15_000 });

  await loadNow(page, SECOND);
  // The error was BROKEN's; SECOND plays, on the same element.
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.readyState >= 2), { timeout: 20_000 }).toBe(true);
  await expect(page.getByRole('alert').filter({ hasText: 'Playback Issue' })).toHaveCount(0);
  // And its quality list is its own.
  await page.mouse.move(300, 120);
  await settings.click();
  await expect(page.getByRole('button', { name: /^360p/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^1080p/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^720p/ })).toHaveCount(0);
});
