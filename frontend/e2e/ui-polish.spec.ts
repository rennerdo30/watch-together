import { test, expect, type Locator } from '@playwright/test';

/**
 * Small room-page defects from the UI pass, each pinned so it stays fixed.
 *
 * - Escape closed Settings but not the screen-share or shared-browser
 *   dialogs, which only went away through Cancel or a backdrop click.
 * - The light scheme remapped Tailwind's `-400` text steps but not the pale
 *   `-100`..`-300` ones, so the extension hint, every warning line and the
 *   error text were near-white on a light page.
 * - A moderator was labelled "AGENT" in the audience list.
 */

function uniqueRoomId(label: string): string {
  return `e2e-${label}-${Date.now().toString(36)}`;
}

function freshUser(label: string): string {
  return `${Date.now().toString(36)}-${label}@example.com`;
}

/**
 * WCAG relative luminance of an element's text colour. Tailwind v4 emits
 * `lab()` / `oklch()`, so the colour is resolved to sRGB through a canvas.
 */
async function luminance(locator: Locator): Promise<number> {
  return locator.evaluate((node) => {
    const context = document.createElement('canvas').getContext('2d');
    if (!context) throw new Error('no 2d context');
    context.fillStyle = getComputedStyle(node).color;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3)).map((value) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  });
}

test('Escape closes the share-screen and shared-browser dialogs', async ({ page }) => {
  await page.goto(`/room/${uniqueRoomId('esc')}?user=${encodeURIComponent(freshUser('esc'))}`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Share screen' }).click();
  const share = page.getByRole('dialog', { name: 'Share your screen' });
  await expect(share).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(share).toBeHidden();

  await page.getByTestId('open-shared-browser').click();
  const browser = page.getByRole('dialog', { name: 'Shared browser' });
  await expect(browser).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(browser).toBeHidden();
});

test('warning text stays dark enough to read in the light scheme', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('wt_color_mode', 'light'));
  await page.goto(`/room/${uniqueRoomId('light')}?user=${encodeURIComponent(freshUser('light'))}`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  // The hint's copy sat in amber-100 — about white on the light page.
  const hint = page.getByTestId('extension-hint').locator('p');
  await expect(hint).toBeVisible();
  expect(await luminance(hint)).toBeLessThan(0.2);

  // The share dialog's bandwidth warning is amber-200.
  await page.getByRole('button', { name: 'Share screen' }).click();
  const warning = page.getByRole('dialog', { name: 'Share your screen' }).getByText(/travels through this server/);
  await expect(warning).toBeVisible();
  expect(await luminance(warning)).toBeLessThan(0.2);
});

test('the audience list names roles in words a viewer recognises', async ({ browser }) => {
  const roomId = uniqueRoomId('roles');
  const viewer = freshUser('mod');
  // ADMIN_EMAILS in the e2e config makes this member the room's admin.
  const adminPage = await (await browser.newContext()).newPage();
  await adminPage.goto(`/room/${roomId}?user=${encodeURIComponent('admin@example.com')}`);
  await expect(adminPage.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  const viewerPage = await (await browser.newContext()).newPage();
  await viewerPage.goto(`/room/${roomId}?user=${encodeURIComponent(viewer)}`);
  await expect(viewerPage.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });

  await adminPage.getByRole('tab', { name: /Audience/ }).click();
  const panel = adminPage.getByRole('tabpanel');
  await panel.getByText(viewer).hover();
  await panel.getByRole('button', { name: `Promote ${viewer} to moderator` }).click();

  await expect(panel.getByText('Moderator', { exact: true })).toBeVisible();
  await expect(panel.getByText('Admin', { exact: true })).toBeVisible();
  await expect(panel.getByText(/^(AGENT|ADMIN)$/)).toHaveCount(0);
});
