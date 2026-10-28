import { chromium, expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { stubAdaptiveStream } from '../e2e/adaptive-fixture';

/**
 * The Chrome Web Store images, rendered from the running app and the
 * unpacked extension and composed in HTML at the store's exact sizes.
 * Output goes next to this file; see listing.md for where each one goes.
 */

const OUT = path.resolve(__dirname, '../../store/chrome-web-store');
const EXTENSION = path.resolve(__dirname, '../../extension');
const TEAL_FROM = '#34cdb9';
const TEAL_TO = '#0e8f7d';

// The mascot from components/mascot.tsx, idle, as static markup.
const MASCOT = `<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg">
<defs><linearGradient id="m" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${TEAL_FROM}"/><stop offset="1" stop-color="${TEAL_TO}"/></linearGradient></defs>
<ellipse cx="40" cy="75" rx="17" ry="2.6" fill="#000" opacity=".25"/>
<g stroke="url(#m)" stroke-width="2.6" stroke-linecap="round"><path d="M33 15 25.5 4.5"/><path d="M47 15 54.5 4.5"/></g>
<circle cx="25" cy="4" r="2.6" fill="${TEAL_FROM}"/><circle cx="55" cy="4" r="2.6" fill="${TEAL_FROM}"/>
<rect x="36" y="56" width="8" height="9" rx="2" fill="${TEAL_TO}"/><path d="M30 67h20" stroke="${TEAL_TO}" stroke-width="5" stroke-linecap="round"/>
<rect x="7" y="14" width="66" height="45" rx="14" fill="url(#m)"/><rect x="12.5" y="19.5" width="55" height="34" rx="9.5" fill="#effcf9"/>
<ellipse cx="31" cy="36" rx="3.6" ry="5.2" fill="#0b4f46"/><ellipse cx="49" cy="36" rx="3.6" ry="5.2" fill="#0b4f46"/></svg>`;

// A calm evening landscape standing in for the video, so the screenshot shows
// a picture rather than the test card the fixture stream carries.
const SCENE = `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1600 900' preserveAspectRatio='xMidYMid slice'>
<defs><linearGradient id='s' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#1b2a4a'/><stop offset='.55' stop-color='#c2607a'/><stop offset='.8' stop-color='#f3a861'/></linearGradient></defs>
<rect width='1600' height='900' fill='url(#s)'/><circle cx='1080' cy='560' r='90' fill='#ffd9a0' opacity='.9'/>
<path d='M0 620 260 430 470 560 700 380 980 600 1230 450 1600 640V900H0Z' fill='#4a3557'/>
<path d='M0 720 300 560 560 690 820 540 1100 700 1380 580 1600 700V900H0Z' fill='#2c2240'/>
<path d='M0 800 400 690 760 790 1120 680 1600 790V900H0Z' fill='#17142a'/></svg>`)}")`;

const FONT = `font-family: 'Inter Tight', Inter, system-ui, sans-serif;`;

async function frame(page: Page, width: number, height: number, html: string, file: string) {
  await page.setViewportSize({ width, height });
  await page.setContent(`<!doctype html><html><head><style>
    *{margin:0;box-sizing:border-box} body{width:${width}px;height:${height}px;overflow:hidden;${FONT}color:#f2f4f7;
    background:radial-gradient(120% 90% at 0% 0%, #0f3b36 0%, #0a0b0d 55%) #0a0b0d}
    h1{font-weight:600;letter-spacing:-.02em} p{color:#9ba3ae}
    .shot{border-radius:14px;border:1px solid rgba(180,196,218,.14);box-shadow:0 30px 80px rgba(0,0,0,.55);display:block}
  </style></head><body>${html}</body></html>`);
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, file) });
}

const dataUri = (png: Buffer) => `data:image/png;base64,${png.toString('base64')}`;

