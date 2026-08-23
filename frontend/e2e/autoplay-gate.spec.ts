import { test, expect } from '@playwright/test';

import { stubAdaptiveStream } from './adaptive-fixture';

/**
 * What happens to a viewer whose browser refuses to autoplay.
 *
 * A page that has had no user gesture may not start audible playback, and the
 * rejected `play()` promise is the only signal — the element just stays
 * paused. Every call site swallowed that rejection into a `console.log`, and
 * the `play` message broadcast by another member did not even attach a catch,
 * so a friend joining a room that was already playing sat on a still frame
 * with nothing to tell them why and had to press play by hand.
 *
 * Playwright's Chromium allows autoplay, so the refusal is injected: `play()`
 * is made to reject exactly the way a real policy block does.
 */

const USER = 'autoplay@example.com';
const ORIGINAL_URL = 'https://youtu.be/autoplay-fixture';

function uniqueRoomId(label: string): string {
  return `e2e-${label}-${Date.now().toString(36)}`;
}

/** Make `play()` reject unless the element is muted, as the policy does. */
const REFUSE_AUDIBLE_AUTOPLAY = `
  const original = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    if (!this.muted) {
      return Promise.reject(
        new DOMException('play() failed because the user did not interact', 'NotAllowedError'));
    }
    return original.apply(this, arguments);
  };
`;

/** Make `play()` reject however it is called: not even muted is permitted. */
const REFUSE_ALL_AUTOPLAY = `
  HTMLMediaElement.prototype.play = function () {
    return Promise.reject(
      new DOMException('play() failed because the user did not interact', 'NotAllowedError'));
  };
`;

async function openPlayingRoom(page: import('@playwright/test').Page, label: string) {
  await stubAdaptiveStream(page, ORIGINAL_URL);

  await page.goto(`/room/${uniqueRoomId(label)}?user=${encodeURIComponent(USER)}`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });

  await page.getByPlaceholder('Paste video URL...').fill(ORIGINAL_URL);
  await page.getByPlaceholder('Paste video URL...').press('Enter');

  return page.locator('video[data-stream-type="mse"]');
}

test('a viewer whose browser refuses to autoplay is told, and can join with one click',
  async ({ page }) => {
    await page.addInitScript(REFUSE_ALL_AUTOPLAY);
    const media = await openPlayingRoom(page, 'blocked');
    await expect(media).toHaveCount(1, { timeout: 15_000 });

    // The whole point: something visible says why nothing is happening.
    const gate = page.getByRole('button', { name: /click to join playback/i });
    await expect(gate).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/blocks video from starting on its own/i)).toBeVisible();
  });

test('an audible block falls back to muted playback rather than stopping',
  async ({ page }) => {
    await page.addInitScript(REFUSE_AUDIBLE_AUTOPLAY);
    const media = await openPlayingRoom(page, 'muted');
    await expect(media).toHaveCount(1, { timeout: 15_000 });

    // Being in sync without sound beats being stopped, and the viewer is
    // offered their sound back in one click.
    await expect(page.getByRole('button', { name: /click for sound/i }))
      .toBeVisible({ timeout: 15_000 });
    expect(await media.evaluate((v: HTMLVideoElement) => v.muted)).toBe(true);
    // No hard gate: playback was not refused outright.
    await expect(page.getByRole('button', { name: /click to join playback/i }))
      .toHaveCount(0);
  });

test('a viewer whose browser allows autoplay sees neither prompt', async ({ page }) => {
  const media = await openPlayingRoom(page, 'allowed');
  await expect(media).toHaveCount(1, { timeout: 15_000 });
  await page.waitForTimeout(2000);

  await expect(page.getByRole('button', { name: /click to join playback/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /click for sound/i })).toHaveCount(0);
});
