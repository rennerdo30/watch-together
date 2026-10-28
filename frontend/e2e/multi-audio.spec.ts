import { test, expect } from '@playwright/test';

import { FIXTURE_DUB_AUDIO_URL, stubAdaptiveStream, type VideoRung } from './adaptive-fixture';
import { openPlayerSettings, openPlayerSettingsPage } from './player-settings';

const ORIGINAL_URL = 'https://youtu.be/multi-audio-fixture';
const LADDER: VideoRung[] = [
  { id: 'v-240', height: 240, tbr: 100 },
  { id: 'v-720', height: 720, tbr: 200 },
];

test('audio selection starts on original and keeps manual video quality when switching tracks', async ({ page }) => {
  const audioRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/proxy')) audioRequests.push(request.url());
  });
  await stubAdaptiveStream(page, ORIGINAL_URL, LADDER, {}, true);
  await page.goto(`/room/e2e-multi-audio-${Date.now().toString(36)}?user=audio@example.com`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  await page.getByPlaceholder('Paste video URL...').fill(ORIGINAL_URL);
  await page.getByPlaceholder('Paste video URL...').press('Enter');
  const media = page.locator('video[data-stream-type="mse"]');
  await expect(media).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(() => media.evaluate((video: HTMLVideoElement) => video.readyState >= 2),
    { timeout: 20_000 }).toBe(true);

  await openPlayerSettings(page, 'Audio track');
  const audioTrack = page.getByRole('group', { name: 'Audio track' });
  const original = audioTrack.getByRole('button', { name: 'English original' });
  const dubbed = audioTrack.getByRole('button', { name: 'Japanese dubbed' });
  await expect(audioTrack.getByRole('button')).toHaveText(['English original', 'Japanese dubbed']);
  await expect(original).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => audioRequests.some((url) => decodeURIComponent(url).includes('audio.mp4')),
    { timeout: 15_000 }).toBe(true);
  expect(audioRequests.some((url) => decodeURIComponent(url).includes(FIXTURE_DUB_AUDIO_URL))).toBe(false);

  await openPlayerSettingsPage(page, 'Quality', true);
  const quality720 = page.getByRole('button', { name: /^720p / });
  await quality720.click();
  await expect(quality720).toHaveAttribute('aria-pressed', 'true');
  await openPlayerSettingsPage(page, 'Audio track', true);
  await dubbed.click();
  await expect(dubbed).toHaveAttribute('aria-pressed', 'true');
  await openPlayerSettingsPage(page, 'Quality', true);
  await expect(quality720).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => audioRequests.some((url) => decodeURIComponent(url).includes(FIXTURE_DUB_AUDIO_URL)),
    { timeout: 15_000 }).toBe(true);

  const quality240 = page.getByRole('button', { name: /^240p / });
  await quality240.click();
  await expect(quality240).toHaveAttribute('aria-pressed', 'true');
  await openPlayerSettingsPage(page, 'Audio track', true);
  await expect(dubbed).toHaveAttribute('aria-pressed', 'true');
});
