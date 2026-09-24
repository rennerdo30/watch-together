import { test, expect } from '@playwright/test';

import {
  clearJumpCache, fetchJumpDestination, installJumpCache, jumpCacheSize, storeSpan, takeSpan,
} from '../lib/jump-cache';
import { JUMP_CACHE_MAX_BYTES, JUMP_CACHE_TTL_MS } from '../lib/constants';
import { FIXTURE_VIDEO_URL, stubAdaptiveStream } from './adaptive-fixture';

/**
 * The destination of an announced SponsorBlock skip, fetched into the page.
 *
 * Warming the server's cache for a skip still left every viewer a round trip
 * to the server — Japan to Germany — after the jump, because the player's
 * buffer ended where the sponsor began. The server now announces the skip
 * (`skip_upcoming`), the player fetches the exact requests it will make on
 * the far side, and a Shaka networking plugin answers them from memory.
 */

const URI = 'http://localhost:3100/api/proxy?url=https%3A%2F%2Fcdn.test%2Fv.mp4';
const bytes = (n: number) => new Uint8Array(n).fill(7).buffer;

test.beforeEach(() => clearJumpCache());

test('only a request for exactly a stored span is answered, once', () => {
  storeSpan(URI, 100, 199, bytes(100), { 'content-type': 'video/mp4' });
  expect(takeSpan(URI, 'bytes=100-198')).toBeNull();
  expect(takeSpan(URI + 'x', 'bytes=100-199')).toBeNull();
  expect(takeSpan(URI, undefined)).toBeNull();
  const hit = takeSpan(URI, 'bytes=100-199');
  expect(hit?.data.byteLength).toBe(100);
  // A jump's bytes are wanted once; after that the player's buffer has them.
  expect(takeSpan(URI, 'bytes=100-199')).toBeNull();
});

test('a body that is not the whole span is never stored', () => {
  storeSpan(URI, 0, 99, bytes(60), {});
  expect(jumpCacheSize().entries).toBe(0);
});

test('the cache is bounded in bytes and in time', () => {
  const big = Math.floor(JUMP_CACHE_MAX_BYTES / 3);
  for (let i = 0; i < 4; i++) storeSpan(URI, i * big, (i + 1) * big - 1, bytes(big), {}, 1_000);
  expect(jumpCacheSize().bytes).toBeLessThanOrEqual(JUMP_CACHE_MAX_BYTES);
  expect(takeSpan(URI, `bytes=0-${big - 1}`, 1_000)).toBeNull(); // The oldest went first.
  storeSpan(URI, 5, 9, bytes(5), {}, 1_000);
  expect(takeSpan(URI, 'bytes=5-9', 1_000 + JUMP_CACHE_TTL_MS + 1)).toBeNull();
});

test('a destination is fetched as described, span by span', async () => {
  const requested: { url: string; range?: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const range = (init?.headers as Record<string, string> | undefined)?.Range;
    requested.push({ url, range });
    if (url.includes('/api/segment-spans')) {
      return new Response(JSON.stringify({ spans: [{ uri: URI, start: 10, end: 19 }] }), { status: 200 });
    }
    return new Response(bytes(10), { status: 206, headers: { 'content-type': 'video/mp4' } });
  }) as typeof fetch;
  try {
    expect(await fetchJumpDestination('https://youtu.be/x', 130, 1080, 'av01')).toBe(1);
  } finally {
    globalThis.fetch = realFetch;
  }
  const described = new URL(requested[0].url, 'http://localhost');
  expect(described.pathname).toBe('/api/segment-spans');
  expect(Object.fromEntries(described.searchParams)).toMatchObject({ url: 'https://youtu.be/x', t: '130', h: '1080', codec: 'av01' });
  expect(requested[1]).toEqual({ url: URI, range: 'bytes=10-19' });
  expect(takeSpan(URI, 'bytes=10-19')).not.toBeNull();
});

test('the Shaka plugin answers a stored span from memory and passes everything else on', () => {
  const registered: { scheme: string; priority?: number }[] = [];
  let plugin: ((...args: unknown[]) => unknown) | null = null;
  const delegated: string[] = [];
  const shaka = {
    net: {
      NetworkingEngine: {
        registerScheme(scheme: string, fn: (...args: unknown[]) => unknown, priority?: number) {
          registered.push({ scheme, priority });
          plugin = fn;
        },
        RequestType: { SEGMENT: 1 },
        PluginPriority: { APPLICATION: 3 },
      },
      HttpFetchPlugin: {
        parse(uri: string) { delegated.push(uri); return 'network'; },
      },
    },
    util: { AbortableOperation: { completed: (value: unknown) => ({ completed: value }) } },
  };
  installJumpCache(shaka);
  expect(registered).toEqual([{ scheme: 'http', priority: 3 }, { scheme: 'https', priority: 3 }]);

  storeSpan(URI, 0, 9, bytes(10), { 'content-type': 'video/mp4' });
  const hit = plugin!(URI, { headers: { Range: 'bytes=0-9' } }, 1) as { completed: { fromCache: boolean; status: number } };
  // Kept out of the bandwidth estimate: an instant answer says nothing about the link.
  expect(hit.completed).toMatchObject({ fromCache: true, status: 206 });
  expect(plugin!(URI, { headers: { Range: 'bytes=0-9' } }, 1)).toBe('network');
  expect(plugin!(URI, { headers: {} }, 0)).toBe('network');
  expect(delegated).toEqual([URI, URI]);
});

