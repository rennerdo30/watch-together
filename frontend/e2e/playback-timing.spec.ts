import { test, expect } from '@playwright/test';

import { StartupTimer, type PlaybackTiming } from '../lib/playback-timing';
import { PLAYBACK_TIMING_STALL_WINDOW_MS } from '../lib/constants';
import { stubAdaptiveStream } from './adaptive-fixture';

/**
 * Each viewer reports how long each video took to start, phase by phase, so
 * "it takes ages to start" can be answered from the server's log instead of
 * guessed at: the resolve, the manifest, the first frame, the autoplay.
 */

const USER = 'timing@example.com';
const FIRST = 'https://youtu.be/timing-first';
const SECOND = 'https://youtu.be/timing-second';

test('a start is reported once, with ordered, non-negative phases', () => {
  const timer = new StartupTimer(FIRST, 'mse', 1_000, 420.4);
  // Nothing to report before the first frame.
  expect(timer.takeReport()).toBeNull();
  // A `playing` before this source's first frame is the previous video's.
  timer.markPlaying(1_050);
  timer.markStall(1_060);
  timer.markManifest(1_200, false);
  timer.markManifest(1_300, true); // only the first counts
  timer.markFirstFrame(1_500, 1080);
  timer.markPlaying(1_650);
  timer.markStall(1_700);
  timer.markStall(1_500 + PLAYBACK_TIMING_STALL_WINDOW_MS + 1); // outside the window
  expect(timer.takeReport()).toEqual({
    original_url: FIRST,
    engine: 'mse',
    preloaded: false,
    resolve_ms: 420,
    set_video_to_manifest_ms: 200,
    set_video_to_first_frame_ms: 500,
    first_frame_to_playing_ms: 150,
    rung_height: 1080,
    stalls_first_30s: 1,
  } satisfies PlaybackTiming);
  expect(timer.takeReport()).toBeNull();

  // Marks from before the start are clamped rather than going negative.
  const early = new StartupTimer(SECOND, 'hls', 5_000);
  early.markManifest(4_000, false);
  early.markFirstFrame(4_500, 0);
  const report = early.takeReport()!;
  expect(report.set_video_to_manifest_ms).toBe(0);
  expect(report.set_video_to_first_frame_ms).toBe(0);
  expect(report).not.toHaveProperty('resolve_ms');
  expect(report).not.toHaveProperty('rung_height');
});

test('the room is told how each video started', async ({ page }) => {
  await stubAdaptiveStream(page, FIRST);
  const sent: PlaybackTiming[] = [];
  page.on('websocket', (socket) => socket.on('framesent', (frame) => {
    const text = typeof frame.payload === 'string' ? frame.payload : frame.payload.toString();
    const message = JSON.parse(text);
    if (message.type === 'playback_timing') sent.push(message.payload);
  }));

  await page.goto(`/room/e2e-timing-${Date.now().toString(36)}?user=${encodeURIComponent(USER)}`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  const input = page.getByPlaceholder('Paste video URL...');
  await input.fill(FIRST);
  await input.press('Enter');
  const media = page.locator('video[data-stream-type="mse"]');
  await expect(media).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => !v.paused && v.readyState >= 2),
    { timeout: 20_000 }).toBe(true);
  // Reported when its stall window closes, or when the room moves on.
  expect(sent).toEqual([]);
  await input.fill(SECOND);
  await input.press('Enter');

  await expect.poll(() => sent.length, { timeout: 15_000 }).toBe(1);
  const report = sent[0];
  expect(report.original_url).toBe(FIRST);
  expect(report.engine).toBe('mse');
  expect(report.preloaded).toBe(false);
  expect(report.rung_height).toBe(240);
  // This viewer resolved it, so the wait for that is included.
  expect(report.resolve_ms).toBeGreaterThanOrEqual(0);
  expect(report.set_video_to_manifest_ms).toBeGreaterThanOrEqual(0);
  expect(report.set_video_to_first_frame_ms).toBeGreaterThanOrEqual(report.set_video_to_manifest_ms!);
  expect(report.first_frame_to_playing_ms).toBeGreaterThanOrEqual(0);
  expect(report.stalls_first_30s).toBeGreaterThanOrEqual(0);

  // Once per start: nothing more about FIRST however long SECOND plays.
  await page.waitForTimeout(1_000);
  expect(sent.filter((entry) => entry.original_url === FIRST)).toHaveLength(1);
});
