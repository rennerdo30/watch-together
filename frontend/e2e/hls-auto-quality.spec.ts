import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { LIVE_SYNC_MIN_SECONDS } from '../lib/constants';
import { liveSyncTargetSeconds } from '../lib/live-latency';

/** The fragmented-MP4 fixture, split into its init segment and its media. */
function fmp4Fixture() {
  const bytes = readFileSync(path.resolve(__dirname, '../../backend/tests/fixtures/video.mp4'));
  let initEnd = 0;
  while (initEnd < bytes.length && bytes.toString('ascii', initEnd + 4, initEnd + 8) !== 'moof') {
    initEnd += bytes.readUInt32BE(initEnd);
  }
  return { init: bytes.subarray(0, initEnd), media: bytes.subarray(initEnd) };
}

async function openHls(page: Page, { failures = 0, expired = false, stalled = false, rejectFresh = false } = {}) {
  let masterRequests = 0;
  const fixture = fmp4Fixture();
  const base = 'http://localhost:3100/hls-fixture';
  const original = 'https://example.com/hls-auto-quality';
  const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=320x240,CODECS="avc1.42c015"
${base}/low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=450000,RESOLUTION=1440x1080,CODECS="avc1.42c015"
${base}/high.m3u8
`;
  let playlist = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="${base}/init.mp4"
#EXTINF:6,
${base}/segment.mp4
#EXT-X-ENDLIST
`;
  if (stalled) playlist = playlist.replace('#EXT-X-PLAYLIST-TYPE:VOD\n', '').replace('#EXT-X-ENDLIST\n', '');
  await page.addInitScript(() => {
    const remove = SourceBuffer.prototype.remove;
    Object.assign(window, { bufferRemovals: 0 });
    SourceBuffer.prototype.remove = function (start, end) {
      const state = window as unknown as { bufferRemovals: number };
      state.bufferRemovals++;
      return remove.call(this, start, end);
    };
  });
  await page.route('**/api/resolve**', route => route.fulfill({ json: {
    original_url: original, stream_url: `${base}/${expired && new URL(route.request().url()).searchParams.get('refresh') === 'true' ? 'fresh-master' : 'master'}.m3u8`, stream_type: 'hls',
    title: 'HLS auto fixture', duration: 6, is_live: failures > 0 || expired || stalled, available_qualities: [],
  } }));
  const serve: Parameters<typeof page.route>[1] = route => {
    const request = new URL(route.request().url());
    const url = request.searchParams.get('url') ?? request.href;
    if ((expired && url.endsWith('/master.m3u8')) || (rejectFresh && url.endsWith('/fresh-master.m3u8'))) return route.fulfill({ status: 403 });
    if (url.endsWith('/master.m3u8') && ++masterRequests <= failures) {
      return route.fulfill({ status: 404, body: 'Temporarily unavailable' });
    }
    if (url.endsWith('.mp4')) return route.fulfill({
      contentType: 'video/mp4', body: url.endsWith('/init.mp4') ? fixture.init : fixture.media,
    });
    return route.fulfill({ contentType: 'application/vnd.apple.mpegurl', body: url.endsWith('master.m3u8') ? master : playlist });
  };
  await page.route('**/hls-fixture/**', serve);
  await page.route('**/api/proxy**', serve);
  await page.goto(`/room/e2e-hls-auto-${Date.now().toString(36)}?user=hls-auto@example.com`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible();
  await page.getByPlaceholder('Paste video URL...').fill(original);
  await page.getByPlaceholder('Paste video URL...').press('Enter');
  return { media: page.locator('video'), requests: () => masterRequests };
}

test('HLS keeps Auto selected after adaptation and restores it without flushing playback', async ({ page }) => {
  const { media } = await openHls(page);
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThan(2);
  await media.evaluate((v: HTMLVideoElement) => v.pause());
  await page.getByRole('button', { name: 'Quality and sync settings' }).click();
  const auto = page.getByRole('button', { name: 'Auto', exact: true });
  await expect(auto).toHaveAttribute('aria-pressed', 'true');
  const manual = page.getByRole('button', { name: /240p/ });
  await manual.click();
  await expect(manual).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThan(2);
  const removals = () => page.evaluate(() => (window as unknown as { bufferRemovals: number }).bufferRemovals);
  const before = await removals();
  await auto.click();
  await expect(auto).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(500);
  expect(await removals()).toBe(before);
});


test('a failed live master playlist is reloaded and playback recovers without a sticky error', async ({ page }) => {
  const { media, requests } = await openHls(page, { failures: 1 });
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 15_000 }).toBeGreaterThan(0.2);
  expect(requests()).toBe(2);
  await expect(page.getByRole('alert').filter({ hasText: 'Playback Issue' })).toHaveCount(0);
});