test('render the Chrome Web Store images', async ({ browser }) => {
  // 1. The room, mid-video, with three people in it.
  // A fresh room each run (the id is never shown: the room is renamed).
  const roomId = `store-${Date.now().toString(36)}`;
  const viewers = await Promise.all(['sam@example.com', 'mia@example.com'].map(async (user) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`/room/${roomId}?user=${user}`);
    return context;
  }));
  const host = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
  const room = await host.newPage();
  await room.addInitScript(() => {
    localStorage.setItem('wt_color_mode', 'dark');
    localStorage.setItem('wt_extension_hint_dismissed', 'true');
  });
  const url = 'https://youtu.be/store-evening';
  await stubAdaptiveStream(room, url, undefined, { title: 'Golden hour in the Dolomites: a slow walk above the clouds', channel: 'Evening Films' });
  await room.goto(`/room/${roomId}?user=alex@example.com`);
  await expect(room.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  await room.getByPlaceholder('Paste video URL...').fill(url);
  await room.getByPlaceholder('Paste video URL...').press('Enter');
  const video = room.locator('video[data-stream-type="mse"]');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
  await video.evaluate(async (v: HTMLVideoElement) => { v.muted = true; v.loop = true; await v.play(); });
  // The first member to join is the admin and may name the room.
  const admin = viewers[0].pages()[0];
  await admin.getByRole('button', { name: 'Room settings' }).click();
  await admin.getByLabel('Room name').fill('Movie night');
  await admin.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(room.getByText('Movie night').first()).toBeVisible({ timeout: 10_000 });
  await room.addStyleTag({ content: `video{opacity:0!important} [data-stream-type]{background:transparent} .on-dark.relative{background:${SCENE} center/cover !important}
    [data-sonner-toaster],[role=status][aria-live],div[style*="z-index: 9999"]{display:none!important} nextjs-portal{display:none!important}` });
  await room.getByRole('tab', { name: /Audience/ }).click();
  await room.mouse.move(640, 420);
  await room.waitForTimeout(800);
  const roomShot = await room.screenshot();
  await Promise.all(viewers.map((context) => context.close()));
  await host.close();

  // 2. The extension's popup and settings, from the unpacked extension.
  const shots: Record<string, Buffer> = {};
  const extension = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true, colorScheme: 'dark', deviceScaleFactor: 2,
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  const worker = extension.serviceWorkers()[0] ?? await extension.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const popup = await extension.newPage();
  await popup.setViewportSize({ width: 340, height: 560 });
  await popup.goto(`chrome-extension://${id}/popup/popup.html`);
  await popup.waitForTimeout(600);
  shots.popup = await popup.locator('body').screenshot();
  const options = await extension.newPage();
  await options.setViewportSize({ width: 760, height: 900 });
  await options.goto(`chrome-extension://${id}/options/options.html`);
  await options.waitForTimeout(600);
  shots.options = await options.screenshot({ clip: { x: 60, y: 20, width: 640, height: 700 } });
  await extension.close();

  const canvas = await browser.newPage();
  const title = (heading: string, sub: string) =>
    `<h1 style="font-size:44px;line-height:1.1">${heading}</h1><p style="font-size:20px;line-height:1.45;margin-top:14px;max-width:520px">${sub}</p>`;

  await frame(canvas, 1280, 800, `
    <div style="padding:52px 64px 0">${title('Every video, in sync for the whole room', 'Your session plays the videos that need a signed-in account, for everyone watching with you.')}</div>
    <img class="shot" src="${dataUri(roomShot)}" style="position:absolute;left:64px;top:250px;width:1152px">`,
  'screenshot-1-room.png');

  await frame(canvas, 1280, 800, `
    <div style="position:absolute;left:96px;top:190px;width:560px">${title('Connect once. It keeps your session fresh.', 'Open your Watch Together site and connect it from the popup. Cookies for the sites you choose sync every 10 minutes while the browser is open.')}
      <p style="margin-top:28px;font-size:18px;color:#f2f4f7">Queue the page you are on in one click.</p></div>
    <img class="shot" src="${dataUri(shots.popup)}" style="position:absolute;right:120px;top:90px;width:400px">`,
  'screenshot-2-popup.png');

  await frame(canvas, 1280, 800, `
    <div style="position:absolute;left:96px;top:220px;width:480px">${title('You choose what syncs', 'Add or remove sites, sync by hand or turn automatic sync off, and reset everything from the settings page.')}</div>
    <img class="shot" src="${dataUri(shots.options)}" style="position:absolute;right:96px;top:64px;width:560px">`,
  'screenshot-3-settings.png');

  const fact = (heading: string, body: string) => `<div style="background:#14161a;border:1px solid rgba(180,196,218,.14);border-radius:16px;padding:24px 26px">
    <h2 style="font-size:22px;font-weight:600">${heading}</h2><p style="font-size:17px;line-height:1.5;margin-top:10px">${body}</p></div>`;
  await frame(canvas, 1280, 800, `
    <div style="display:flex;flex-direction:column;justify-content:center;height:100%;padding:0 96px">
    <div style="display:flex;align-items:center;gap:40px">
      <div style="width:150px;height:150px;flex:none">${MASCOT}</div>
      <div>${title('Your cookies stay in memory, never on disk', 'The instance holds your session only while you use it.')}</div></div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-top:64px">
      ${fact('Only over HTTPS', 'Cookies go only to the instance you connected, and only over an encrypted connection.')}
      ${fact('Gone in 30 minutes', 'Dropped 30 minutes after the last sync, when you disconnect, or when the server restarts.')}
      ${fact('Single videos only', 'Others in your room can play single videos with your session, never feeds, playlists or channels.')}
    </div></div>`,
  'screenshot-4-privacy.png');

  await frame(canvas, 440, 280, `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:14px">
      <div style="width:104px;height:104px">${MASCOT}</div>
      <div style="text-align:center"><h1 style="font-size:30px">Watch Together</h1><p style="font-size:16px;margin-top:4px">Cookie Sync</p></div></div>`,
  'promo-small-440x280.png');

  await frame(canvas, 1400, 560, `
    <div style="position:absolute;left:110px;top:150px;display:flex;align-items:center;gap:40px">
      <div style="width:200px;height:200px">${MASCOT}</div>
      <div><h1 style="font-size:58px">Watch Together</h1><p style="font-size:24px;margin-top:10px;max-width:520px">Watch with friends, with your own session.</p></div></div>
    <img class="shot" src="${dataUri(shots.popup)}" style="position:absolute;right:110px;top:60px;width:300px">`,
  'promo-marquee-1400x560.png');
});
