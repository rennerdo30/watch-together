import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import Hls, { type LevelDetails } from 'hls.js';

import { HLS_RETRY_BUDGET_REFILL_MS, LIVE_SYNC_MAX_PLAYBACK_RATE } from '../lib/constants';
import { edgeWaitingStreamController, isWaitingAtLiveEdge } from '../lib/live-edge';
import { isLiveCatchUpRate } from '../lib/live-latency';
import { RetryBudget } from '../lib/retry-budget';

/**
 * A live stream whose playlist is late waits for it.
 *
 * Twitch's playlist stops advancing whenever a streamer's upload hiccups.
 * With the player 6s behind the edge, a pause longer than that runs the
 * playhead into the end of the buffer — a few milliseconds past the
 * playlist's edge — and hls.js took that for a playhead outside the window
 * and sent it back 6s. The viewer saw the same six seconds again, stalled at
 * the same place, and was sent back again for as long as the playlist stayed
 * late: a buffering loop. Twelve seconds in, the stall recovery reloaded the
 * stream (another replay) and spent one of three retries that nothing ever
 * gave back, so the fourth hiccup of the evening was "Playback failed".
 */

const FIXTURE = path.resolve(__dirname, 'fixtures/live-vp9');
const INIT = readFileSync(path.join(FIXTURE, 'init.mp4'));
const SEGMENT = readFileSync(path.join(FIXTURE, 'segment.m4s'));
const SEGMENT_SECONDS = 2;
const TIMESCALE = 15360;
const WINDOW_SEGMENTS = 15;

/** The fixture's one segment, re-timed to be segment `sequence` of the stream. */
function segment(sequence: number): Buffer {
  const bytes = Buffer.from(SEGMENT);
  const tfdt = bytes.indexOf('tfdt');
  // Version 1: the decode time is the 64-bit field after version and flags.
  bytes.writeBigUInt64BE(BigInt(sequence * SEGMENT_SECONDS * TIMESCALE), tfdt + 8);
  return bytes;
}

/**
 * A Twitch-shaped live stream: 2s segments, a declared target of 6, fifteen
 * segments in the window. The edge follows the wall clock until `freeze()`;
 * `failPlaylist()` answers the media playlist with 404 until `restore()`.
 *
 * hls.js re-times every segment it parses, so here the end of the media
 * meets the playlist's edge exactly and the playhead stops on it, not past
 * it: this stream pins the stall handling at the edge. Past the edge — where
 * hls.js seeks back — is pinned against hls.js itself further down.
 */