test('repeated live playlist failure ends in an error instead of an endless spinner', async ({ page }) => {
  const { requests } = await openHls(page, { failures: Infinity });
  await expect(page.getByRole('alert').filter({ hasText: 'Playback Issue' })).toContainText('Playback failed after multiple retries', { timeout: 15_000 });
  expect(requests()).toBe(4);
  await expect(page.getByLabel('Loading the stream')).toHaveCount(0);
  await expect(page.getByText('Buffering...', { exact: true })).toHaveCount(0);
});


test('a rejected live token requests an uncached source and starts the replacement', async ({ page }) => {
  const { media } = await openHls(page, { expired: true });
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 15_000 }).toBeGreaterThan(0.2);
  await expect(page.getByRole('alert').filter({ hasText: 'Playback Issue' })).toHaveCount(0);
});


test('a live playlist that stops advancing is recovered after playback stalls', async ({ page }) => {
  test.setTimeout(35_000);
  const { media, requests } = await openHls(page, { stalled: true });
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0.2);
  // This server keeps returning the same six seconds of live media with 200.
  // There is no fatal HTTP error to trigger ordinary network recovery.
  await expect.poll(requests, { timeout: 25_000 }).toBeGreaterThan(1);
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThan(2);
  await expect(page.getByRole('alert').filter({ hasText: 'Playback Issue' })).toHaveCount(0);
});


test('a rejected replacement URL stops with an error instead of a destroyed buffering player', async ({ page }) => {
  await openHls(page, { expired: true, rejectFresh: true });
  await expect(page.getByRole('alert').filter({ hasText: 'Playback Issue' }))
    .toContainText('keeps rejecting playback', { timeout: 5_000 });
  await expect(page.getByLabel('Loading the stream')).toHaveCount(0);
  await expect(page.getByText('Buffering...', { exact: true })).toHaveCount(0);
});


/**
 * How far behind the live edge a live stream plays.
 *
 * `#EXT-X-TARGETDURATION` is a declared upper bound, and counting it is what
 * put a Twitch viewer 24s (4 × 6) behind the edge of a 30s window built from
 * 2-second segments: six seconds of headroom, so a late playlist refresh
 * dropped the playhead off the back of the window and hls.js seeked to
 * recover — a stall, then the same drift again. The target is derived from
 * the segments the playlist really lists.
 */

// Segment lengths measured from the live services; the counts give each one
// a window to slide in (Twitch's 15 × 2s is the measured playlist).
const TWITCH_LIVE = { label: 'twitch', targetDuration: 6, segmentSeconds: 2, segmentCount: 15 };
const YOUTUBE_LIVE = { label: 'youtube', targetDuration: 5, segmentSeconds: 5, segmentCount: 12 };

const shapeOf = (s: typeof TWITCH_LIVE) => ({
  segmentDurations: Array.from({ length: s.segmentCount }, () => s.segmentSeconds),
  targetDuration: s.targetDuration,
  windowDuration: s.segmentCount * s.segmentSeconds,
});

