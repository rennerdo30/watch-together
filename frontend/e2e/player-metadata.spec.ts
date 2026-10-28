import { test, expect } from '@playwright/test';
import { stubAdaptiveStream } from './adaptive-fixture';

for (const fullscreen of [false, true]) {
test(`${fullscreen ? 'fullscreen' : 'normal'} metadata follows controls, hides while playing and returns on movement or pause`, async ({ page }) => {
  const url = 'https://youtu.be/fullscreen-metadata';
  await stubAdaptiveStream(page, url, undefined, { title: 'A beautiful evening', channel: 'Evening Films' });
  await page.goto(`/room/e2e-metadata-${Date.now()}?user=metadata@example.com`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible();
  await page.getByPlaceholder('Paste video URL...').fill(url);
  await page.getByPlaceholder('Paste video URL...').press('Enter');
  const video = page.locator('video[data-stream-type="mse"]');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
  // Loop the short local fixture so idle visibility is tested during playback.
  await video.evaluate(async (v: HTMLVideoElement) => { v.muted = true; v.loop = true; await v.play(); });
  const metadata = page.getByLabel('Now playing');
  if (fullscreen) await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  await page.mouse.move(300, 200);
  await expect(metadata).toContainText('A beautiful evening');
  await expect(metadata).toContainText('Evening Films');
  await expect(metadata).toHaveCSS('opacity', '1');
  // A compact single line in the page, a larger heading in fullscreen: the
  // overlay must not cover a third of a windowed player.
  const heading = metadata.getByRole('heading');
  const headingHeight = async () => (await heading.boundingBox())!.height;
  if (fullscreen) await expect.poll(headingHeight).toBeGreaterThan(28);
  else await expect.poll(headingHeight).toBeLessThanOrEqual(24);
  await expect(metadata).toHaveCSS('opacity', '0', { timeout: 8000 });
  await expect(video).toHaveCSS('cursor', 'none');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => !v.paused && v.readyState >= 2)).toBe(true);
  await page.mouse.move(320, 220);
  await expect(metadata).toHaveCSS('opacity', '1');
  await video.evaluate((v: HTMLVideoElement) => v.pause());
  await page.waitForTimeout(3500);
  await expect(metadata).toHaveCSS('opacity', '1');
  if (fullscreen) {
    await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
    await expect(metadata).toHaveCSS('opacity', '1');
  }
});
}
