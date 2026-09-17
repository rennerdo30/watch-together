import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A livestream must stay a livestream in the room.
 *
 * A YouTube stream with DVR enabled arrives with `is_live: true` and no
 * duration. The room used to lose that flag on the way to the player, and
 * the stream was then drawn as an ordinary video: no LIVE badge, a seek bar
 * over a window that cannot be seeked, and the sync logic dragging every
 * viewer towards a position that means nothing on a live timeline.
 */

const ORIGINAL_URL = 'https://www.youtube.com/watch?v=dvr-live-fixture';
const BASE = 'http://localhost:3100/live-fixture';

async function openLiveStream(page: Page) {
  const bytes = readFileSync(path.resolve(__dirname, '../../backend/tests/fixtures/video.mp4'));
  let initEnd = 0;
  while (initEnd < bytes.length && bytes.toString('ascii', initEnd + 4, initEnd + 8) !== 'moof') {
    initEnd += bytes.readUInt32BE(initEnd);
  }

  const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=320x240,CODECS="avc1.42c015"
${BASE}/media.m3u8
`;
  // A DVR window: an EVENT playlist that keeps growing and never ends.
  const playlist = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-PLAYLIST-TYPE:EVENT
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-MAP:URI="${BASE}/init.mp4"
#EXTINF:6,
${BASE}/segment.mp4
`;

  await page.route('**/api/resolve**', (route) => route.fulfill({
    json: {
      original_url: ORIGINAL_URL,
      stream_url: `${BASE}/master.m3u8`,
      stream_type: 'hls',
      title: 'A DVR livestream',
      // What yt-dlp reports for a live stream: no duration at all.
      duration: null,
      is_live: true,
      quality: '1080p',
      available_qualities: [],
    },
  }));

  const serve: Parameters<typeof page.route>[1] = (route) => {
    const request = new URL(route.request().url());
    const url = request.searchParams.get('url') ?? request.href;
    if (url.endsWith('.mp4')) {
      return route.fulfill({
        contentType: 'video/mp4',
        body: url.endsWith('/init.mp4') ? bytes.subarray(0, initEnd) : bytes.subarray(initEnd),
      });
    }
    return route.fulfill({
      contentType: 'application/vnd.apple.mpegurl',
      body: url.endsWith('master.m3u8') ? master : playlist,
    });
  };
  await page.route('**/live-fixture/**', serve);
  await page.route('**/api/proxy**', serve);

  await page.goto(`/room/e2e-live-${Date.now().toString(36)}?user=live@example.com`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible();
  await page.getByPlaceholder('Paste video URL...').fill(ORIGINAL_URL);
  await page.getByPlaceholder('Paste video URL...').press('Enter');
  return page.locator('video');
}

test('a livestream is drawn as one: LIVE, no seek bar, no duration', async ({ page }) => {
  const media = await openLiveStream(page);
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.readyState),
    { timeout: 15_000 }).toBeGreaterThan(0);

  const controls = page.getByTestId('control-bar');
  await expect(controls.getByText('LIVE').first()).toBeVisible();
  await expect(controls.getByLabel('Seek')).toHaveCount(0);
  // No "0:00 / 0:00" where a live timeline has no end to count towards.
  await expect(controls).not.toContainText('/');
  // The queue row says the same thing.
  await expect(page.getByText('Live', { exact: true }).first()).toBeVisible();
});
