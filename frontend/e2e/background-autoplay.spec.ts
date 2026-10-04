import { test, expect, type Browser, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A room left open all day in a background tab.
 *
 * The way the room is used: everyone keeps the tab open, someone queues a
 * video, and the others are expected to start watching. Whether this tab may
 * start it with sound is up to the browser, and turns on whether the viewer
 * has clicked anywhere in the page since it loaded. Without that click the
 * video started muted (or not at all) in a tab nobody was looking at, the
 * title still said "Watch Together", and people did not notice the room was
 * playing.
 *
 * The policy is emulated the way Chrome applies it: `play()` is refused until
 * the page has had a user activation, so a real click in the test lifts it
 * exactly as it does for a viewer. The activation is tracked here rather than
 * read from the browser, because Playwright's own `evaluate` and locator
 * queries count as gestures and would lift it before the test begins. A hidden tab
 * and desktop notifications are emulated too; the sandbox has neither.
 *
 * Played from the VP9 fixture through hls.js: the sandbox's Chromium cannot
 * decode H.264 through MSE.
 */

const FIXTURE = path.resolve(__dirname, 'fixtures/live-vp9');
const INIT = readFileSync(path.join(FIXTURE, 'init.mp4'));
const SEGMENT = readFileSync(path.join(FIXTURE, 'segment.m4s'));
const SEGMENT_SECONDS = 2;
const TIMESCALE = 15360;
const SEGMENTS = 30;

const ORIGINAL_URL = 'https://www.youtube.com/watch?v=background-autoplay';
const TITLE = 'The video someone queued';
const BASE = 'http://localhost:3100/background-autoplay-fixture';

/** The fixture's one segment, re-timed to be segment `sequence` of the video. */
function segment(sequence: number): Buffer {
  const bytes = Buffer.from(SEGMENT);
  const tfdt = bytes.indexOf('tfdt');
  bytes.writeBigUInt64BE(BigInt(sequence * SEGMENT_SECONDS * TIMESCALE), tfdt + 8);
  return bytes;
}

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=320x180,CODECS="vp09.00.10.08"
${BASE}/playlist.m3u8
`;
const PLAYLIST = [
  '#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:2', '#EXT-X-PLAYLIST-TYPE:VOD',
  '#EXT-X-MEDIA-SEQUENCE:0', `#EXT-X-MAP:URI="${BASE}/init.mp4"`,
  ...Array.from({ length: SEGMENTS }, (_, i) => [`#EXTINF:2.000,`, `${BASE}/segment/${i}.m4s`]).flat(),
  '#EXT-X-ENDLIST', '',
].join('\n');

/** Serve the video, and answer the resolve with it. */
async function stubVideo(page: Page) {
  await page.route('**/api/resolve**', (route) => route.fulfill({ json: {
    original_url: ORIGINAL_URL, stream_url: `${BASE}/master.m3u8`, stream_type: 'hls',
    title: TITLE, duration: SEGMENTS * SEGMENT_SECONDS, is_live: false, available_qualities: [],
  } }));
  const serve: Parameters<typeof page.route>[1] = (route) => {
    const request = new URL(route.request().url());
    const url = request.searchParams.get('url') ?? request.href;
    if (url.endsWith('/init.mp4')) return route.fulfill({ contentType: 'video/mp4', body: INIT });
    const media = url.match(/\/segment\/(\d+)\.m4s$/);
    if (media) return route.fulfill({ contentType: 'video/mp4', body: segment(Number(media[1])) });
    return route.fulfill({
      contentType: 'application/vnd.apple.mpegurl',
      body: url.endsWith('/master.m3u8') ? MASTER : PLAYLIST,
    });
  };
  await page.route('**/background-autoplay-fixture/**', serve);
  await page.route('**/api/proxy**', serve);
}

/** Sticky activation, from trusted clicks and key presses only. */
const TRACK_ACTIVATION = `
  let activated = false;
  for (const type of ['pointerdown', 'keydown']) {
    window.addEventListener(type, (event) => { if (event.isTrusted) activated = true; }, true);
  }
  Object.defineProperty(Navigator.prototype, 'userActivation', {
    configurable: true, get: () => ({ hasBeenActive: activated, isActive: activated }),
  });
`;