async function openLiveStream(page: Page) {
  const base = 'http://localhost:3100/live-edge-fixture';
  const original = 'https://www.twitch.tv/live-edge-fixture';
  const startedAt = Date.now() - 40_000;
  let frozenAt: number | null = null;
  let failingPlaylist = false;
  let fatalErrors = 0;
  page.on('console', (message) => {
    if (message.text().startsWith('[HLS] Fatal error')) fatalErrors++;
  });
  const edgeSequence = () => Math.floor(((frozenAt ?? Date.now()) - startedAt) / 1000 / SEGMENT_SECONDS);

  const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="180p30 (source)",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=320x180,CODECS="vp09.00.10.08",VIDEO="chunked",FRAME-RATE=30.000
${base}/playlist.m3u8
`;
  const playlist = () => {
    const edge = edgeSequence();
    const first = Math.max(0, edge - WINDOW_SEGMENTS + 1);
    const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:6',
      `#EXT-X-MEDIA-SEQUENCE:${first}`, `#EXT-X-MAP:URI="${base}/init.mp4"`];
    for (let sequence = first; sequence <= edge; sequence++) {
      lines.push('#EXTINF:1.990,live', `${base}/segment/${sequence}.m4s`);
    }
    lines.push(`#EXT-X-TWITCH-PREFETCH:${base}/segment/${edge + 1}.m4s`);
    return `${lines.join('\n')}\n`;
  };

  await page.addInitScript(() => {
    const log: Array<{ type: string; time: number }> = [];
    Object.assign(window, { liveEdgeLog: log });
    for (const type of ['seeking', 'emptied']) {
      document.addEventListener(type, (event) => {
        log.push({ type, time: (event.target as HTMLVideoElement).currentTime });
      }, true);
    }
  });
  await page.route('**/api/resolve**', (route) => route.fulfill({ json: {
    original_url: original, stream_url: `${base}/master.m3u8`, stream_type: 'hls',
    title: 'A late Twitch playlist', duration: null, is_live: true, available_qualities: [],
  } }));
  const serve: Parameters<typeof page.route>[1] = (route) => {
    const request = new URL(route.request().url());
    const url = request.searchParams.get('url') ?? request.href;
    if (url.endsWith('/init.mp4')) return route.fulfill({ contentType: 'video/mp4', body: INIT });
    const media = url.match(/\/segment\/(\d+)\.m4s$/);
    if (media) return route.fulfill({ contentType: 'video/mp4', body: segment(Number(media[1])) });
    if (failingPlaylist && url.endsWith('/playlist.m3u8')) return route.fulfill({ status: 404, body: 'Not found' });
    return route.fulfill({
      contentType: 'application/vnd.apple.mpegurl',
      body: url.endsWith('/master.m3u8') ? master : playlist(),
    });
  };
  await page.route('**/live-edge-fixture/**', serve);
  await page.route('**/api/proxy**', serve);

  await page.goto(`/room/e2e-live-edge-wait-${Date.now().toString(36)}?user=live-edge-wait@example.com`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible();
  await page.getByPlaceholder('Paste video URL...').fill(original);
  await page.getByPlaceholder('Paste video URL...').press('Enter');

  const media = page.locator('video');
  return {
    media,
    freeze: () => { frozenAt = Date.now(); },
    resume: () => { frozenAt = null; },
    failPlaylist: () => { failingPlaylist = true; },
    restore: () => { failingPlaylist = false; },
    fatalErrors: () => fatalErrors,
    log: () => page.evaluate(() =>
      (window as unknown as { liveEdgeLog: Array<{ type: string; time: number }> }).liveEdgeLog.splice(0)),
    currentTime: () => media.evaluate((v: HTMLVideoElement) => v.currentTime),
  };
}

test('a playhead that catches up with a late live playlist waits instead of replaying', async ({ page }) => {
  test.setTimeout(60_000);
  const stream = await openLiveStream(page);
  await expect.poll(stream.currentTime, { timeout: 15_000 }).toBeGreaterThan(0);

  stream.freeze();
  // Play out the 6s cushion until the playhead stops at the end of the media.
  let stalledAt = -1;
  await expect.poll(async () => {
    const before = await stream.currentTime();
    await page.waitForTimeout(1_000);
    const after = await stream.currentTime();
    stalledAt = after;
    return after - before;
  }, { timeout: 20_000 }).toBeLessThan(0.05);
  stream.log();

  // Long enough for every playlist refresh to have sent it back again, and
  // past the 12s at which an ordinary stall reloads the stream.
  await page.waitForTimeout(14_000);
  const duringFreeze = await stream.log();
  expect(duringFreeze.filter((event) => event.type === 'seeking' && event.time < stalledAt - 1)).toEqual([]);
  expect(duringFreeze.filter((event) => event.type === 'emptied')).toEqual([]);
  expect(await stream.currentTime()).toBeGreaterThan(stalledAt - 0.1);

  // When the playlist moves again, so does the picture.
  stream.resume();
  await expect.poll(stream.currentTime, { timeout: 15_000 }).toBeGreaterThan(stalledAt + 1);
  await expect(page.getByRole('alert').filter({ hasText: 'Playback Issue' })).toHaveCount(0);
});

