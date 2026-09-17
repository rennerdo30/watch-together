import { test, expect, type Page } from '@playwright/test';

import { autoQualityCap } from '../lib/abr';
import { sessionHighWater } from '../lib/bandwidth-memory';
import { capHeadroom, parseQualityMode } from '../lib/quality-mode';
import { stubAdaptiveStream, type VideoRung } from './adaptive-fixture';

/**
 * The inputs to the auto-quality cap, and the two ways it used to get stuck.
 *
 * A surface of zero pixels is not a tiny player: it is an element the
 * browser has not laid out. Treated as a size it capped auto at the
 * second-lowest rung of the ladder — and because the cap was only ever
 * recomputed when the element's CSS box changed, a viewer who never resized
 * their window kept that cap for the whole session, through manual picks and
 * back to Auto.
 *
 * The pixel ratio has the same reach and changes without any CSS box
 * changing at all: a window dragged to a monitor with different scaling
 * keeps its size in CSS pixels while each one becomes worth more device
 * pixels. Nothing observed that, so the cap stayed computed for the screen
 * the video started on.
 */

const ORIGINAL_URL = 'https://youtu.be/cap-guard-fixture';
const LADDER: VideoRung[] = [
  { id: 'v-240', height: 240, tbr: 50 },
  { id: 'v-720', height: 720, tbr: 100 },
  { id: 'v-1080', height: 1080, tbr: 200 },
  { id: 'v-2160', height: 2160, tbr: 300 },
];

test('an unmeasured surface caps nothing at all', () => {
  const ladder = [240, 360, 720, 1080, 1440, 2160];
  // What it used to do with a surface of 0: rungs[0 + 1], the second rung.
  expect(ladder[1]).toBe(360);
  for (const surface of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(autoQualityCap(ladder, surface, 1)).toBeNull();
  }
  // A real surface still caps exactly as before.
  expect(autoQualityCap(ladder, 450, 1)).toBe(1080);
  expect(autoQualityCap(ladder, 1, 1)).toBe(360);
});

test('a mode names its headroom, and anything unrecognised is Balanced', () => {
  expect(capHeadroom('highest')).toBeNull();
  expect(capHeadroom('saver')).toBe(0);
  expect(capHeadroom('balanced')).toBe(1);
  for (const value of [null, undefined, '', 'HIGHEST', 'constructor', 'toString', 'auto']) {
    expect(parseQualityMode(value)).toBe('balanced');
  }
  for (const value of ['balanced', 'highest', 'saver'] as const) {
    expect(parseQualityMode(value)).toBe(value);
  }
});

test('what is remembered is the best the connection reached, not the last dip', () => {
  let best = sessionHighWater(null, 8_000_000);
  expect(best).toBe(8_000_000);
  // A wifi dip, a competing download, a cold server cache: one bad sample
  // used to be what the next session opened on.
  best = sessionHighWater(best, 300_000);
  expect(best).toBe(8_000_000);
  best = sessionHighWater(best, 12_000_000);
  expect(best).toBe(12_000_000);
  for (const junk of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(sessionHighWater(best, junk)).toBe(12_000_000);
  }
  expect(sessionHighWater(null, Number.NaN)).toBeNull();
});

/**
 * Report every `dppx` media query the page opens, and let the test fire its
 * change listener — Playwright cannot move a window between monitors.
 */
async function interceptPixelRatioQueries(page: Page) {
  await page.addInitScript(() => {
    const listeners: (() => void)[] = [];
    (window as unknown as { __dprListeners: typeof listeners }).__dprListeners = listeners;
    const real = window.matchMedia.bind(window);
    window.matchMedia = (query: string) => {
      const list = real(query);
      if (!query.includes('dppx')) return list;
      const addEventListener = list.addEventListener.bind(list);
      list.addEventListener = ((type: string, listener: EventListener, ...rest: unknown[]) => {
        if (type === 'change') listeners.push(listener as () => void);
        return addEventListener(type, listener as EventListener, ...rest as []);
      }) as typeof list.addEventListener;
      return list;
    };
  });
}

async function openStats(page: Page) {
  await page.mouse.move(300, 120);
  await page.getByRole('button', { name: /statistic/i }).click();
  const stats = page.locator('div[aria-label="Playback statistics"]');
  await expect(stats).toBeVisible();
  return stats;
}

test('a pixel ratio that changes without a resize re-computes the cap', async ({ page }) => {
  await interceptPixelRatioQueries(page);
  await stubAdaptiveStream(page, ORIGINAL_URL, LADDER);
  await page.goto(`/room/e2e-dpr-${Date.now().toString(36)}?user=dpr@example.com`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  await page.getByPlaceholder('Paste video URL...').fill(ORIGINAL_URL);
  await page.getByPlaceholder('Paste video URL...').press('Enter');
  const media = page.locator('video[data-stream-type="mse"]');
  await expect(media).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.readyState >= 2),
    { timeout: 15_000 }).toBe(true);

  const stats = await openStats(page);
  const capRow = stats.getByTestId('stat-auto-cap');
  await expect(capRow).toContainText('1080p');
  const surfaceAtOne = await capRow.textContent();

  // The window "moves to a screen that draws twice as many pixels": the CSS
  // box is untouched, so the ResizeObserver stays silent.
  await page.evaluate(() => {
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    // Only the newest query is armed: handling a change re-arms a fresh one
    // for the ratio just reached, so the recorded list grows as it is used.
    const listeners = (window as unknown as { __dprListeners: (() => void)[] }).__dprListeners;
    listeners[listeners.length - 1]?.();
  });

  await expect(capRow).toContainText('2160p');
  expect(await capRow.textContent()).not.toBe(surfaceAtOne);
});
