import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { Page } from '@playwright/test';

const REPO_ROOT = path.resolve(__dirname, '../..');
const EXTENSION = path.join(REPO_ROOT, 'extension');

export type FetchRule = {
  /** Substring matched against the full requested URL. */
  includes: string;
  status?: number;
  body?: unknown;
  contentType?: string;
  delayMs?: number;
};

type HarnessOptions = {
  local?: Record<string, unknown>;
  sync?: Record<string, unknown>;
  fetchRules?: FetchRule[];
};

/**
 * Install enough of the Chrome extension API to execute the real background
 * worker in an ordinary Playwright page.
 *
 * The state objects stay visible as `window.__extensionLocal` and
 * `window.__extensionSync`, so a test can assert the exact persisted shape
 * after a connection attempt or migration.
 */
export async function loadBackground(page: Page, options: HarnessOptions = {}) {
  await page.goto('about:blank');
  await page.evaluate(({ local, sync, fetchRules }) => {
    const localState: Record<string, unknown> = structuredClone(local);
    const syncState: Record<string, unknown> = structuredClone(sync);
    const rules = structuredClone(fetchRules);

    function event() {
      const listeners: Array<(...args: unknown[]) => unknown> = [];
      return {
        listeners,
        addListener(listener: (...args: unknown[]) => unknown) {
          listeners.push(listener);
        },
      };
    }

    function storageArea(state: Record<string, unknown>) {
      return {
        async get(keys?: string[] | string | Record<string, unknown> | null) {
          if (keys == null) return { ...state };
          const result: Record<string, unknown> = {};
          const wanted = Array.isArray(keys)
            ? keys
            : typeof keys === 'string'
              ? [keys]
              : Object.keys(keys);
          for (const key of wanted) {
            if (key in state) result[key] = state[key];
            else if (typeof keys === 'object' && !Array.isArray(keys) && keys !== null) {
              result[key] = keys[key];
            }
          }
          return result;
        },
        async set(values: Record<string, unknown>) {
          Object.assign(state, structuredClone(values));
        },
        async remove(keys: string[] | string) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
        },
        async clear() {
          for (const key of Object.keys(state)) delete state[key];
        },
      };
    }

    const permissionsAdded = event();
    const permissionsRemoved = event();
    const onMessage = event();
    const onInstalled = event();
    const onAlarm = event();
    const onCompleted = event();
    const onTabUpdated = event();
    const onTabRemoved = event();

    Object.assign(window, {
      __extensionLocal: localState,
      __extensionSync: syncState,
      __extensionEvents: {
        permissionsAdded, permissionsRemoved, onMessage, onInstalled,
      },
      __removedPermissions: [] as string[],
    });

    Object.assign(window, {
      chrome: {
        storage: {
          local: storageArea(localState),
          sync: storageArea(syncState),
        },
        permissions: {
          async contains() { return true; },
          async request() { return true; },
          async remove({ origins }: { origins: string[] }) {
            (window as unknown as { __removedPermissions: string[] })
              .__removedPermissions.push(...origins);
            return true;
          },
          onAdded: permissionsAdded,
          onRemoved: permissionsRemoved,
        },
        runtime: {
          onMessage,
          onInstalled,
          async sendMessage() { return undefined; },
        },
        alarms: {
          create() {},
          async clear() { return true; },
          onAlarm,
        },
        cookies: { async getAll() { return []; } },
        tabs: {
          async query() { return []; },
          onUpdated: onTabUpdated,
          onRemoved: onTabRemoved,
        },
        webRequest: { onCompleted },
      },
    });

    window.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      const rule = rules.find((candidate) => url.includes(candidate.includes));
      if (!rule) throw new Error(`Unexpected fetch: ${url}`);
      if (rule.delayMs) await new Promise((resolve) => setTimeout(resolve, rule.delayMs));
      return new Response(JSON.stringify(rule.body ?? {}), {
        status: rule.status ?? 200,
        headers: {
          'Content-Type': rule.contentType ?? 'application/json',
        },
      });
    };
  }, {
    local: options.local ?? {},
    sync: options.sync ?? {},
    fetchRules: options.fetchRules ?? [],
  });

  await page.addScriptTag({
    content: readFileSync(path.join(EXTENSION, 'background.js'), 'utf8'),
  });
}

/** Load a real extension HTML page and script against a mocked Chrome API. */
export async function loadExtensionPage(
  page: Page,
  relativeHtml: string,
  relativeScript: string,
  chromeSetup: string,
) {
  const html = readFileSync(path.join(EXTENSION, relativeHtml), 'utf8');
  const script = readFileSync(path.join(EXTENSION, relativeScript), 'utf8');
  const cssPath = path.join(path.dirname(relativeHtml),
    html.match(/href="([^"]+\.css)"/)?.[1] ?? '');
  const css = cssPath.endsWith('.css')
    ? readFileSync(path.join(EXTENSION, cssPath), 'utf8')
    : '';

  // Both setup and the actual script are present before DOMContentLoaded, as
  // they are in the extension itself. Escaping the closing tag keeps embedded
  // source from terminating the wrapper early.
  const document = html
    .replace(/<link[^>]+href="[^"]+\.css"[^>]*>/, `<style>${css}</style>`)
    .replace(/<script[^>]+src="[^"]+"[^>]*><\/script>/,
      `<script>${chromeSetup}<\/script><script>${script.replace(/<\/script>/gi, '<\\/script>')}<\/script>`);

  await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(document)}`);
}
