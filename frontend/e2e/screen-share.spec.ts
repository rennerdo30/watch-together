import { test, expect, type Page } from '@playwright/test';

/**
 * One member's screen on the room's player, carried by the server.
 *
 * Everything here is real except the screen picker: `getDisplayMedia` is
 * replaced with a canvas that paints a moving square, so the test never
 * needs a desktop to capture. What follows it — `MediaRecorder` encoding
 * the capture, the chunks going up the share's WebSocket, the server
 * retaining the header and fanning the rest out, the viewer appending them
 * to a `SourceBuffer` — is the production path in full.
 *
 * Unlike the peer-to-peer transport this replaced, all of it is testable
 * here. That one needed a UDP path between two browsers on one host, which
 * a sandboxed runner blocks, so its spec could assert that a track arrived
 * and had to stop there. This one asserts what actually matters: that the
 * viewer's `<video>` decodes frames and its clock moves — and how long the
 * picture took to travel, measured from the pixel changing on the sharer's
 * canvas to the same colour reaching the viewer's element.
 */

const USER_A = 'sharer@example.com';
const USER_B = 'viewer@example.com';
const USER_C = 'latecomer@example.com';

/** How long a relayed picture may take to appear before this is a bug. */
const LATENCY_CEILING_MS = 10_000;

/**
 * Replace the screen picker with a canvas nobody has to choose.
 *
 * The square keeps moving because a still picture encodes to almost
 * nothing, and a stream of nearly empty chunks would prove nothing about a
 * transport. `window.__paintRed` repaints the whole canvas in one colour
 * and remembers when: that is the mark the viewer watches for.
 */
async function stubScreenCapture(page: Page) {
  await page.addInitScript(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext('2d')!;
    let x = 0;
    let red = false;
    setInterval(() => {
      x = (x + 11) % canvas.width;
      context.fillStyle = red ? '#ff0000' : '#101820';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = red ? '#ff0000' : '#7dd3fc';
      context.fillRect(x, 140, 90, 90);
    }, 33);
    (window as unknown as { __paintRed: () => number }).__paintRed = () => {
      red = true;
      const at = Date.now();
      (window as unknown as { __redAt: number }).__redAt = at;
      return at;
    };
    navigator.mediaDevices.getDisplayMedia = async () => canvas.captureStream(30);
  });
}

