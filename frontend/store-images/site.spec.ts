import { expect, test, type Browser } from '@playwright/test';
import path from 'node:path';
import { stubAdaptiveStream } from '../e2e/adaptive-fixture';
import { SCENE } from './scene';

/**
 * The website's and README's screenshots, captured from the running app:
 *
 *   npx playwright test -c store-images/playwright.config.ts site.spec.ts
 *
 * Output goes to docs/public/shots/, which the website serves and the
 * README links to.
 */

const OUT = path.resolve(__dirname, '../../docs/public/shots');
const VIEWPORT = { width: 1440, height: 900 };
const HIDE_OVERLAYS = `[data-sonner-toaster],[role=status][aria-live],div[style*="z-index: 9999"]{display:none!important} nextjs-portal{display:none!important}`;

type Scheme = 'dark' | 'light';

async function roomShot(browser: Browser, scheme: Scheme, file: string) {
  const roomId = `site-${scheme}-${Date.now().toString(36)}`;
  // The first member to join is the admin and may name the room.
  const others = await Promise.all(['sam@example.com', 'mia@example.com'].map(async (user) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`/room/${roomId}?user=${user}`);
    await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
    return context;
  }));
  const host = await browser.newContext({ viewport: VIEWPORT, colorScheme: scheme });
  const room = await host.newPage();
  await room.addInitScript((mode) => {
    localStorage.setItem('wt_color_mode', mode);
    localStorage.setItem('wt_extension_hint_dismissed', 'true');
  }, scheme);
  const url = 'https://youtu.be/site-evening';
  await stubAdaptiveStream(room, url, undefined, { title: 'Golden hour in the Dolomites: a slow walk above the clouds', channel: 'Evening Films' });
  await room.goto(`/room/${roomId}?user=alex@example.com`);
  await expect(room.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  await room.getByPlaceholder('Paste video URL...').fill(url);
  await room.getByPlaceholder('Paste video URL...').press('Enter');
  const video = room.locator('video[data-stream-type="mse"]');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
  await video.evaluate(async (v: HTMLVideoElement) => { v.muted = true; v.loop = true; await v.play(); });
  const admin = others[0].pages()[0];
  await admin.getByRole('button', { name: 'Room settings' }).click();
  await admin.getByLabel('Room name').fill('Movie night');
  await admin.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(room.getByText('Movie night').first()).toBeVisible({ timeout: 10_000 });
  // The fixture stream is a test card; a landscape stands in for the picture.
  await room.addStyleTag({ content: `video{opacity:0!important} [data-stream-type]{background:transparent} .on-dark.relative{background:${SCENE} center/cover !important} ${HIDE_OVERLAYS}` });
  await room.getByRole('tab', { name: /Audience/ }).click();
  await room.mouse.move(VIEWPORT.width * 0.35, VIEWPORT.height * 0.55);
  // Let the paste box's confirmation badge fade before the capture.
  await room.waitForTimeout(4_000);
  await room.screenshot({ path: path.join(OUT, file) });
  await Promise.all(others.map((context) => context.close()));
  await host.close();
}

test('capture the website screenshots', async ({ browser }) => {
  await roomShot(browser, 'dark', 'room-dark.png');
  await roomShot(browser, 'light', 'room-light.png');
});