test('the live sync target follows the real segments, floored and kept inside the window', () => {
  // Twitch: declares 6, ships 2.000s segments, 15 of them — 30s of window.
  // Three real segments, and the playhead sits in the first fifth of the
  // window instead of the last. The old rule produced 4 × 6 = 24s.
  expect(liveSyncTargetSeconds(shapeOf(TWITCH_LIVE))).toBe(6);
  // YouTube live: 5s segments, so the same rule keeps three times as much.
  // This is why the number cannot be a fixed count of seconds.
  expect(liveSyncTargetSeconds(shapeOf(YOUTUBE_LIVE))).toBe(15);

  // A one-second-segment stream still gets a cushion worth having.
  expect(liveSyncTargetSeconds({
    segmentDurations: Array.from({ length: 30 }, () => 1), targetDuration: 1, windowDuration: 30,
  })).toBe(LIVE_SYNC_MIN_SECONDS);
  // A short window outranks three segments: the tail of the window is
  // exactly where the playhead must never be.
  expect(liveSyncTargetSeconds({
    segmentDurations: [5, 5, 5], targetDuration: 5, windowDuration: 15,
  })).toBeCloseTo(6, 6);
  // A trailing partial segment does not drag the estimate down.
  expect(liveSyncTargetSeconds({
    segmentDurations: [2, 2, 2, 2, 0.4], targetDuration: 6, windowDuration: 30,
  })).toBe(6);
  // Nothing to measure: the declared duration is all that is left, and then
  // the floor.
  expect(liveSyncTargetSeconds({ segmentDurations: [], targetDuration: 6, windowDuration: 60 })).toBe(18);
  expect(liveSyncTargetSeconds({ segmentDurations: [], targetDuration: 0, windowDuration: 0 }))
    .toBe(LIVE_SYNC_MIN_SECONDS);
});

async function openLiveEdge(page: Page, shape: typeof TWITCH_LIVE) {
  const fixture = fmp4Fixture();
  const base = `http://localhost:3100/hls-live-${shape.label}`;
  const original = `https://example.com/hls-live-${shape.label}`;
  const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=320x240,CODECS="avc1.42c015"
${base}/media.m3u8
`;
  // A real sliding window: every segment is its own URL, so which one the
  // player asks for first says exactly where it decided to start.
  const playlist = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${shape.targetDuration}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    `#EXT-X-MAP:URI="${base}/init.mp4"`,
    ...Array.from({ length: shape.segmentCount }, (_, i) =>
      `#EXTINF:${shape.segmentSeconds.toFixed(3)},\n${base}/seg-${i}.mp4`),
    '',
  ].join('\n');

  const requested: number[] = [];
  await page.route('**/api/resolve**', route => route.fulfill({ json: {
    original_url: original, stream_url: `${base}/master.m3u8`, stream_type: 'hls',
    title: `${shape.label} live fixture`, duration: null, is_live: true, available_qualities: [],
  } }));
  const serve: Parameters<typeof page.route>[1] = route => {
    const request = new URL(route.request().url());
    const url = request.searchParams.get('url') ?? request.href;
    const segment = /\/seg-(\d+)\.mp4$/.exec(url);
    if (segment) requested.push(Number(segment[1]));
    if (url.endsWith('.mp4')) return route.fulfill({
      contentType: 'video/mp4', body: url.endsWith('/init.mp4') ? fixture.init : fixture.media,
    });
    return route.fulfill({
      contentType: 'application/vnd.apple.mpegurl', body: url.endsWith('master.m3u8') ? master : playlist,
    });
  };
  await page.route(`**/hls-live-${shape.label}/**`, serve);
  await page.route('**/api/proxy**', serve);
  await page.goto(`/room/e2e-live-edge-${Date.now().toString(36)}?user=live-edge@example.com`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible();
  await page.getByPlaceholder('Paste video URL...').fill(original);
  await page.getByPlaceholder('Paste video URL...').press('Enter');
  return { requested };
}

/** The segment holding the position the derived target puts the playhead at. */
function expectedFirstSegment(shape: typeof TWITCH_LIVE) {
  const window = shape.segmentCount * shape.segmentSeconds;
  return Math.floor((window - liveSyncTargetSeconds(shapeOf(shape))) / shape.segmentSeconds);
}

for (const shape of [TWITCH_LIVE, YOUTUBE_LIVE]) {
  test(`a ${shape.label}-shaped live playlist starts at the derived distance from the edge`, async ({ page }) => {
    const { requested } = await openLiveEdge(page, shape);
    await expect.poll(() => requested.length, { timeout: 15_000 }).toBeGreaterThan(0);
    // Twitch: 30s window, target 6s, so the segment covering 24s — index 12.
    // Counting four declared target durations started 24s back instead, at
    // index 3. YouTube: 60s window, target 15s, index 9; the old rule's 20s
    // put it at index 8. Both were measured against the previous code.
    expect(requested[0]).toBe(expectedFirstSegment(shape));
  });
}
