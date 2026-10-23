import { test, expect } from '@playwright/test';
import { stubAdaptiveStream } from './adaptive-fixture';

test('runtime failures reach the admin after the viewer leaves, with secrets removed', async ({ browser }) => {
  const context = await browser.newContext();
  const viewer = await context.newPage();
  const room = `errors-${Date.now().toString(36)}`;
  await viewer.goto(`/room/${room}?user=diagnostics-viewer@example.com`);
  await expect(viewer.getByLabel('Connected to the room')).toBeVisible();
  const report = viewer.waitForResponse(r => r.url().includes('/api/client-errors') && r.status() === 202);
  await viewer.evaluate(() => window.dispatchEvent(new ErrorEvent('error', {
    message: 'Test failure https://cdn.test/video?token=DO_NOT_STORE',
    error: new Error('test stack https://app.test/code.js?secret=DO_NOT_STORE'),
    filename: 'https://app.test/code.js?key=DO_NOT_STORE',
  })));
  await report;
  await context.close();
  const admin = await browser.newPage();
  await admin.goto('/admin?user=admin@example.com');
  const errors = admin.getByRole('region', { name: 'Client errors' });
  await expect(errors.getByText('diagnostics-viewer@example.com')).toBeVisible();
  await expect(errors.getByText(room, { exact: true })).toBeVisible();
  await expect(errors.getByText(/Test failure/)).toBeVisible();
  await expect(errors).not.toContainText('DO_NOT_STORE');
  await errors.getByText(/Test failure/).click();
  await expect(errors.getByText(/test stack/)).toBeVisible();
  await admin.getByLabel('Filter client errors').fill('no-such-viewer');
  await expect(errors.getByText('diagnostics-viewer@example.com')).toHaveCount(0);
  await admin.getByLabel('Filter client errors').fill(room);
  await expect(errors.getByText('diagnostics-viewer@example.com')).toBeVisible();
  await errors.screenshot({ path: '/tmp/w2g-client-errors-admin.png' });
  await admin.close();
});

test('Shaka HTTP failure reports code 1001 and status to the server', async ({ page }) => {
  const room = `player-errors-${Date.now().toString(36)}`;
  const original = 'https://youtu.be/error-fixture';
  await stubAdaptiveStream(page, original);
  await page.route('**/api/dash-manifest**', route => route.fulfill({ status: 403, body: 'Forbidden' }));
  await page.goto(`/room/${room}?user=player-error@example.com`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible();
  const report = page.waitForRequest(r => {
    if (!r.url().includes('/api/client-errors') || r.method() !== 'POST') return false;
    const payload = r.postDataJSON();
    return payload.source === 'shaka' && payload.code === 1001 && payload.http_status === 403;
  });
  await page.getByPlaceholder('Paste video URL...').fill(original);
  await page.getByPlaceholder('Paste video URL...').press('Enter');
  const request = await report;
  expect(request.postDataJSON().room).toBe(room);
  expect(request.postDataJSON().resource).not.toContain('?');
});

test('rejected promises are reported and failed reporting never recurses', async ({ page }) => {
  await page.goto('/?user=promise-viewer@example.com');
  await expect(page.getByRole('heading').first()).toBeVisible();
  const report = page.waitForRequest(r => r.url().includes('/api/client-errors') && r.method() === 'POST');
  let attempts = 0;
  await page.route('**/api/client-errors**', route => { attempts++; return route.abort(); });
  await page.evaluate(() => window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', {
    reason: new Error('Rejected test promise'), promise: Promise.resolve(),
  })));
  expect((await report).postDataJSON().source).toBe('promise');
  // Allow the aborted fetch to settle; it must not create another rejection report.
  await page.waitForTimeout(300);
  expect(attempts).toBe(1);
});
