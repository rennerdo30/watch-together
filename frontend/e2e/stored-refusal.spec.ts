import { test, expect } from '@playwright/test';
import { stubAdaptiveStream } from './adaptive-fixture';
import { tagProxiedRequest } from '../lib/jump-cache';

/**
 * Something between one viewer's browser and Cloudflare stored a refusal for
 * a proxied media URL and replayed it on every reload (same Cloudflare ray,
 * never reaching our server). A stream's proxied URL is stable for hours, so
 * that video never played for them again; a new video, with new URLs, did.
 */

const VIDEO = 'https://youtu.be/stored-refusal';

test('every proxied media request carries its own tag', () => {
  const uri = 'https://w2g.example/api/proxy?url=https%3A%2F%2Fcdn%2Fa';
  const first = tagProxiedRequest(uri), second = tagProxiedRequest(uri);
  expect(first).toMatch(/&rq=[a-z0-9]+$/);
  expect(tagProxiedRequest(uri, 'bytes=700-2939')).toMatch(/&br=700-2939&rq=[a-z0-9]+$/);
  expect(first).not.toBe(second);
  expect(tagProxiedRequest('https://w2g.example/api/dash-manifest?url=x')).toBe('https://w2g.example/api/dash-manifest?url=x');
});

test('a reload plays even where every URL already seen is answered with a stored refusal', async ({ page }) => {
  await stubAdaptiveStream(page, VIDEO);
  // The replaying layer: any exact media URL it has seen before gets the old
  // refusal back. Routes registered later take precedence over the fixture's.
  const seen = new Set<string>();
  let replayed = 0;
  await page.route('**/api/proxy**', (route) => {
    const url = route.request().url();
    if (seen.has(url)) {
      replayed++;
      return route.fulfill({ status: 403, contentType: 'application/json',
        body: JSON.stringify({ detail: 'Whole-file media downloads are not served; players request byte ranges' }) });
    }
    seen.add(url);
    return route.fallback();
  });

  const roomId = `e2e-stored-refusal-${Date.now().toString(36)}`;
  await page.goto(`/room/${roomId}?user=replayed@example.com`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible();
  await page.getByPlaceholder('Paste video URL...').fill(VIDEO);
  await page.getByPlaceholder('Paste video URL...').press('Enter');
  const video = page.locator('video[data-stream-type="mse"]');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);

  await page.reload();
  await expect(page.getByLabel('Connected to the room')).toBeVisible();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(2);
  expect(replayed).toBe(0);
});

test('playback works when something strips the Range header from media requests', async ({ page }) => {
  // A viewer's browser (an extension) removed Range from the player's media
  // requests: the proxy saw whole-file downloads and refused every one.
  await stubAdaptiveStream(page, VIDEO);
  let stripped = 0;
  await page.route('**/api/proxy**', (route) => {
    const headers = { ...route.request().headers() };
    if (headers.range) { delete headers.range; stripped++; }
    // What the proxy then sees, and does for a large googlevideo rendition:
    // no range anywhere is a whole-file download, refused.
    if (!new URL(route.request().url()).searchParams.get('br')) {
      return route.fulfill({ status: 403, contentType: 'application/json',
        body: JSON.stringify({ detail: 'Whole-file media downloads are not served; players request byte ranges' }) });
    }
    return route.fallback({ headers });
  });
  const roomId = `e2e-stripped-range-${Date.now().toString(36)}`;
  await page.goto(`/room/${roomId}?user=stripped@example.com`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible();
  await page.getByPlaceholder('Paste video URL...').fill(VIDEO);
  await page.getByPlaceholder('Paste video URL...').press('Enter');
  const video = page.locator('video[data-stream-type="mse"]');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(2);
  expect(stripped).toBeGreaterThan(0);
});