/** Chrome's rule: no activation, no audible start. */
const REFUSE_AUDIBLE_UNTIL_ACTIVATED = TRACK_ACTIVATION + `
  const original = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    if (!this.muted && !navigator.userActivation.hasBeenActive) {
      return Promise.reject(new DOMException('play() failed because the user did not interact', 'NotAllowedError'));
    }
    return original.apply(this, arguments);
  };
`;

/** A stricter browser: no activation, no start at all, muted or not. */
const REFUSE_ALL_UNTIL_ACTIVATED = TRACK_ACTIVATION + `
  const original = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    if (!navigator.userActivation.hasBeenActive) {
      return Promise.reject(new DOMException('play() failed because the user did not interact', 'NotAllowedError'));
    }
    return original.apply(this, arguments);
  };
`;

/** A tab the test can send to the background, and a notification inbox. */
const BACKGROUND_TAB = `
  let hidden = false;
  Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(Document.prototype, 'visibilityState', {
    configurable: true, get: () => (hidden ? 'hidden' : 'visible'),
  });
  window.__setHidden = (value) => {
    hidden = value;
    document.dispatchEvent(new Event('visibilitychange'));
  };
  window.__notifications = [];
  class FakeNotification {
    static permission = 'granted';
    static requestPermission() { return Promise.resolve('granted'); }
    constructor(title, options) {
      this.title = title;
      this.body = options && options.body;
      window.__notifications.push({ title, body: this.body });
    }
    close() {}
  }
  window.Notification = FakeNotification;
`;

const setHidden = (page: Page, hidden: boolean) =>
  page.evaluate((value) => (window as unknown as { __setHidden: (v: boolean) => void }).__setHidden(value), hidden);
const notifications = (page: Page) =>
  page.evaluate(() => (window as unknown as { __notifications: Array<{ title: string; body: string }> }).__notifications);

function uniqueRoomId(label: string): string {
  return `e2e-${label}-${Date.now().toString(36)}`;
}

/** A member with the room open, as it is all day. */
async function openRoom(page: Page, roomId: string, user: string) {
  await stubVideo(page);
  await page.goto(`/room/${roomId}?user=${encodeURIComponent(user)}`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
}

/** Someone else in the room queues the video. */
async function queueFromAnotherMember(browser: Browser, roomId: string) {
  const other = await browser.newPage();
  await openRoom(other, roomId, 'queuer@example.com');
  await other.getByPlaceholder('Paste video URL...').fill(ORIGINAL_URL);
  await other.getByPlaceholder('Paste video URL...').press('Enter');
  return other;
}

/** A click somewhere in the room that has nothing to do with the player. */
const clickElsewhere = (page: Page) => page.locator('header h1').click();

test('a tab that has not been clicked yet asks for the click, and one anywhere answers it', async ({ page }) => {
  await page.addInitScript(REFUSE_AUDIBLE_UNTIL_ACTIVATED);
  await openRoom(page, uniqueRoomId('arm'), 'sitter@example.com');

  const prompt = page.getByText(/click anywhere in this tab so videos can start with sound/i);
  await expect(prompt).toBeVisible();
  await clickElsewhere(page);
  await expect(prompt).toHaveCount(0);
});

test('a browser that already allows sound is not asked for anything', async ({ page }) => {
  await openRoom(page, uniqueRoomId('arm-allowed'), 'sitter@example.com');
  await page.waitForTimeout(1500);
  await expect(page.getByText(/click anywhere in this tab/i)).toHaveCount(0);
  await expect(page.getByText(/unloaded this tab to save memory/i)).toHaveCount(0);
});

test('a tab Chrome unloaded to save memory says what was missed and how to stop it', async ({ page }) => {
  // What Chrome sets on a page reloaded after its Memory Saver discarded it.
  await page.addInitScript(`
    Object.defineProperty(Document.prototype, 'wasDiscarded', { configurable: true, get: () => true });
  `);
  await openRoom(page, uniqueRoomId('discarded'), 'sitter@example.com');

  const warning = page.getByRole('alert').filter({ hasText: /unloaded this tab to save memory/i });
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('Always keep these sites active');
  await page.getByRole('button', { name: 'Dismiss the unloaded tab warning' }).click();
  await expect(warning).toHaveCount(0);
});

test('a video started muted says so in the tab title, and a click anywhere brings the sound',
  async ({ page, browser }) => {
    const roomId = uniqueRoomId('muted-title');
    await page.addInitScript(REFUSE_AUDIBLE_UNTIL_ACTIVATED);
    await openRoom(page, roomId, 'sitter@example.com');
    const other = await queueFromAnotherMember(browser, roomId);

    const media = page.locator('video');
    await expect.poll(() => media.evaluate((v: HTMLVideoElement) => !v.paused && v.muted), { timeout: 20_000 }).toBe(true);
    await expect(page).toHaveTitle(new RegExp(`^🔇 Playing muted · ${TITLE}`));

    // Not the prompt, not the speaker: wherever the viewer happens to click.
    await clickElsewhere(page);
    await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.muted)).toBe(false);
    expect(await media.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
    await expect(page).toHaveTitle(new RegExp(`^▶ ${TITLE}`));
    await expect(page.getByRole('button', { name: /click for sound/i })).toHaveCount(0);

    await other.close();
  });

