import { test, expect } from '@playwright/test';

import { loadBackground, loadExtensionPage } from './extension-harness';

/**
 * Regression coverage for one browser displaying or operating as another
 * Watch Together user.
 *
 * Older extension builds put token/email/backend in chrome.storage.sync. The
 * background worker later moved credentials to local storage, but the options
 * page kept reading sync forever. Thus Bob's current local connection could
 * coexist with synchronized Alice credentials — Settings displayed and could
 * copy Alice's token while "Sync now" actually ran as Bob.
 */

test('options ignores stale synchronized credentials and shows verified status',
  async ({ page }) => {
    const setup = `
      const staleSync = {
        token: 'alice-stale-token',
        userEmail: 'alice@example.com',
        backendUrl: 'https://old.example',
        lastSync: 1,
        domains: ['.youtube.com'],
        autoSync: true,
      };
      window.chrome = {
        runtime: {
          sendMessage: async (message) => {
            if (message.type === 'GET_STATUS') return {
              connected: true,
              userEmail: 'bob@example.com',
              backendUrl: 'https://current.example',
              lastSync: 2000,
            };
            return { success: true };
          },
        },
        storage: {
          sync: {
            get: async () => ({ ...staleSync }),
            set: async () => undefined,
          },
        },
      };
    `;
    await loadExtensionPage(
      page, 'options/options.html', 'options/options.js', setup);

    await expect(page.locator('#statusText')).toHaveText('Connected');
    await expect(page.locator('#userEmail')).toHaveText('bob@example.com');
    await expect(page.locator('#backendUrl')).toHaveValue('https://current.example');
    await expect(page.getByText('alice@example.com')).toHaveCount(0);
    await expect(page.locator('#tokenInput')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /copy token/i })).toHaveCount(0);
  });

test('token owner and current browser session must agree', async ({ page }) => {
  await loadBackground(page, {
    local: {
      activeConnection: { origin: 'https://watch.example', token: 'alice-token' },
    },
    fetchRules: [
      {
        includes: '/api/extension/status',
        body: { valid: true, user_email: 'alice@example.com' },
      },
      {
        includes: '/api/me',
        body: { authenticated: true, email: 'bob@example.com' },
      },
    ],
  });

  const status = await page.evaluate(async () =>
    (window as unknown as { getStatus(): Promise<Record<string, unknown>> }).getStatus());

  expect(status.connected).toBe(false);
  expect(status.userEmail).toBeNull();
  expect(status.connectionReason).toBe('account-changed');
  expect(String(status.connectionError)).toContain('bob@example.com');
  const local = await page.evaluate(() =>
    (window as unknown as { __extensionLocal: Record<string, unknown> }).__extensionLocal);
  expect(local.activeConnection).toBeUndefined();
});

test('an expired site session stops syncing without discarding the token',
  async ({ page }) => {
    const connection = { origin: 'https://watch.example', token: 'alice-token' };
    await loadBackground(page, {
      local: { activeConnection: connection },
      fetchRules: [
        {
          includes: '/api/extension/status',
          body: { valid: true, user_email: 'alice@example.com' },
        },
        { includes: '/api/me', body: { authenticated: false, email: null } },
      ],
    });

    const status = await page.evaluate(async () =>
      (window as unknown as { getStatus(): Promise<Record<string, unknown>> }).getStatus());

    // Not connected, so no cookie upload can attribute this browser's cookies
    // to the token's account — but the credential survives a re-login.
    expect(status.connected).toBe(false);
    expect(status.userEmail).toBeNull();
    expect(status.connectionReason).toBe('signed-out');
    const local = await page.evaluate(() =>
      (window as unknown as { __extensionLocal: Record<string, unknown> }).__extensionLocal);
    expect(local.activeConnection).toEqual(connection);
  });

