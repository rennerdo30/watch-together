import { test, expect } from '@playwright/test';

import { loadBackground } from './extension-harness';

/**
 * The background service worker does not stay alive.
 *
 * Chrome stops a Manifest V3 worker after about thirty seconds without
 * events, sooner under its energy saver. A stream the worker noticed was
 * kept in a variable, so once the worker had been stopped the popup was
 * told "no stream detected" for a tab that had been playing for minutes.
 * Detected streams now live in session storage, which the next worker
 * instance reads.
 */

const TAB_ID = 7;
const MANIFEST_URL = 'https://usher.ttvnw.net/api/channel/hls/streamer.m3u8?token=abc';
const PAGE_URL = 'https://www.twitch.tv';

type Listener = (...args: unknown[]) => unknown;
type Harness = {
  __extensionSession: Record<string, unknown>;
  __extensionEvents: Record<string, { listeners: Listener[] }>;
};

/** Deliver a completed request to the worker, as the browser would. */
async function completeRequest(page: import('@playwright/test').Page, details: object) {
  await page.evaluate((d) => {
    const { onCompleted } = (window as unknown as Harness).__extensionEvents;
    for (const listener of onCompleted.listeners) listener(d);
  }, details);
}

/** Ask the worker what it knows about a tab, as the popup does. */
function askDetectedStream(page: import('@playwright/test').Page, tabId: number) {
  return page.evaluate((id) => new Promise((resolve) => {
    const { onMessage } = (window as unknown as Harness).__extensionEvents;
    for (const listener of onMessage.listeners) {
      listener({ type: 'GET_DETECTED_STREAM', tabId: id }, {}, resolve);
    }
  }), tabId);
}

test('a detected stream is still known after the worker has been stopped', async ({ page }) => {
  await loadBackground(page);
  await completeRequest(page, { url: MANIFEST_URL, tabId: TAB_ID, initiator: PAGE_URL });
  await expect.poll(() => page.evaluate(() => (window as unknown as Harness).__extensionSession))
    .toMatchObject({ detectedStreams: { [TAB_ID]: { type: 'hls', url: MANIFEST_URL, pageUrl: PAGE_URL } } });

  // The browser stops the idle worker. The one it starts later has empty
  // variables and the same session storage.
  const session = await page.evaluate(() => (window as unknown as Harness).__extensionSession);
  await loadBackground(page, { session });

  expect(await askDetectedStream(page, TAB_ID))
    .toMatchObject({ stream: { type: 'hls', url: MANIFEST_URL, pageUrl: PAGE_URL } });
});

test('a detection and a navigation landing together both take effect', async ({ page }) => {
  const OTHER_TAB = 9;
  await loadBackground(page, {
    session: { detectedStreams: { [OTHER_TAB]: { url: MANIFEST_URL, type: 'hls', timestamp: 1, pageUrl: PAGE_URL } } },
  });
  // Neither event waits for the other: each is a read-modify-write of the
  // same key, and the later write used to discard the earlier change.
  await page.evaluate(({ url, tabId, otherTab, pageUrl }) => {
    const { onCompleted, onTabUpdated } = (window as unknown as Harness).__extensionEvents;
    for (const listener of onCompleted.listeners) listener({ url, tabId, initiator: pageUrl });
    for (const listener of onTabUpdated.listeners) listener(otherTab, { status: 'loading' });
  }, { url: MANIFEST_URL, tabId: TAB_ID, otherTab: OTHER_TAB, pageUrl: PAGE_URL });

  await expect.poll(() => askDetectedStream(page, TAB_ID)).toMatchObject({ stream: { type: 'hls' } });
  await expect.poll(() => askDetectedStream(page, OTHER_TAB)).toEqual({ stream: null });
});

test('closing or navigating the tab forgets its stream', async ({ page }) => {
  await loadBackground(page);
  await completeRequest(page, { url: MANIFEST_URL, tabId: TAB_ID, initiator: PAGE_URL });
  await expect.poll(() => askDetectedStream(page, TAB_ID)).toMatchObject({ stream: { type: 'hls' } });

  await page.evaluate((id) => {
    const { onTabUpdated } = (window as unknown as Harness).__extensionEvents;
    for (const listener of onTabUpdated.listeners) listener(id, { status: 'loading' });
  }, TAB_ID);
  await expect.poll(() => askDetectedStream(page, TAB_ID)).toEqual({ stream: null });

  await completeRequest(page, { url: MANIFEST_URL, tabId: TAB_ID, initiator: PAGE_URL });
  await expect.poll(() => askDetectedStream(page, TAB_ID)).toMatchObject({ stream: { type: 'hls' } });
  await page.evaluate((id) => {
    const { onTabRemoved } = (window as unknown as Harness).__extensionEvents;
    for (const listener of onTabRemoved.listeners) listener(id);
  }, TAB_ID);
  await expect.poll(() => askDetectedStream(page, TAB_ID)).toEqual({ stream: null });
});
