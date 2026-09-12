import { test, expect, type Page } from '@playwright/test';
import { chatUrl, resolveLiveChat } from '../lib/live-chat';
import { stubAdaptiveStream } from './adaptive-fixture';

const APP = 'https://w2g.renner.dev';

test('provider adapters handle canonical URLs, self-hosting, unknown sites and unsafe input', () => {
  const live = (original_url: string, extra = {}) => resolveLiveChat({ original_url, is_live: true, ...extra }, APP);
  expect(live('https://m.twitch.tv/zarbex')?.embedUrl).toBe('https://www.twitch.tv/embed/zarbex/chat?parent=w2g.renner.dev&darkpopout');
  for (const url of ['https://youtu.be/abcdefghijk', 'https://www.youtube.com/watch?v=abcdefghijk', 'https://youtube.com/live/abcdefghijk']) {
    expect(live(url)?.embedUrl).toBe('https://www.youtube.com/live_chat?v=abcdefghijk&embed_domain=w2g.renner.dev');
  }
  expect(live('https://short.example/x', { webpage_url: 'https://live.example/', extractor_key: 'Owncast' })?.embedUrl).toBe('https://live.example/embed/chat/readwrite');
  expect(live('https://kick.com/example')?.openUrl).toBe('https://kick.com/popout/example/chat');
  expect(live('https://video.example/live/1')?.openUrl).toBe('https://video.example/live/1');
  expect(live('https://twitch.tv.evil.test/zarbex')?.embedUrl).toBeUndefined();
  expect(live('https://twitch.tv/videos/123')?.embedUrl).toBeUndefined();
  expect(live('https://youtu.be/abcdefghijk', { is_live: false })).toBeUndefined();
  for (const url of ['javascript:alert(1)', 'data:text/html,hello', 'https://user:pass@example.com/chat', `${APP}/admin`, 'http://example.com/chat']) {
    expect(chatUrl(url, APP)).toBeUndefined();
  }
});

async function openStream(page: Page, url: string, extras = {}) {
  await stubAdaptiveStream(page, url, undefined, { is_live: true, ...extras });
  // All chat content comes from a stub, never from a real channel or account.
  await page.route(/^https:/, route => {
    if (route.request().resourceType() === 'document') {
      return route.fulfill({ contentType: 'text/html', body: '<p>Chat fixture</p>' });
    }
    return route.abort();
  });
  await page.goto(`/room/e2e-live-chat-${Date.now().toString(36)}?user=chat@example.com`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible();
  await play(page, url);
}

async function play(page: Page, url: string) {
  await page.getByPlaceholder('Paste video URL...').fill(url);
  await page.getByPlaceholder('Paste video URL...').press('Enter');
  await expect(page.locator('header').getByRole('link', { name: /Open Adaptive fixture/ })).toHaveAttribute('href', url);
}

test('live chat loads on demand, follows the stream and unloads when closed', async ({ page }, testInfo) => {
  await openStream(page, 'https://twitch.tv/zarbex');
  await expect(page.locator('iframe')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Live chat' }).click();
  const frame = page.getByTitle('Twitch live chat', { exact: true });
  await expect(frame).toHaveAttribute('src', 'https://www.twitch.tv/embed/zarbex/chat?parent=localhost&darkpopout');
  await expect(page.getByText('Chat updates live and may run ahead of the video.')).toBeVisible();
  await expect(frame).toHaveAttribute('sandbox', /allow-scripts/);
  await expect(frame).not.toHaveAttribute('sandbox', /allow-top-navigation/);
  await expect(page.frameLocator('iframe').getByText('Chat fixture')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('live-chat-desktop.png') });
  await play(page, 'https://twitch.tv/another_channel');
  await expect(frame).toHaveAttribute('src', /embed\/another_channel\/chat/);
  await page.getByRole('tab', { name: /Queue/ }).click();
  await expect(page.locator('iframe')).toHaveCount(0);
});

test('unknown providers accept custom chat without leaking it into another stream', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const url = 'https://video.example/live/1';
  await openStream(page, url);
  await page.getByRole('tab', { name: 'Live chat' }).click();
  await expect(page.getByRole('link', { name: 'Open original stream' })).toHaveAttribute('href', url);
  await expect(page.locator('iframe')).toHaveCount(0);
  await page.getByText('Chat from another service', { exact: true }).click();
  await page.getByLabel(/Paste a pop-out/).fill('https://chat.example/embed/room');
  await page.getByRole('button', { name: 'Use chat URL' }).click();
  await expect(page.getByTitle('Custom live chat', { exact: true })).toHaveAttribute('src', 'https://chat.example/embed/room');
  await expect(page.frameLocator('iframe').getByText('Chat fixture')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('live-chat-mobile.png') });
  await page.getByRole('tab', { name: /Audience/ }).click();
  await expect(page.locator('iframe')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Live chat' }).click();
  await expect(page.getByTitle('Custom live chat', { exact: true })).toBeVisible();
  await play(page, 'https://video.example/live/2');
  await expect(page.locator('iframe')).toHaveCount(0);
  await play(page, url);
  await expect(page.getByTitle('Custom live chat', { exact: true })).toBeVisible();
  await page.getByText('Chat from another service', { exact: true }).click();
  await page.getByRole('button', { name: 'Use automatic chat' }).click();
  await expect(page.locator('iframe')).toHaveCount(0);
  await page.getByLabel(/Paste a pop-out/).fill('javascript:alert(1)');
  await page.getByRole('button', { name: 'Use chat URL' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Enter an external HTTPS chat URL.' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('self-hosted Owncast chat is recognized from resolver metadata', async ({ page }) => {
  await openStream(page, 'https://owncast.example/', { extractor_key: 'Owncast' });
  await page.getByRole('tab', { name: 'Live chat' }).click();
  await expect(page.getByTitle('Owncast live chat', { exact: true })).toHaveAttribute('src', 'https://owncast.example/embed/chat/readwrite');
});