test('a failed instance switch cannot mix a new backend with the old token',
  async ({ page }) => {
    const old = { origin: 'https://old.example', token: 'old-token' };
    await loadBackground(page, {
      local: { activeConnection: old },
      fetchRules: [
        { includes: 'https://new.example/api/token', status: 500, body: {} },
      ],
    });

    const result = await page.evaluate(async () =>
      (window as unknown as {
        connectInstance(url: string, options: { syncAfterConnect: boolean }): Promise<unknown>;
      }).connectInstance('https://new.example', { syncAfterConnect: false }));

    expect(result).toMatchObject({ success: false });
    const local = await page.evaluate(() =>
      (window as unknown as { __extensionLocal: Record<string, unknown> }).__extensionLocal);
    // Nothing at all may be written before credentials are in hand. The old
    // code recorded the new backend and origin first, so a failure left the
    // previous user's token paired with the new instance.
    expect(local).toEqual({ activeConnection: old });
  });

test('competing successful instance connections commit in request order',
  async ({ page }) => {
    await loadBackground(page, {
      fetchRules: [
        {
          includes: 'https://first.example/api/token',
          body: { user_email: 'first@example.com', token: { id: 'first-token' } },
          delayMs: 50,
        },
        {
          includes: 'https://first.example/api/extension/status',
          body: { valid: true, user_email: 'first@example.com' },
        },
        {
          includes: 'https://second.example/api/token',
          body: { user_email: 'second@example.com', token: { id: 'second-token' } },
        },
        {
          includes: 'https://second.example/api/extension/status',
          body: { valid: true, user_email: 'second@example.com' },
        },
      ],
    });

    await page.evaluate(async () => {
      const background = window as unknown as {
        connectInstance(url: string, options: { syncAfterConnect: boolean }): Promise<unknown>;
      };
      await Promise.all([
        background.connectInstance('https://first.example', { syncAfterConnect: false }),
        background.connectInstance('https://second.example', { syncAfterConnect: false }),
      ]);
    });

    const local = await page.evaluate(() =>
      (window as unknown as { __extensionLocal: Record<string, unknown> }).__extensionLocal);
    expect(local.activeConnection).toEqual({
      origin: 'https://second.example',
      token: 'second-token',
    });
  });

test('a revoked bearer is cleared instead of remaining Connected', async ({ page }) => {
  await loadBackground(page, {
    local: {
      activeConnection: { origin: 'https://watch.example', token: 'revoked' },
    },
    fetchRules: [
      { includes: '/api/extension/status', status: 401, body: { detail: 'invalid' } },
    ],
  });

  const status = await page.evaluate(async () =>
    (window as unknown as { getStatus(): Promise<Record<string, unknown>> }).getStatus());

  expect(status.connected).toBe(false);
  expect(status.connectionReason).toBe('invalid-token');
  const local = await page.evaluate(() =>
    (window as unknown as { __extensionLocal: Record<string, unknown> }).__extensionLocal);
  expect(local.activeConnection).toBeUndefined();
});

test('upgrade deletes synchronized secrets rather than migrating another user',
  async ({ page }) => {
    await loadBackground(page, {
      local: {
        token: 'old-local-token',
        userEmail: 'old-local@example.com',
        backendUrl: 'https://old.example',
        instanceOrigins: ['https://old.example/*'],
      },
      sync: {
        token: 'alice-synchronized-token',
        userEmail: 'alice@example.com',
        backendUrl: 'https://alice.example',
        lastSync: 123,
        lastSyncStatus: 'Success',
        domains: ['.youtube.com'],
        autoSync: true,
      },
    });

    await page.evaluate(async () => {
      const events = (window as unknown as {
        __extensionEvents: { onInstalled: { listeners: Array<() => Promise<void>> } };
      }).__extensionEvents;
      await events.onInstalled.listeners[0]();
    });

    const state = await page.evaluate(() => ({
      local: (window as unknown as { __extensionLocal: Record<string, unknown> })
        .__extensionLocal,
      sync: (window as unknown as { __extensionSync: Record<string, unknown> })
        .__extensionSync,
    }));
    expect(state.local).not.toHaveProperty('token');
    expect(state.local).not.toHaveProperty('userEmail');
    expect(state.local).not.toHaveProperty('backendUrl');
    expect(state.local).not.toHaveProperty('instanceOrigins');
    expect(state.sync).not.toHaveProperty('token');
    expect(state.sync).not.toHaveProperty('userEmail');
    expect(state.sync).not.toHaveProperty('backendUrl');
    expect(state.sync.domains).toEqual(['.youtube.com']);
    expect(state.sync.autoSync).toBe(true);
  });
