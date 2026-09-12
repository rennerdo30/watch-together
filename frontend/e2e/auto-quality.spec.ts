import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { latencyAwareAbrFactory, sampleTimeMs, type AbrManagerLike } from '../lib/abr';
import { stubAdaptiveStream, type VideoRung } from './adaptive-fixture';

/**
 * Automatic quality selection on a long-haul link.
 *
 * A viewer on auto sat at a low rendition while 1080p, chosen by hand,
 * played without a hitch. Two things kept the estimate down: the wait for
 * each response's headers was charged against the few bytes of a small
 * segment, and Chrome's `navigator.connection.downlink` — a coarse guess —
 * replaced the estimate and reset every measurement each time it changed.
 */

const USER = 'auto-quality@example.com';
const ORIGINAL_URL = 'https://youtu.be/auto-quality-fixture';

/**
 * Two rungs declared so that the configured opening estimate (700 kbit/s)
 * affords the higher one — 450 + 128 kbit/s of audio is 578, and Shaka
 * requires estimate >= bandwidth / 0.95 — while the connection guess the
 * browser is made to report below does not.
 */
const LADDER: VideoRung[] = [
  { id: 'v-low', height: 240, tbr: 100 },
  { id: 'v-high', height: 1080, tbr: 450 },
];
/** What the faked Network Information API claims, in Mbit/s. */
const CLAIMED_DOWNLINK_MBPS = 0.3;
const CONNECTION_CHANGE_INTERVAL_MS = 300;

test('the Shaka build still exposes what the latency correction reads', () => {
  // The correction is silently a no-op if a Shaka upgrade stops numbering
  // progress events, stops stamping the time to first byte on the request,
  // or stops exporting the manager it extends. Pin all three on the bundle
  // the player actually loads.
  const bundle = readFileSync(
    path.resolve(__dirname, '../node_modules/shaka-player/dist/shaka-player.compiled.js'),
    'utf8',
  );
  expect(bundle).toMatch(/\.packetNumber=[\w$]+[,;)]/);
  expect(bundle).toMatch(/\.timeToFirstByte=Date\.now\(\)-\s*[\w$]+\.requestStartTime/);
  expect(bundle).toContain('"shaka.abr.SimpleAbrManager"');
});

test('the wait for headers is not charged against the bytes of a segment', () => {
  // A segment that waited 500 ms and then arrived in 30 ms.
  expect(sampleTimeMs(530, { packetNumber: 1, timeToFirstByte: 500 })).toBe(30);
  // Later progress events of the same request measure pure transfer.
  expect(sampleTimeMs(120, { packetNumber: 2, timeToFirstByte: 500 })).toBe(120);
  // Without measurable body transfer time, retain elapsed delivery time.
  // Inventing a 20ms transfer here inflated a 500ms response by 25x.
  expect(sampleTimeMs(500, { packetNumber: 1, timeToFirstByte: 500 })).toBe(500);
  expect(sampleTimeMs(500, { packetNumber: 1, timeToFirstByte: 600 })).toBe(500);
  expect(sampleTimeMs(510, { packetNumber: 1, timeToFirstByte: 500 })).toBe(510);
  // Cache hits stay under the threshold so Shaka still drops them.
  expect(sampleTimeMs(5, { packetNumber: 1, timeToFirstByte: 3 })).toBe(5);
  // A whole-request sample without a packet number includes the wait too.
  expect(sampleTimeMs(530, { packetNumber: null, timeToFirstByte: 500 })).toBe(30);
  // Without a usable time to first byte the sample is unchanged.
  expect(sampleTimeMs(530, undefined)).toBe(530);
  expect(sampleTimeMs(530, { packetNumber: 1, timeToFirstByte: null })).toBe(530);
  expect(sampleTimeMs(530, { packetNumber: 1, timeToFirstByte: NaN })).toBe(530);
  expect(sampleTimeMs(530, { packetNumber: 1, timeToFirstByte: -1 })).toBe(530);
  expect(sampleTimeMs(NaN, { packetNumber: 1, timeToFirstByte: 10 })).toBeNaN();
});

test('the manager hands Shaka the corrected time and everything else untouched', () => {
  const calls: unknown[][] = [];
  class FakeSimpleAbrManager implements AbrManagerLike {
    getBandwidthEstimate() { return 700_000; }
    segmentDownloaded(...args: unknown[]): void {
      calls.push(args);
    }
  }
  const manager = latencyAwareAbrFactory({ abr: { SimpleAbrManager: FakeSimpleAbrManager } }, () => {})();
  expect(manager).toBeInstanceOf(FakeSimpleAbrManager);

  const request = { packetNumber: 1, timeToFirstByte: 400 };
  const context = { type: 'segment' };
  manager.segmentDownloaded(450, 65_536, true, request, context);
  manager.segmentDownloaded(110, 65_536, false, { ...request, packetNumber: 2 }, context);
  expect(calls).toEqual([
    [50, 65_536, true, request, context],
    [110, 65_536, false, { packetNumber: 2, timeToFirstByte: 400 }, context],
  ]);
});

test('bandwidth memory receives measurements only after enough non-cache bytes', () => {
  const estimates: number[] = [];
  class FakeSimpleAbrManager {
    segmentDownloaded() {}
    getBandwidthEstimate() { return 8_000_000; }
  }
  const manager = latencyAwareAbrFactory(
    { abr: { SimpleAbrManager: FakeSimpleAbrManager } },
    bps => estimates.push(bps),
  )();
  manager.segmentDownloaded(5, 1_000_000, true); // cache hit
  manager.segmentDownloaded(100, 8_000, true); // too small for Shaka's EWMA
  manager.segmentDownloaded(100, 64_000, true);
  expect(estimates).toEqual([]);
  manager.segmentDownloaded(100, 64_000, true);
  expect(estimates).toEqual([8_000_000]);
});

test('auto opens on the rendition the configured estimate affords, not what the browser claims', async ({ page }) => {
  // Stand in for the Network Information API with a pessimistic, restless
  // connection: a low downlink, and a change event every few hundred ms.
  await page.addInitScript(
    ({ downlink, interval }) => {
      const connection = new EventTarget();
      Object.defineProperty(connection, 'downlink', { value: downlink });
      Object.defineProperty(navigator, 'connection', { value: connection, configurable: true });
      setInterval(() => connection.dispatchEvent(new Event('change')), interval);
    },
    { downlink: CLAIMED_DOWNLINK_MBPS, interval: CONNECTION_CHANGE_INTERVAL_MS },
  );
  await stubAdaptiveStream(page, ORIGINAL_URL, LADDER);

  await page.goto(`/room/e2e-auto-quality-${Date.now().toString(36)}?user=${encodeURIComponent(USER)}`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  await page.getByPlaceholder('Paste video URL...').fill(ORIGINAL_URL);
  await page.getByPlaceholder('Paste video URL...').press('Enter');

  const media = page.locator('video[data-stream-type="mse"]');
  await expect(media).toHaveCount(1, { timeout: 15_000 });
  await expect
    .poll(() => media.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 20_000 })
    .toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Playback statistics' }).click();
  const qualityRow = page.getByText('Quality', { exact: true }).locator('..');
  await expect(qualityRow).toContainText('auto (1080p)');

  // Several connection changes later the choice still stands: nothing was
  // reset to the browser's guess.
  await page.waitForTimeout(CONNECTION_CHANGE_INTERVAL_MS * 5);
  await expect(qualityRow).toContainText('auto (1080p)');
});
