import { test, expect } from '@playwright/test';

import { autoQualityCap, openingPlan, preferredCodecFamily } from '../lib/abr';
import { BANDWIDTH_MEMORY_KEY } from '../lib/bandwidth-memory';
import { rungOfRequest, rungUrl, stubAdaptiveStream, type VideoRung } from './adaptive-fixture';

/**
 * The auto-quality cap has to be in place before the first byte is asked for.
 *
 * It used to be applied once `load()` had resolved. Shaka picks the opening
 * rung before that — before it even dispatches `manifestparsed` — so a
 * returning viewer on a fast line opened on the top of the ladder: 4K AV1,
 * 13–28 MB a segment, for a laptop-sized player, and only then got capped.
 * The cap is now computed from the ladder the resolve already described and
 * the element's surface, and configured before the load.
 */

const ORIGINAL_URL = 'https://youtu.be/opening-rung-fixture';
// Every rung is cheap, so a remembered fast connection affords the top one.
const LADDER: VideoRung[] = [
  { id: 'v-720', height: 720, tbr: 100, url: rungUrl('v-720') },
  { id: 'v-1080', height: 1080, tbr: 200, url: rungUrl('v-1080') },
  { id: 'v-2160', height: 2160, tbr: 300, url: rungUrl('v-2160') },
];

test('the opening rung is predicted within the cap and the codec family', () => {
  const ladder = [
    { height: 360, vcodec: 'avc1.4d401e', tbr: 700 },
    { height: 1080, vcodec: 'avc1.640028', tbr: 4_000 },
    { height: 1080, vcodec: 'av01.0.08M.08', tbr: 2_000 },
    { height: 2160, vcodec: 'av01.0.12M.08', tbr: 12_000 },
    { height: 480, vcodec: 'av01.0.04M.08', tbr: 500 },
  ];
  const everything = () => true;
  const noAv1 = (codec: string) => !codec.startsWith('av01');
  expect(preferredCodecFamily(ladder, everything)).toBe('av01');
  expect(preferredCodecFamily(ladder, noAv1)).toBe('avc1');
  expect(preferredCodecFamily([{ height: 720 }], everything)).toBeUndefined();

  // Plenty of bandwidth: the cap decides.
  expect(openingPlan(ladder, 1080, 40_000_000, everything)).toEqual({ height: 1080, codec: 'av01' });
  expect(openingPlan(ladder, null, 40_000_000, everything)).toEqual({ height: 2160, codec: 'av01' });
  // Within the family the browser can decode.
  expect(openingPlan(ladder, 1080, 40_000_000, noAv1)).toEqual({ height: 1080, codec: 'avc1' });
  // The opening estimate decides: 2 Mbit/s of AV1 1080p plus audio needs
  // 2.24 Mbit/s with Shaka's margin.
  expect(openingPlan(ladder, 1080, 2_000_000, everything)).toEqual({ height: 480, codec: 'av01' });
  // Nothing affordable: the smallest allowed rung, as Shaka does.
  expect(openingPlan(ladder, 1080, 1, everything)).toEqual({ height: 480, codec: 'av01' });
  expect(openingPlan([], 1080, 1, everything)).toBeNull();
});

test('a returning fast viewer\'s first media request is within the cap', async ({ page }) => {
  // Yesterday this connection measured 50 Mbit/s: the opening estimate
  // (capped and discounted) affords every rung of the ladder.
  await page.addInitScript((key) => {
    localStorage.setItem(key, JSON.stringify({ bps: 50_000_000, at: Date.now() }));
  }, BANDWIDTH_MEMORY_KEY);
  await stubAdaptiveStream(page, ORIGINAL_URL, LADDER);
  const rungsRequested: string[] = [];
  page.on('request', (request) => {
    if (!request.url().includes('/api/proxy')) return;
    const rung = rungOfRequest(request.url());
    if (rung) rungsRequested.push(rung);
  });

  await page.goto(`/room/e2e-opening-rung-${Date.now().toString(36)}?user=opening@example.com`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  await page.getByPlaceholder('Paste video URL...').fill(ORIGINAL_URL);
  await page.getByPlaceholder('Paste video URL...').press('Enter');
  const media = page.locator('video[data-stream-type="mse"]');
  await expect(media).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(() => rungsRequested.length, { timeout: 20_000 }).toBeGreaterThan(0);

  const surface = await media.evaluate((v: HTMLVideoElement) => v.clientHeight * window.devicePixelRatio);
  const cap = autoQualityCap(LADDER.map((rung) => rung.height), surface, 1);
  // The player in this viewport is covered by 720, so the cap is 1080 and
  // 2160 — what bandwidth alone would open on — is out of reach.
  expect(cap).toBe(1080);
  const first = LADDER.find((rung) => rung.id === rungsRequested[0]);
  expect(first, `first request was for ${rungsRequested[0]}`).toBeDefined();
  expect(first!.height).toBeLessThanOrEqual(cap!);
  // Nor did it fetch anything of the uncapped rung on the way.
  expect(rungsRequested).not.toContain('v-2160');
});

test('Shaka accepts every configuration key the player sets', async ({ page }) => {
  // Shaka drops a key it does not recognise with nothing but a console
  // warning. clearBufferSwitch and safeMarginSwitch moved under `abr` in
  // Shaka 5, and set under `streaming` they were silently ignored: a better
  // rendition waited behind the whole buffer. Checking that the names exist
  // somewhere in the bundle could not catch that; the player's own verdict
  // on the configuration it is actually given can.
  const complaints: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    if (/Invalid config|unrecognized key|deprecated/i.test(text)) complaints.push(text);
  });
  await stubAdaptiveStream(page, ORIGINAL_URL, LADDER);
  await page.goto(`/room/e2e-shaka-config-${Date.now().toString(36)}?user=config@example.com`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  await page.getByPlaceholder('Paste video URL...').fill(ORIGINAL_URL);
  await page.getByPlaceholder('Paste video URL...').press('Enter');
  const media = page.locator('video[data-stream-type="mse"]');
  await expect(media).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(2);
  expect(complaints).toEqual([]);
});