async function joinRoom(page: Page, roomId: string, user: string) {
  await stubScreenCapture(page);
  await page.goto(`/room/${roomId}?user=${encodeURIComponent(user)}`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
}

async function startSharing(page: Page) {
  await page.getByRole('button', { name: 'Share screen' }).click();
  await expect(page.getByRole('dialog', { name: 'Share your screen' })).toBeVisible();
  await page.getByRole('button', { name: 'Choose what to share' }).click();
}

/** What the player is actually doing with what it was given. */
async function playback(page: Page) {
  return page.evaluate(async () => {
    const video = document.querySelector('video[data-stream-type="share"]') as HTMLVideoElement | null;
    if (!video) return null;
    const before = video.currentTime;
    await new Promise((resolve) => setTimeout(resolve, 700));
    return {
      readyState: video.readyState,
      videoWidth: video.videoWidth,
      advanced: video.currentTime > before,
      error: video.error ? video.error.code : null,
    };
  });
}

/**
 * How long the relayed picture takes to arrive: the sharer floods its
 * capture with red, and the viewer samples its own `<video>` until the
 * decoded frames are red too.
 */
async function measureLatency(sharer: Page, viewer: Page): Promise<number> {
  const paintedAt = await sharer.evaluate(
    () => (window as unknown as { __paintRed: () => number }).__paintRed());
  const seenAt = await viewer.evaluate(async (ceiling) => {
    const video = document.querySelector('video[data-stream-type="share"]') as HTMLVideoElement;
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    const deadline = Date.now() + ceiling;
    while (Date.now() < deadline) {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const [r, g, b] = context.getImageData(16, 16, 1, 1).data;
      if (r > 170 && g < 90 && b < 90) return Date.now();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return 0;
  }, LATENCY_CEILING_MS);

  expect(seenAt, 'the viewer never decoded the frame the sharer painted').toBeGreaterThan(0);
  return seenAt - paintedAt;
}

test('a member shares their screen and the room decodes it', async ({ browser }) => {
  const roomId = `e2e-share-${Date.now().toString(36)}`;
  const sharerCtx = await browser.newContext();
  const viewerCtx = await browser.newContext();
  const sharer = await sharerCtx.newPage();
  const viewer = await viewerCtx.newPage();

  await joinRoom(sharer, roomId, USER_A);
  await joinRoom(viewer, roomId, USER_B);

  await startSharing(sharer);

  // The sharer sees their own capture straight away — that one never goes
  // near the server.
  await expect(sharer.locator('video[data-stream-type="share"]')).toHaveCount(1, { timeout: 15_000 });
  await expect(sharer.getByText('You are sharing your screen')).toBeVisible();

  // The other browser is told who is sharing and ends up playing what the
  // server relayed: frames decoded, dimensions known, clock moving.
  await expect(viewer.getByText(`${USER_A} is sharing their screen`)).toBeVisible({ timeout: 15_000 });
  await expect(viewer.locator('video[data-stream-type="share"]')).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(async () => (await playback(viewer))?.videoWidth ?? 0,
    { timeout: 30_000 }).toBeGreaterThan(0);

  const state = await playback(viewer);
  expect(state).not.toBeNull();
  expect(state!.error).toBeNull();
  expect(state!.readyState).toBeGreaterThanOrEqual(2);
  expect(state!.advanced, 'the viewer is holding a still frame').toBe(true);

  const latencyMs = await measureLatency(sharer, viewer);
  console.log(`[share] pixel-to-pixel latency: ${latencyMs} ms`);
  expect(latencyMs).toBeLessThan(LATENCY_CEILING_MS);

  // Nothing was resolved, proxied or queued to put it there.
  expect(await viewer.locator('[data-testid="queue-item"]').count()).toBe(0);

  await sharerCtx.close();
  await viewerCtx.close();
});

test('someone who joins after the share started still gets a picture', async ({ browser }) => {
  // The header is the first chunk of the stream and nothing decodes without
  // it, so this is the case the server keeps state for at all.
  const roomId = `e2e-share-late-${Date.now().toString(36)}`;
  const sharerCtx = await browser.newContext();
  const lateCtx = await browser.newContext();
  const sharer = await sharerCtx.newPage();
  const latecomer = await lateCtx.newPage();

  await joinRoom(sharer, roomId, USER_A);
  await startSharing(sharer);
  await expect(sharer.getByText('You are sharing your screen')).toBeVisible({ timeout: 15_000 });

  // Long enough that the header is far behind the live edge.
  await sharer.waitForTimeout(4000);

  await joinRoom(latecomer, roomId, USER_C);
  await expect(latecomer.getByText(`${USER_A} is sharing their screen`)).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await playback(latecomer))?.videoWidth ?? 0,
    { timeout: 30_000 }).toBeGreaterThan(0);

  const state = await playback(latecomer);
  expect(state!.error).toBeNull();
  expect(state!.advanced, 'the latecomer is holding a still frame').toBe(true);

  const latencyMs = await measureLatency(sharer, latecomer);
  console.log(`[share] pixel-to-pixel latency for a late joiner: ${latencyMs} ms`);

  await sharerCtx.close();
  await lateCtx.close();
});

test('only one member shares at a time, and stopping gives the room back',
  async ({ browser }) => {
    const roomId = `e2e-share-one-${Date.now().toString(36)}`;
    const sharerCtx = await browser.newContext();
    const viewerCtx = await browser.newContext();
    const sharer = await sharerCtx.newPage();
    const viewer = await viewerCtx.newPage();

    await joinRoom(sharer, roomId, USER_A);
    await joinRoom(viewer, roomId, USER_B);
    await startSharing(sharer);
    await expect(viewer.getByText(`${USER_A} is sharing their screen`)).toBeVisible({ timeout: 15_000 });

    // The room's one player has one source: the other member cannot start
    // a second share while this one runs.
    await expect(viewer.getByRole('button', { name: 'Share screen' })).toBeDisabled();

    await sharer.getByRole('button', { name: 'Stop sharing' }).click();

    // Both are returned to the room as it was.
    await expect(viewer.locator('video[data-stream-type="share"]')).toHaveCount(0, { timeout: 15_000 });
    await expect(viewer.getByText('Nothing playing yet')).toBeVisible({ timeout: 15_000 });
    await expect(viewer.getByRole('button', { name: 'Share screen' })).toBeEnabled();

    await sharerCtx.close();
    await viewerCtx.close();
  });

test('a sharer who leaves takes the share with them', async ({ browser }) => {
  const roomId = `e2e-share-leave-${Date.now().toString(36)}`;
  const sharerCtx = await browser.newContext();
  const viewerCtx = await browser.newContext();
  const sharer = await sharerCtx.newPage();
  const viewer = await viewerCtx.newPage();

  await joinRoom(sharer, roomId, USER_A);
  await joinRoom(viewer, roomId, USER_B);
  await startSharing(sharer);
  await expect(viewer.getByText(`${USER_A} is sharing their screen`)).toBeVisible({ timeout: 15_000 });

  // Closing the tab is what actually happens when someone wanders off; the
  // room must not be left watching a frame that will never change.
  await sharerCtx.close();

  await expect(viewer.locator('video[data-stream-type="share"]')).toHaveCount(0, { timeout: 20_000 });
  await expect(viewer.getByRole('button', { name: 'Share screen' })).toBeEnabled();

  await viewerCtx.close();
});
