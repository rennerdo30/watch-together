import { test, expect } from '@playwright/test';
import { loadBackground } from './extension-harness';
import { stubAdaptiveStream } from './adaptive-fixture';

type Alarms = { __extensionAlarms: Record<string, { scheduledTime: number; periodInMinutes: number }> };

test('worker wake restores missing sync alarms without an install event', async ({ page }) => {
  await loadBackground(page, { sync: { autoSync: true } });
  await expect.poll(() => page.evaluate(() => (window as unknown as Alarms).__extensionAlarms.cookieSync))
    .toMatchObject({ periodInMinutes: 10 });
});

test('worker wake preserves an existing deadline and respects disabled sync', async ({ page }) => {
  const alarm = { periodInMinutes: 10, scheduledTime: Date.now() + 60_000 };
  await loadBackground(page, { sync: { autoSync: true }, alarms: { cookieSync: alarm } });
  expect(await page.evaluate(() => (window as unknown as Alarms).__extensionAlarms.cookieSync)).toEqual(alarm);
  await loadBackground(page, { sync: { autoSync: false }, alarms: { cookieSync: alarm } });
  await expect.poll(() => page.evaluate(() => (window as unknown as Alarms).__extensionAlarms.cookieSync))
    .toBeUndefined();
});

test('ending beside a heartbeat removes the finished item and clears the player', async ({ page }) => {
  await stubAdaptiveStream(page, 'https://youtu.be/performance-ended');
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        Object.assign(window, { roomSocket: this });
      }
    };
  });
  await page.goto(`/room/perf-ended-${Date.now()}?user=performance@example.com`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible();
  await page.getByPlaceholder('Paste video URL...').fill('https://youtu.be/performance-ended');
  await page.getByPlaceholder('Paste video URL...').press('Enter');
  const video = page.locator('video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThan(1);
  await page.evaluate(() => {
    const video = document.querySelector('video')!;
    (window as unknown as { roomSocket: WebSocket }).roomSocket.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'heartbeat', payload: { timestamp: video.currentTime, is_playing: true } }),
    }));
    video.dispatchEvent(new Event('ended'));
  });
  await expect(video).toHaveCount(0);
});

test('slow initial media still starts at the beginning', async ({ page }) => {
  test.setTimeout(40_000);
  await stubAdaptiveStream(page, 'https://youtu.be/performance-start');
  await page.route('**/api/dash-manifest**', async route => {
    await new Promise(resolve => setTimeout(resolve, 8_000));
    await route.fallback();
  });
  await page.route('**/api/proxy**', async route => {
    await new Promise(resolve => setTimeout(resolve, 2_000));
    await route.fallback();
  });
  await page.addInitScript(() => {
    document.addEventListener('playing', event => {
      if (event.target instanceof HTMLVideoElement) {
        Object.assign(window, { firstPlayedAt: event.target.currentTime });
      }
    }, { capture: true, once: true });
  });
  await page.goto(`/room/perf-start-${Date.now()}?user=performance@example.com`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible();
  await page.getByPlaceholder('Paste video URL...').fill('https://youtu.be/performance-start');
  await page.getByPlaceholder('Paste video URL...').press('Enter');
  await expect.poll(() => page.evaluate(() => (window as unknown as { firstPlayedAt?: number }).firstPlayedAt),
    { timeout: 25_000 }).toBeLessThan(1);
});

test('a user pause beside a heartbeat is sent, while remote pauses are not echoed', async ({ page }) => {
  const original = 'https://youtu.be/performance-pause';
  await stubAdaptiveStream(page, original);
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    const sent: string[] = [];
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        Object.assign(window, { roomSocket: this, sent });
      }
      send(data: Parameters<WebSocket['send']>[0]) {
        if (typeof data === 'string') sent.push(data);
        super.send(data);
      }
    };
  });
  await page.goto(`/room/perf-pause-${Date.now()}?user=performance@example.com`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible();
  await page.getByPlaceholder('Paste video URL...').fill(original);
  await page.getByPlaceholder('Paste video URL...').press('Enter');
  const video = page.locator('video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0.5);
  await page.evaluate(() => {
    const video = document.querySelector('video')!;
    (window as unknown as { roomSocket: WebSocket }).roomSocket.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'heartbeat', payload: { timestamp: video.currentTime, is_playing: true } }),
    }));
    video.pause();
  });
  await expect(page.getByText('Paused', { exact: true }).first()).toBeVisible();
  const pauseCount = () => page.evaluate(() => (window as unknown as { sent: string[] }).sent
    .filter(raw => JSON.parse(raw).type === 'pause').length);
  expect(await pauseCount()).toBe(1);
  await page.evaluate(() => {
    const socket = (window as unknown as { roomSocket: WebSocket }).roomSocket;
    const video = document.querySelector('video')!;
    // Simulate the server applying playback to this viewer.
    socket.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'play', payload: { timestamp: video.currentTime } }),
    }));
  });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => !v.paused)).toBe(true);
  await page.evaluate(() => {
    const socket = (window as unknown as { roomSocket: WebSocket }).roomSocket;
    const video = document.querySelector('video')!;
    socket.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'pause', payload: { timestamp: video.currentTime } }),
    }));
  });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await page.waitForTimeout(500);
  expect(await pauseCount()).toBe(1);
});