test('a video held back entirely says so in the tab title, and a click anywhere joins it',
  async ({ page, browser }) => {
    const roomId = uniqueRoomId('blocked-title');
    await page.addInitScript(REFUSE_ALL_UNTIL_ACTIVATED);
    await openRoom(page, roomId, 'sitter@example.com');
    const other = await queueFromAnotherMember(browser, roomId);

    await expect(page.getByRole('button', { name: /click to join playback/i })).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveTitle(new RegExp(`^⏸ Click to join · ${TITLE}`));

    await clickElsewhere(page);
    const media = page.locator('video');
    await expect.poll(() => media.evaluate((v: HTMLVideoElement) => !v.paused && !v.muted)).toBe(true);
    await expect(page.getByRole('button', { name: /click to join playback/i })).toHaveCount(0);
    await expect(page).toHaveTitle(new RegExp(`^▶ ${TITLE}`));

    await other.close();
  });

test('a viewer in another tab is notified when a video starts, and told when it started muted',
  async ({ page, browser }) => {
    const roomId = uniqueRoomId('notify');
    await page.addInitScript(BACKGROUND_TAB);
    await page.addInitScript(REFUSE_AUDIBLE_UNTIL_ACTIVATED);
    await openRoom(page, roomId, 'sitter@example.com');
    // The viewer opts in; the room is otherwise silent about this.
    await page.evaluate(() => localStorage.setItem('w2g-notify-video-start', 'true'));
    await page.reload();
    await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Notify me when a video starts' })).toHaveAttribute('aria-pressed', 'true');
    await setHidden(page, true);

    const other = await queueFromAnotherMember(browser, roomId);
    await expect.poll(() => notifications(page), { timeout: 20_000 }).toEqual([
      { title: `Now playing: ${TITLE}`, body: 'Added by queuer' },
      expect.objectContaining({ title: `${TITLE} is playing muted` }),
    ]);
    await other.close();
  });

test('a start refused while the tab was hidden is retried the moment the viewer looks',
  async ({ page, browser }) => {
    const roomId = uniqueRoomId('visible-retry');
    await page.addInitScript(BACKGROUND_TAB);
    // Refused for as long as the tab is hidden, however it is asked.
    await page.addInitScript(`
      const original = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        if (document.hidden) {
          return Promise.reject(new DOMException('play() failed', 'NotAllowedError'));
        }
        return original.apply(this, arguments);
      };
    `);
    await openRoom(page, roomId, 'sitter@example.com');
    await setHidden(page, true);
    const other = await queueFromAnotherMember(browser, roomId);

    await expect(page).toHaveTitle(new RegExp(`^⏸ Click to join · ${TITLE}`), { timeout: 20_000 });
    const media = page.locator('video');
    expect(await media.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);

    // No click: coming back to the tab is enough.
    await setHidden(page, false);
    await expect.poll(() => media.evaluate((v: HTMLVideoElement) => !v.paused)).toBe(true);
    await expect(page).toHaveTitle(new RegExp(`^▶ ${TITLE}`));

    await other.close();
  });
