import { expect, type APIRequestContext } from '@playwright/test';

/**
 * Cookies reach the server the only way they can: through the extension's
 * sync endpoint. Tests that need a member "with cookies" deliver them here,
 * exactly as the extension would.
 */

export const BACKEND = 'http://localhost:8100';

export const COOKIE_FILE = [
  '# Netscape HTTP Cookie File',
  ['.youtube.com', 'TRUE', '/', 'TRUE', '1900000000', 'SID', 'abc123'].join('\t'),
  '',
].join('\n');

export async function syncCookiesAsExtension(request: APIRequestContext, user: string) {
  const tokenResponse = await request.get(`${BACKEND}/api/token?user=${encodeURIComponent(user)}`);
  expect(tokenResponse.ok()).toBeTruthy();
  const token = (await tokenResponse.json()).token.id as string;
  const sync = await request.post(`${BACKEND}/api/extension/sync`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { cookies: COOKIE_FILE, domains: ['youtube.com'], browser: 'chrome' },
  });
  expect(sync.ok()).toBeTruthy();
}
