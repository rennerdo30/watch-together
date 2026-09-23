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
export const FIXTURE_DUB_AUDIO_URL = 'https://cdn.test/fixtures/audio-dub.mp4';
export const FIXTURE_DURATION_SECONDS = 6;

/** One video rendition of the fixture's quality ladder. */
export interface VideoRung {
  id: string;
  height: number;
  /** Declared bitrate in kbit/s, the unit yt-dlp reports. */
  tbr: number;
  /**
   * Where this rung's bytes are fetched from; the fixture video unless a
   * test needs to tell rungs apart by their requests (see `rungUrl`).
   */
  url?: string;
}

const FIXTURE_VCODEC = 'avc1.42c015';
const FIXTURE_ASPECT = 4 / 3;

/**
 * A URL for one rung that still serves the fixture's bytes, so a test can
 * tell from a request which rung the player asked for.
 */
export const rungUrl = (id: string) => `${FIXTURE_VIDEO_URL}?rung=${encodeURIComponent(id)}`;

/** The rung a proxied request was for, when the ladder uses `rungUrl`. */
export function rungOfRequest(requestUrl: string): string | null {
  const target = new URL(requestUrl).searchParams.get('url');
  if (!target) return null;
  return new URL(target).searchParams.get('rung');
}

/** The ladder as a resolve response describes it (`available_qualities`). */
export function ladderQualities(ladder: VideoRung[]) {
  return ladder.map((rung) => ({
    height: rung.height,
    width: Math.round(rung.height * FIXTURE_ASPECT),
    video_url: rung.url ?? FIXTURE_VIDEO_URL,
    format_id: rung.id,
    vcodec: FIXTURE_VCODEC,
    tbr: rung.tbr,
  }));
}

/** The single rendition most tests need; matches the fixture's real geometry. */
export const DEFAULT_VIDEO_LADDER: VideoRung[] = [{ id: 'v0', height: 240, tbr: 200 }];


/**
 * Build the manifest with the backend's own generator, via its Python API.
 *
 * Every rung of the ladder points at the same fixture bytes: a test about
 * which rendition the player *chooses* needs distinguishable declarations,
 * not distinguishable pictures.
 */
export function buildManifest(
  proxyBase = 'http://localhost:3100/api/proxy?url=',
  videoLadder: VideoRung[] = DEFAULT_VIDEO_LADDER,
  multiAudio = false,
): string {
  const videoReps = videoLadder.map((rung) =>
    `{'id':${JSON.stringify(rung.id)},'url':${JSON.stringify(rung.url ?? FIXTURE_VIDEO_URL)},` +
    `'width':${Math.round(rung.height * FIXTURE_ASPECT)},'height':${rung.height},` +
    `'vcodec':${JSON.stringify(FIXTURE_VCODEC)},'tbr':${rung.tbr},'fps':15,'index':video_index}`,
  );
  const audioReps = multiAudio
    ? `[{'id':'a-original','url':${JSON.stringify(FIXTURE_AUDIO_URL)},'acodec':'mp4a.40.2',
         'abr':128,'asr':44100,'audio_channels':1,'index':audio_index,
         'language':'en','label':'English original','is_original':True,'is_default':True},
        {'id':'a-dub','url':${JSON.stringify(FIXTURE_DUB_AUDIO_URL)},'acodec':'mp4a.40.2',
         'abr':128,'asr':44100,'audio_channels':1,'index':audio_index,
         'language':'ja','label':'Japanese dubbed','is_original':False,'is_default':False}]`
    : `[{'id':'a0','url':${JSON.stringify(FIXTURE_AUDIO_URL)},'acodec':'mp4a.40.2',
         'abr':128,'asr':44100,'audio_channels':1,'index':audio_index}]`;
  const script = `
import sys
sys.path.insert(0, '.')
from services.mp4_index import parse_index
from services.manifest import build_mpd

video_index = parse_index(open('tests/fixtures/video.mp4','rb').read(65536))
audio_index = parse_index(open('tests/fixtures/audio.mp4','rb').read(65536))
mpd = build_mpd(
    ${FIXTURE_DURATION_SECONDS}.0,
    [${videoReps.join(',\n     ')}],
    ${audioReps},
    ${JSON.stringify(proxyBase)},
)
sys.stdout.write(mpd)
`;
  return execFileSync(PYTHON, ['-c', script], { cwd: BACKEND_DIR, encoding: 'utf8' });
}

/** What a resolve of `originalUrl` answers with for the fixture stream. */
export function fixtureResolve(originalUrl: string, videoLadder: VideoRung[] = DEFAULT_VIDEO_LADDER) {
  return {
    stream_url: FIXTURE_VIDEO_URL,
    original_url: originalUrl,
    stream_type: 'dash',
    video_url: FIXTURE_VIDEO_URL,
    audio_url: FIXTURE_AUDIO_URL,
    title: 'Adaptive fixture',
    duration: FIXTURE_DURATION_SECONDS,
    is_live: false,
    quality: '240p',
    available_qualities: ladderQualities(videoLadder),
  };
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
  videoLadder: VideoRung[] = DEFAULT_VIDEO_LADDER,
  /** Extra fields for the resolve body, e.g. a storyboard. */
  resolveExtras: Record<string, unknown> = {},
  multiAudio = false,
): Promise<string[]> {
  const manifest = buildManifest(undefined, videoLadder, multiAudio);
  const video = readFileSync(path.join(FIXTURES, 'video.mp4'));
  const audio = readFileSync(path.join(FIXTURES, 'audio.mp4'));
  const manifestRequests: string[] = [];

  await page.route('**/api/resolve**', (route) => {
    // Preserve whichever original URL the room asked to resolve. This lets a
    // test drive two different queue items through one shared media fixture:
    // the video identity changes, while the bytes stay deterministic.
    const requested = new URL(route.request().url()).searchParams.get('url') ?? originalUrl;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...fixtureResolve(requested, videoLadder), ...resolveExtras }),
    });
  });

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
    const bytes = isAudio ? audio : video;
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? '');
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    route.fulfill({
      status: range ? 206 : 200,
      contentType: isAudio ? 'audio/mp4' : 'video/mp4',
      headers: { 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) },
      body: bytes.subarray(start, end + 1),
    });
  });

  return manifestRequests;
}