// ── In the room: the announcement reaches the player ─────────────────────────

const ORIGINAL_URL = 'https://youtu.be/jump-cache-fixture';
// The fixture's last video subsegment starts at 4 s: bytes 28318-41435.
const LAST_VIDEO_SUBSEGMENT = 'bytes=28318-41435';

async function playWithAnnouncements(page: import('@playwright/test').Page, announceAt: number) {
  await stubAdaptiveStream(page, ORIGINAL_URL);
  // Hold the last subsegment back, so the buffer stops short of the
  // destination the way it stops at a sponsor's start in a real video.
  await page.route('**/api/proxy**', (route) =>
    route.request().headers().range === LAST_VIDEO_SUBSEGMENT ? undefined : route.fallback());
  const asked: URL[] = [];
  await page.route('**/api/segment-spans**', (route) => {
    asked.push(new URL(route.request().url()));
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"spans":[]}' });
  });
  let announce: (() => void) | null = null;
  await page.routeWebSocket(/\/ws\/e2e-jump/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => ws.send(message));
    ws.onMessage((message) => server.send(message));
    announce = () => ws.send(JSON.stringify({
      type: 'skip_upcoming', payload: { video_url: ORIGINAL_URL, at: 0.5, to: announceAt },
    }));
  });
  await page.goto(`/room/e2e-jump-${Date.now().toString(36)}?user=jump@example.com`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  await page.getByPlaceholder('Paste video URL...').fill(ORIGINAL_URL);
  await page.getByPlaceholder('Paste video URL...').press('Enter');
  const media = page.locator('video[data-stream-type="mse"]');
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) =>
    v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0), { timeout: 20_000 }).toBeGreaterThan(3.5);
  announce!();
  return asked;
}

test('an announced skip past the buffer fetches its destination on the playing rung', async ({ page }) => {
  const asked = await playWithAnnouncements(page, 4.5);
  await expect.poll(() => asked.length, { timeout: 10_000 }).toBe(1);
  expect(Object.fromEntries(asked[0].searchParams)).toMatchObject({
    url: ORIGINAL_URL, t: '4.5', h: '240', codec: 'avc1',
  });
});

test('a skip whose destination is already buffered fetches nothing', async ({ page }) => {
  const asked = await playWithAnnouncements(page, 1.5);
  await page.waitForTimeout(1_500);
  expect(asked).toEqual([]);
});

test('the player plays the jump destination from the page, not the network', async ({ page }) => {
  // The buffer stops short of the destination, as it does before a long
  // sponsor: the player's first request for it is never answered. The skip
  // is announced, the page fetches the destination, and the room jumps.
  // The player's request after the jump must be answered from the page
  // cache — the network sees only the stalled request and the prefetch.
  const DESTINATION_VIDEO = { start: 28318, end: 41435 };
  const destination = `bytes=${DESTINATION_VIDEO.start}-${DESTINATION_VIDEO.end}`;
  await stubAdaptiveStream(page, ORIGINAL_URL);
  let destinationRequests = 0;
  await page.route('**/api/proxy**', async (route) => {
    if (route.request().headers().range === destination && ++destinationRequests === 1) {
      return; // Never answered: the buffer ends here.
    }
    return route.fallback();
  });
  await page.route('**/api/segment-spans**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ spans: [{
      // The fixture manifest's BaseURL for the video (buildManifest's proxy base).
      uri: `http://localhost:3100/api/proxy?url=${encodeURIComponent(FIXTURE_VIDEO_URL)}`,
      ...DESTINATION_VIDEO,
    }] }),
  }));
  const prefetched = page.waitForResponse((response) =>
    response.url().includes('/api/proxy') && response.request().headers().range === destination);
  let announce: (() => void) | null = null;
  await page.routeWebSocket(/\/ws\/e2e-jump/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => ws.send(message));
    ws.onMessage((message) => server.send(message));
    announce = () => ws.send(JSON.stringify({
      type: 'skip_upcoming', payload: { video_url: ORIGINAL_URL, at: 1, to: 4.5 },
    }));
  });
  await page.goto(`/room/e2e-jump-${Date.now().toString(36)}?user=jump@example.com`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  await page.getByPlaceholder('Paste video URL...').fill(ORIGINAL_URL);
  await page.getByPlaceholder('Paste video URL...').press('Enter');
  const media = page.locator('video[data-stream-type="mse"]');
  await expect.poll(() => destinationRequests, { timeout: 20_000 }).toBe(1);

  announce!();
  await prefetched;
  expect(destinationRequests).toBe(2);

  await media.evaluate((v: HTMLVideoElement) => { v.currentTime = 4.5; });
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) =>
    Array.from({ length: v.buffered.length }, (_, i) => v.buffered.end(i)).some((end) => end > 5.5)),
    { timeout: 20_000 }).toBe(true);
  expect(destinationRequests, 'the jump went to the network').toBe(2);
});
