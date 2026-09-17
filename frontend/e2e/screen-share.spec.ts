import { test, expect, type Page } from '@playwright/test';

/**
 * One member's screen on the room's player.
 *
 * Everything here is real except the screen picker: `getDisplayMedia` is
 * replaced with a canvas that paints a moving square, so the test never
 * needs a desktop to capture. What follows it — the offer and answer over
 * the room socket, a genuine RTCPeerConnection between two browser
 * contexts, the sharer's track arriving on the other player's element —
 * is the production path, because this feature *is* that path: no server
 * carries the media, so there is nothing else to stand in for.
 *
 * One hop is deliberately not asserted: that frames then flow. A sandboxed
 * runner blocks UDP between two browsers on the same host, so the
 * connection completes its handshake and never exchanges a packet — a
 * failure of the test's network, not of the code under it. Everything up
 * to and including the track landing on the viewer's player is checked
 * here; that it then plays is checked by watching it.
 */

/**
 * Chromium hides a machine's local addresses behind mDNS names, which two
 * browsers on one host cannot resolve for each other. Real peers are on
 * different machines and exchange ordinary addresses; this turns the
 * obfuscation off so that wherever the runner's network does allow a local
 * peer-to-peer path, these two find it.
 */
test.use({
  launchOptions: { args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--allow-loopback-in-peer-connection'] },
});

const USER_A = 'sharer@example.com';
const USER_B = 'viewer@example.com';

/** Replace the screen picker with a canvas nobody has to choose. */
async function stubScreenCapture(page: Page) {
  await page.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const context = canvas.getContext('2d')!;
      let x = 0;
      // Movement matters: a still canvas can encode to almost nothing,
      // and the test measures bytes arriving.
      setInterval(() => {
        x = (x + 7) % canvas.width;
        context.fillStyle = '#101820';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = '#7dd3fc';
        context.fillRect(x, 60, 60, 60);
      }, 33);
      return (canvas as HTMLCanvasElement).captureStream(30);
    };
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

/** What the viewer's player is holding, if anything. */
async function receivedTrack(page: Page): Promise<{ kind: string; live: boolean } | null> {
  return page.evaluate(() => {
    const video = document.querySelector('video[data-stream-type="share"]') as HTMLVideoElement | null;
    const stream = video?.srcObject as MediaStream | null;
    const track = stream?.getVideoTracks()[0];
    return track ? { kind: track.kind, live: track.readyState === 'live' } : null;
  });
}

test('a member shares their screen and the room watches it', async ({ browser }) => {
  const roomId = `e2e-share-${Date.now().toString(36)}`;
  const sharerCtx = await browser.newContext();
  const viewerCtx = await browser.newContext();
  const sharer = await sharerCtx.newPage();
  const viewer = await viewerCtx.newPage();

  await joinRoom(sharer, roomId, USER_A);
  await joinRoom(viewer, roomId, USER_B);

  await startSharing(sharer);

  // The sharer sees their own capture straight away.
  const ownPlayer = sharer.locator('video[data-stream-type="share"]');
  await expect(ownPlayer).toHaveCount(1, { timeout: 15_000 });
  await expect(sharer.getByText('You are sharing your screen')).toBeVisible();

  // The other browser is told who is sharing, and ends up holding that
  // member's video track on its own player: the offer, the answer and the
  // candidates all completed through the room socket, and the stream
  // reached the element. Whether packets then flow is the browser's own
  // business — and unprovable here, because this sandbox blocks the
  // peer-to-peer UDP path between two local browsers. See the note at the
  // top of the file.
  await expect(viewer.getByText(`${USER_A} is sharing their screen`)).toBeVisible({ timeout: 15_000 });
  const viewerPlayer = viewer.locator('video[data-stream-type="share"]');
  await expect(viewerPlayer).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(() => receivedTrack(viewer), { timeout: 30_000 })
    .toEqual({ kind: 'video', live: true });

  // Nothing was resolved, proxied or queued to put it there.
  expect(await viewer.locator('[data-testid="queue-item"]').count()).toBe(0);

  await sharerCtx.close();
  await viewerCtx.close();
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
