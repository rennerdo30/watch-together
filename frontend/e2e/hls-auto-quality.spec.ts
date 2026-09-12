import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

test('HLS keeps Auto selected after adaptation and restores it without flushing playback', async ({ page }) => {
  const bytes = readFileSync(path.resolve(__dirname, '../../backend/tests/fixtures/video.mp4'));
  let initEnd = 0;
  while (initEnd < bytes.length && bytes.toString('ascii', initEnd + 4, initEnd + 8) !== 'moof') {
    initEnd += bytes.readUInt32BE(initEnd);
  }
  const base = 'http://localhost:3100/hls-fixture';
  const original = 'https://example.com/hls-auto-quality';
  const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=320x240,CODECS="avc1.42c015"
${base}/low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=450000,RESOLUTION=1440x1080,CODECS="avc1.42c015"
${base}/high.m3u8
`;
  const playlist = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="${base}/init.mp4"
#EXTINF:6,
${base}/segment.mp4
#EXT-X-ENDLIST
`;
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
    original_url: original, stream_url: `${base}/master.m3u8`, stream_type: 'hls',
    title: 'HLS auto fixture', duration: 6, is_live: false, available_qualities: [],
  } }));
  const serve: Parameters<typeof page.route>[1] = route => {
    const request = new URL(route.request().url());
    const url = request.searchParams.get('url') ?? request.href;
    if (url.endsWith('.mp4')) return route.fulfill({
      contentType: 'video/mp4', body: url.endsWith('/init.mp4') ? bytes.subarray(0, initEnd) : bytes.subarray(initEnd),
    });
    return route.fulfill({ contentType: 'application/vnd.apple.mpegurl', body: url.endsWith('/master.m3u8') ? master : playlist });
  };
  await page.route('**/hls-fixture/**', serve);
  await page.route('**/api/proxy**', serve);
  await page.goto(`/room/e2e-hls-auto-${Date.now().toString(36)}?user=hls-auto@example.com`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible();
  await page.getByPlaceholder('Paste video URL...').fill(original);
  await page.getByPlaceholder('Paste video URL...').press('Enter');
  const media = page.locator('video');
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
