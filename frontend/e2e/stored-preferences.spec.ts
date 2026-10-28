import { expect, test } from '@playwright/test';
import { createCustomTheme, THEMES } from '../lib/themes';

const roomUrl = () => `/room/e2e-preferences-${Date.now().toString(36)}?user=preferences@example.com`;

test('saved custom theme, text size and sidebar width survive hydration with their settings values', async ({ page }) => {
  const custom = createCustomTheme('#abcdef');
  await page.addInitScript((theme) => {
    localStorage.setItem('wt_theme', 'custom');
    localStorage.setItem('wt_custom_theme', JSON.stringify(theme));
    localStorage.setItem('wt_sidebar_width', '420');
    localStorage.setItem('wt_proxy', 'false');
    localStorage.setItem('wt_font_size', '19');
    localStorage.setItem('wt_color_mode', 'dark');
  }, custom);
  const hydrationErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /hydration|hydrated|server rendered/i.test(message.text())) hydrationErrors.push(message.text());
  });
  await page.goto(roomUrl());
  await expect(page.getByLabel('Connected to the room')).toBeVisible();
  // The stored accent is applied to the document, not only shown as selected.
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent-primary').trim()))
    .toBe('#abcdef');
  await page.getByRole('button', { name: 'Room settings' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Appearance' }).click();
  await expect(dialog.getByRole('radio', { name: 'Custom color' })).toHaveAttribute('aria-checked', 'true');
  await expect(dialog.locator('input[type="color"]')).toHaveValue('#abcdef');
  // The text size was saved but never read back, so every visit reset it.
  await expect(dialog.getByLabel('Text size')).toHaveValue('19');
  await dialog.getByRole('button', { name: 'Account' }).click();
  await expect(dialog.getByRole('switch', { name: /proxy mode/i })).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('[style*="--sidebar-width"]')).toHaveCSS('--sidebar-width', '420px');
  expect(hydrationErrors).toEqual([]);
});

test('a theme changed in another tab updates the open room', async ({ page, context }) => {
  await page.addInitScript(() => localStorage.setItem('wt_color_mode', 'dark'));
  await page.goto(roomUrl());
  await expect(page.getByLabel('Connected to the room')).toBeVisible();
  const other = await context.newPage();
  await other.goto('/');
  const theme = THEMES[1];
  await other.evaluate((id) => localStorage.setItem('wt_theme', id), theme.id);
  await page.getByRole('button', { name: 'Room settings' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Appearance' }).click();
  await expect(page.locator(`[data-theme-swatch="${theme.id}"]`)).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent-primary').trim()))
    .toBe(theme.dark.accent);
  await other.close();
});
