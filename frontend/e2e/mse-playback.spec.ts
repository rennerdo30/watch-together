import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Proves the MSE path end to end in a real browser: a manifest built by
 * the backend from fragmented-MP4 fixtures is loaded by Shaka into one
 * media element, which then buffers and advances both tracks together.
 *
 * The fixtures are fragmented MP4s with a global segment index, the same
 * shape the adaptive streams have, so the manifest generator is
 * exercised on real box layouts rather than a synthetic stand-in.
 */

const FIXTURES = path.resolve(__dirname, '../../backend/tests/fixtures');
const BACKEND_DIR = path.resolve(__dirname, '../../backend');
const PYTHON = process.env.PYTHON_BIN ?? (process.env.CI ? 'python' : '../venv/bin/python');

/** Build the manifest with the backend's own generator, via its Python API. */
function buildManifest(videoUrl: string, audioUrl: string): string {
  const script = `
import sys, json
sys.path.insert(0, '.')
from services.mp4_index import parse_index
from services.manifest import build_mpd

video_index = parse_index(open('tests/fixtures/video.mp4','rb').read(65536))
audio_index = parse_index(open('tests/fixtures/audio.mp4','rb').read(65536))
mpd = build_mpd(
    6.0,
    [{'id':'v0','url':${JSON.stringify(videoUrl)},'width':320,'height':240,
      'vcodec':'avc1.42c015','tbr':200,'fps':15,'index':video_index}],
    [{'id':'a0','url':${JSON.stringify(audioUrl)},'acodec':'mp4a.40.2',
      'abr':128,'asr':44100,'audio_channels':1,'index':audio_index}],
    'http://localhost:3100/api/proxy?url=',
)
sys.stdout.write(mpd)
`;
  return execFileSync(PYTHON, ['-c', script], { cwd: BACKEND_DIR, encoding: 'utf8' });
}

test('shaka plays a generated manifest through one media element', async ({ page }) => {
  // Serve the fixtures and the manifest from the page's own origin so no
  // cross-origin rules interfere with the media requests.
  const video = readFileSync(path.join(FIXTURES, 'video.mp4'));
  const audio = readFileSync(path.join(FIXTURES, 'audio.mp4'));

  // Stand in for the backend proxy: the manifest addresses media through
  // /api/proxy?url=<encoded>, exactly as it does in production.
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

  const manifest = buildManifest(
    'https://cdn.test/fixtures/video.mp4',
    'https://cdn.test/fixtures/audio.mp4',
  );
  expect(manifest).toContain('<SegmentBase');

  await page.route('**/generated.mpd', (route) =>
    route.fulfill({ status: 200, contentType: 'application/dash+xml', body: manifest }));

  await page.goto('/');

  // The compiled bundle is injected directly: bare module specifiers do
  // not resolve inside the page's evaluation context.
  await page.addScriptTag({
    path: require.resolve('shaka-player/dist/shaka-player.compiled.js'),
  });

  const result = await page.evaluate(async () => {
    // Minimal shape of the Shaka globals this test drives.
    interface ShakaTrack { height?: number | null; audioCodec?: string | null }
    interface ShakaPlayer {
      attach(element: HTMLMediaElement): Promise<void>;
      load(uri: string): Promise<void>;
      getVariantTracks(): ShakaTrack[];
    }
    interface ShakaGlobal {
      polyfill: { installAll(): void };
      Player: { new (): ShakaPlayer; isBrowserSupported(): boolean };
    }
    const shaka = (window as unknown as { shaka: ShakaGlobal }).shaka;
    shaka.polyfill.installAll();
    if (!shaka.Player.isBrowserSupported()) return { supported: false };

    const element = document.createElement('video');
    element.muted = true;
    document.body.appendChild(element);

    const player = new shaka.Player();
    await player.attach(element);
    try {
      await player.load('/generated.mpd');
    } catch (err: unknown) {
      const shakaError = err as { code?: number; category?: number; data?: unknown };
      return {
        supported: true, duration: 0, currentTime: 0, buffered: 0,
        hasVideoTrack: false, hasAudioTrack: false,
        error: `code=${shakaError?.code} category=${shakaError?.category} `
          + `data=${JSON.stringify(shakaError?.data)}`,
      };
    }

    await element.play().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const tracks = player.getVariantTracks();
    return {
      supported: true,
      duration: element.duration,
      currentTime: element.currentTime,
      buffered: element.buffered.length > 0 ? element.buffered.end(0) : 0,
      hasVideoTrack: tracks.some((t) => !!t.height),
      hasAudioTrack: tracks.some((t) => !!t.audioCodec),
      error: null as string | null,
    };
  });

  test.skip(!result.supported, 'browser does not support MSE playback');
  expect(result.error).toBeNull();

  // One element reports a duration covering both tracks…
  expect(result.duration).toBeGreaterThan(5);
  // …the manifest advertised both of them…
  expect(result.hasVideoTrack).toBe(true);
  expect(result.hasAudioTrack).toBe(true);
  // …and media actually buffered and advanced, so it is really playing.
  expect(result.buffered).toBeGreaterThan(0);
  expect(result.currentTime).toBeGreaterThan(0);
});
