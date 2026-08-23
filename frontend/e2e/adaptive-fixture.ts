import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A playable adaptive stream, served to the room page from local fixtures.
 *
 * The manifest is produced by the backend's own generator rather than
 * hand-written, so a test that plays it exercises the real box-scanning path
 * on real fragmented MP4s.
 */

const FIXTURES = path.resolve(__dirname, '../../backend/tests/fixtures');
const BACKEND_DIR = path.resolve(__dirname, '../../backend');
const PYTHON = process.env.PYTHON_BIN ?? (process.env.CI ? 'python' : '../venv/bin/python');

export const FIXTURE_VIDEO_URL = 'https://cdn.test/fixtures/video.mp4';
export const FIXTURE_AUDIO_URL = 'https://cdn.test/fixtures/audio.mp4';
export const FIXTURE_DURATION_SECONDS = 6;

/** Build the manifest with the backend's own generator, via its Python API. */
export function buildManifest(proxyBase = 'http://localhost:3100/api/proxy?url='): string {
  const script = `
import sys
sys.path.insert(0, '.')
from services.mp4_index import parse_index
from services.manifest import build_mpd

video_index = parse_index(open('tests/fixtures/video.mp4','rb').read(65536))
audio_index = parse_index(open('tests/fixtures/audio.mp4','rb').read(65536))
mpd = build_mpd(
    ${FIXTURE_DURATION_SECONDS}.0,
    [{'id':'v0','url':${JSON.stringify(FIXTURE_VIDEO_URL)},'width':320,'height':240,
      'vcodec':'avc1.42c015','tbr':200,'fps':15,'index':video_index}],
    [{'id':'a0','url':${JSON.stringify(FIXTURE_AUDIO_URL)},'acodec':'mp4a.40.2',
      'abr':128,'asr':44100,'audio_channels':1,'index':audio_index}],
    ${JSON.stringify(proxyBase)},
)
sys.stdout.write(mpd)
`;
  return execFileSync(PYTHON, ['-c', script], { cwd: BACKEND_DIR, encoding: 'utf8' });
}

/**
 * Route resolve, manifest and segment requests at the local fixtures.
 *
 * Returns the URLs the manifest endpoint was asked for; each request past the
 * first means the playback engine was rebuilt.
 */
export async function stubAdaptiveStream(
  page: import('@playwright/test').Page,
  originalUrl: string,
): Promise<string[]> {
  const manifest = buildManifest();
  const video = readFileSync(path.join(FIXTURES, 'video.mp4'));
  const audio = readFileSync(path.join(FIXTURES, 'audio.mp4'));
  const manifestRequests: string[] = [];

  await page.route('**/api/resolve**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        stream_url: FIXTURE_VIDEO_URL,
        original_url: originalUrl,
        stream_type: 'dash',
        video_url: FIXTURE_VIDEO_URL,
        audio_url: FIXTURE_AUDIO_URL,
        title: 'Adaptive fixture',
        duration: FIXTURE_DURATION_SECONDS,
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
