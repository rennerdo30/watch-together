import type { Page } from '@playwright/test';

import { fixtureResolve } from './adaptive-fixture';

/**
 * The server's side of adding a link to the queue, played in the page.
 *
 * A queue add carries only the link. The server shows it at once as a
 * pending entry — `{ original_url, title: <link>, pending: true, added_by }`
 * in a `queue_update` — resolves it, and then either replaces the entry with
 * the resolved one (same `original_url`) in another `queue_update`, or drops
 * it and tells the sender `{ type: 'resolve_failed', payload: { url, detail } }`.
 *
 * The real server resolves with yt-dlp, which cannot resolve the fixture
 * links a test uses, so the room socket is routed through this: everything
 * passes through to the real server except `queue_add`, which is answered
 * here to that contract. The entries it adds exist in this page only — the
 * server never hears of them — so a test using it can inspect and hover the
 * queue, not advance through it.
 */
export interface QueueEmulation {
  /** Every `queue_add` payload the page sent. */
  adds: unknown[];
}

export async function emulateQueueResolution(
  page: Page,
  options: {
    addedBy: string;
    /** How long the "server" takes to resolve. */
    resolveMs?: number;
    /** An error detail to fail with instead of resolving. */
    failWith?: (url: string) => string | null;
  },
): Promise<QueueEmulation> {
  const emulation: QueueEmulation = { adds: [] };
  let queue: Record<string, unknown>[] = [];
  let playingIndex = -1;

  // Only the room socket: `/ws/share/…` carries screen sharing.
  await page.routeWebSocket(/\/ws\/(?!share\/)[^/?]+/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      try {
        const payload = JSON.parse(String(message))?.payload;
        if (Array.isArray(payload?.queue)) queue = payload.queue;
        if (typeof payload?.playing_index === 'number') playingIndex = payload.playing_index;
      } catch {
        // Not JSON; pass it on regardless.
      }
      ws.send(message);
    });
    ws.onMessage((message) => {
      let parsed: { type?: string; payload?: { url?: unknown } } | null = null;
      try {
        parsed = JSON.parse(String(message));
      } catch {
        parsed = null;
      }
      if (parsed?.type !== 'queue_add') {
        server.send(message);
        return;
      }
      emulation.adds.push(parsed.payload);
      const url = parsed.payload?.url;
      if (typeof url !== 'string') return;
      const update = (entries: Record<string, unknown>[]) => {
        queue = entries;
        ws.send(JSON.stringify({ type: 'queue_update', payload: { queue: entries, playing_index: playingIndex } }));
      };
      update([...queue, { original_url: url, title: url, pending: true, added_by: options.addedBy }]);
      setTimeout(() => {
        const detail = options.failWith?.(url) ?? null;
        if (detail !== null) {
          update(queue.filter((entry) => entry.original_url !== url));
          ws.send(JSON.stringify({ type: 'resolve_failed', payload: { url, detail } }));
          return;
        }
        update(queue.map((entry) => entry.original_url === url
          ? { ...fixtureResolve(url), added_by: options.addedBy }
          : entry));
      }, options.resolveMs ?? 500);
    });
  });
  return emulation;
}