test('separate recovered failures across a long live stream never add up to "Playback failed"', async ({ page }) => {
  // Four fatal playlist errors, each recovered, each after a clean stretch
  // long enough to refill the budget. Three retries that were never given
  // back made the fourth fatal. (A recovery that never stalls playback at
  // all is pinned by the RetryBudget tests below.)
  const failures = 4;
  test.setTimeout(failures * (HLS_RETRY_BUDGET_REFILL_MS + 15_000) + 30_000);
  const stream = await openLiveStream(page);
  await expect.poll(stream.currentTime, { timeout: 15_000 }).toBeGreaterThan(0);

  for (let failure = 1; failure <= failures; failure++) {
    stream.failPlaylist();
    await expect.poll(stream.fatalErrors, { timeout: 15_000 }).toBeGreaterThanOrEqual(failure);
    stream.restore();
    const at = await stream.currentTime();
    await expect.poll(stream.currentTime, { timeout: 15_000 }).toBeGreaterThan(at + 1);
    await expect(page.getByRole('alert').filter({ hasText: 'Playback Issue' })).toHaveCount(0);
    if (failure < failures) await page.waitForTimeout(HLS_RETRY_BUDGET_REFILL_MS + 2_000);
  }
  const at = await stream.currentTime();
  await expect.poll(stream.currentTime, { timeout: 15_000 }).toBeGreaterThan(at + 1);
  await expect(page.getByRole('alert').filter({ hasText: 'Playback Issue' })).toHaveCount(0);
});

/**
 * `synchronizeToLiveEdge` as hls.js runs it on every playlist refresh, for a
 * playlist whose edge is at 30 s and a playhead at `position` with `buffered`
 * media. Returns where the playhead is afterwards.
 */
function synchronizeAt(controller: typeof Hls.DefaultConfig.streamController, position: number, buffered: [number, number]) {
  const details = { live: true, fragmentStart: 0, edge: 30, targetduration: 6 } as unknown as LevelDetails;
  const media = {
    currentTime: position,
    duration: Infinity,
    readyState: 2,
    buffered: { length: 1, start: () => buffered[0], end: () => buffered[1] },
  };
  const self = Object.assign(Object.create(controller.prototype), {
    media,
    config: Hls.DefaultConfig,
    hls: { hasEnoughToStart: true, liveSyncPosition: 24 },
    _hasEnoughToStart: true,
    warn: () => {},
  }) as { synchronizeToLiveEdge(details: LevelDetails): void };
  self.synchronizeToLiveEdge(details);
  return media.currentTime;
}

test('hls.js sends a playhead just past the live edge back; the edge-waiting controller does not', () => {
  const Stock = Hls.DefaultConfig.streamController;
  // The private method the override replaces must exist in the installed
  // hls.js; an upgrade that renames it fails here, not in a viewer's browser.
  expect(typeof (Stock.prototype as unknown as Record<string, unknown>).synchronizeToLiveEdge).toBe('function');
  // The replay loop, in hls.js itself: 16 ms past the edge is "outside the
  // window", and it seeks back to the sync position 6 s behind.
  expect(synchronizeAt(Stock, 30.016, [0, 30.016])).toBe(24);

  const Waiting = edgeWaitingStreamController();
  expect(Waiting).not.toBe(Stock);
  // Waiting at the end of the media just past the edge: left to wait.
  expect(synchronizeAt(Waiting, 30.016, [0, 30.016])).toBe(30.016);
  // Lost in an unbuffered hole past the edge: hls.js still resyncs it.
  expect(synchronizeAt(Waiting, 31, [0, 30.016])).toBe(24);
});

test('an hls.js without the overridden method plays with its own controller and says so', () => {
  const Stock = Hls.DefaultConfig.streamController;
  const prototype = Stock.prototype as unknown as Record<string, unknown>;
  const original = prototype.synchronizeToLiveEdge;
  const warn = console.warn;
  const warnings: unknown[] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    prototype.synchronizeToLiveEdge = undefined;
    expect(edgeWaitingStreamController()).toBe(Stock);
    expect(warnings).toHaveLength(1);
  } finally {
    prototype.synchronizeToLiveEdge = original;
    console.warn = warn;
  }
});

