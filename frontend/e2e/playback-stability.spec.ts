import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Regression tests for the playback engine being torn down by state it
 * should only read once.
 *
 * The MSE effect was keyed on `autoPlay` and `initialTime`. Both follow
 * the room: `autoPlay` mirrors play/pause, and `initialTime` is rewritten
 * by every seek and every server heartbeat. So the player was destroyed
 * and the manifest reloaded on each of those — which rebuffered from
 * zero, and worse, detaching the media element fired a `pause` event that
 * the room broadcast as a real pause, while the reload that followed
 * autoplayed and broadcast a real `play`. A paused room resumed itself,
 * and playback never settled.
 */

const FIXTURES = path.resolve(__dirname, '../../backend/tests/fixtures');
const BACKEND_DIR = path.resolve(__dirname, '../../backend');
const PYTHON = process.env.PYTHON_BIN ?? (process.env.CI ? 'python' : '../venv/bin/python');
const USER = 'stability@example.com';
const ORIGINAL_URL = 'https://youtu.be/stability-fixture';

/** Long enough for a reload to be requested, fetched and counted. */
const SETTLE_MS = 3_000;
/** Heartbeats arrive every 5s; two of them is enough to see a reload loop. */
const OBSERVATION_MS = 12_000;

function uniqueRoomId(label: string): string {
  return `e2e-${label}-${Date.now().toString(36)}`;
}

/** Build the manifest with the backend's own generator, via its Python API. */
function buildManifest(): string {
  const script = `
import sys
sys.path.insert(0, '.')
from services.mp4_index import parse_index
from services.manifest import build_mpd

video_index = parse_index(open('tests/fixtures/video.mp4','rb').read(65536))
audio_index = parse_index(open('tests/fixtures/audio.mp4','rb').read(65536))
mpd = build_mpd(
    6.0,
    [{'id':'v0','url':'https://cdn.test/fixtures/video.mp4','width':320,'height':240,
      'vcodec':'avc1.42c015','tbr':200,'fps':15,'index':video_index}],
    [{'id':'a0','url':'https://cdn.test/fixtures/audio.mp4','acodec':'mp4a.40.2',
      'abr':128,'asr':44100,'audio_channels':1,'index':audio_index}],
    'http://localhost:3100/api/proxy?url=',
)
sys.stdout.write(mpd)
`;
  return execFileSync(PYTHON, ['-c', script], { cwd: BACKEND_DIR, encoding: 'utf8' });
}

/**
 * Serve a playable adaptive stream to the room page, counting how often
 * the manifest is asked for. Each request past the first is the engine
 * being rebuilt: the manifest describes the whole stream and is read once.
 */
async function stubAdaptiveStream(page: import('@playwright/test').Page) {
  const manifest = buildManifest();
  const video = readFileSync(path.join(FIXTURES, 'video.mp4'));
  const audio = readFileSync(path.join(FIXTURES, 'audio.mp4'));
  const manifestRequests: string[] = [];

  await page.route('**/api/resolve**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        stream_url: 'https://cdn.test/fixtures/video.mp4',
        original_url: ORIGINAL_URL,
        stream_type: 'dash',
        video_url: 'https://cdn.test/fixtures/video.mp4',
        audio_url: 'https://cdn.test/fixtures/audio.mp4',
        title: 'Stability fixture',
        duration: 6,
        is_live: false,
        quality: '240p',
        available_qualities: [],
      }),
    }));

  await page.route('**/api/dash-manifest**', (route) => {
    manifestRequests.push(route.request().url());
    route.fulfill({
      status: 200,
      contentType: 'application/dash+xml',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: manifest,
    });
  });

  await page.route('**/api/proxy**', (route) => {
    const target = new URL(route.request().url()).searchParams.get('url') ?? '';
    const isAudio = target.includes('audio');
    route.fulfill({
      status: 200,
      contentType: isAudio ? 'audio/mp4' : 'video/mp4',
      headers: { 'Accept-Ranges': 'bytes' },
      body: isAudio ? audio : video,
    });
  });

  return manifestRequests;
}

async function openRoomWithVideo(page: import('@playwright/test').Page, label: string) {
  const manifestRequests = await stubAdaptiveStream(page);

  await page.goto(`/room/${uniqueRoomId(label)}?user=${encodeURIComponent(USER)}`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });

  await page.getByPlaceholder('Paste video URL...').fill(ORIGINAL_URL);
  await page.getByPlaceholder('Paste video URL...').press('Enter');

  const media = page.locator('video[data-stream-type="mse"]');
  await expect(media).toHaveCount(1, { timeout: 15_000 });
  await expect
    .poll(() => media.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 20_000 })
    .toBeGreaterThan(0);

  // The count once the stream is up is the baseline. It is not asserted to
  // be exactly one: the dev server mounts effects twice on purpose. What
  // matters is that it stops growing.
  await page.waitForTimeout(SETTLE_MS);
  return { media, manifestRequests, settled: manifestRequests.length };
}

test('pausing and resuming does not rebuild the player', async ({ page }) => {
  const { media, manifestRequests, settled } = await openRoomWithVideo(page, 'toggle');

  // Each toggle flips the room's play state, which used to be a dependency
  // of the engine's setup effect.
  for (const action of ['pause', 'play', 'pause'] as const) {
    await media.evaluate((v: HTMLVideoElement, a) => {
      if (a === 'pause') v.pause();
      else void v.play().catch(() => undefined);
    }, action);
    await page.waitForTimeout(SETTLE_MS);
  }

  expect(manifestRequests.length).toBe(settled);
});

test('a paused video stays paused', async ({ page }) => {
  const { media, manifestRequests, settled } = await openRoomWithVideo(page, 'paused');

  await media.evaluate((v: HTMLVideoElement) => v.pause());
  await expect(page.getByText('Paused', { exact: true }).first()).toBeVisible();

  await page.waitForTimeout(OBSERVATION_MS);

  // Nothing in the sync path may resume it, and nothing may reload the
  // stream behind it — a reload is what used to resume it.
  expect(await media.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await expect(page.getByText('Paused', { exact: true }).first()).toBeVisible();
  expect(manifestRequests.length).toBe(settled);
});