test('waiting at the live edge is told apart from being lost', () => {
  const buffered: Array<[number, number]> = [[0, 30.016]];
  // Stalled at the end of the media, a hair past the playlist's edge.
  expect(isWaitingAtLiveEdge({ position: 30.016, edge: 30, targetDuration: 6, buffered })).toBe(true);
  // Stalled at the end of media that stops just short of the edge.
  expect(isWaitingAtLiveEdge({ position: 29.8, edge: 30, targetDuration: 6, buffered: [[0, 29.8]] })).toBe(true);
  // Playing with buffer ahead: not waiting for anything.
  expect(isWaitingAtLiveEdge({ position: 24, edge: 30, targetDuration: 6, buffered })).toBe(false);
  // Far past the edge (a timeline that jumped): hls.js must resync.
  expect(isWaitingAtLiveEdge({ position: 50, edge: 30, targetDuration: 6, buffered: [[0, 50]] })).toBe(false);
  // Past the edge in a hole with nothing buffered: hls.js must resync.
  expect(isWaitingAtLiveEdge({ position: 31, edge: 30, targetDuration: 6, buffered })).toBe(false);
});

test('the retry budget refills after clean playback and still runs out in a tight loop', () => {
  const budget = new RetryBudget(3, 30_000);
  // Three hiccups, each followed by a long stretch of clean playback.
  for (let hiccup = 0, now = 0; hiccup < 6; hiccup++) {
    expect(budget.spend()).toBe(true);
    budget.playing(now);
    now += 31_000;
    budget.progressed(now);
  }
  // A stream failing over and over never plays long enough to refill.
  const failing = new RetryBudget(3, 30_000);
  let now = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    expect(failing.spend()).toBe(true);
    failing.playing(now);
    now += 2_000;
    failing.progressed(now);
    failing.stalled();
  }
  expect(failing.spend()).toBe(false);
  // A new source starts whole.
  failing.reset();
  expect(failing.spend()).toBe(true);
});

test('the retry budget refills after a recovery that never stalled playback', () => {
  // A fatal playlist error recovered while the buffer still had seconds in
  // it: no `waiting`, no `playing`, only progress.
  const budget = new RetryBudget(3, 30_000);
  let now = 0;
  budget.playing(now);
  for (let hiccup = 0; hiccup < 6; hiccup++) {
    expect(budget.spend()).toBe(true);
    for (let tick = 0; tick <= 31; tick++) budget.progressed(now += 1_000);
  }
  // Progress during a stall (a seek inside it) does not count as clean.
  const stalled = new RetryBudget(1, 30_000);
  stalled.playing(0);
  expect(stalled.spend()).toBe(true);
  stalled.stalled();
  for (let at = 1_000; at <= 40_000; at += 1_000) stalled.progressed(at);
  expect(stalled.spend()).toBe(false);
});

test('the room heartbeat leaves hls.js catching up and undoes only position-sync rates', () => {
  // hls.js trims latency by playing up to LIVE_SYNC_MAX_PLAYBACK_RATE; the
  // heartbeat used to put every live stream back to 1x every five seconds.
  expect(isLiveCatchUpRate(1)).toBe(true);
  expect(isLiveCatchUpRate(LIVE_SYNC_MAX_PLAYBACK_RATE)).toBe(true);
  // Left over from position sync on a video before this one.
  expect(isLiveCatchUpRate(0.95)).toBe(false);
  expect(isLiveCatchUpRate(LIVE_SYNC_MAX_PLAYBACK_RATE + 0.05)).toBe(false);
  // hls.js's latency controller sets the rate on its own schedule, so a
  // browser cannot hold one in place for a heartbeat: the call site is
  // pinned in the source. The live branch of the heartbeat handler resets
  // the rate only behind isLiveCatchUpRate, and nowhere unconditionally.
  const source = readFileSync(path.resolve(__dirname, '../app/room/[id]/page.tsx'), 'utf8');
  const heartbeat = source.slice(source.indexOf("case 'heartbeat':"));
  const liveBranch = heartbeat.slice(heartbeat.indexOf('if (videoDataRef.current?.is_live)'), heartbeat.indexOf('} else if'));
  expect(liveBranch).toMatch(/if \(liveVideo && !isLiveCatchUpRate\(liveVideo\.playbackRate\)\) liveVideo\.playbackRate = 1(\.0)?;/);
  expect(liveBranch.match(/playbackRate = /g)).toHaveLength(1);
});
