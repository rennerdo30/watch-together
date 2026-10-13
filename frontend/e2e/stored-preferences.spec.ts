import { expect, test } from '@playwright/test';
import { createCustomTheme, THEMES } from '../lib/themes';

const roomUrl = () => `/room/e2e-preferences-${Date.now().toString(36)}?user=preferences@example.com`;

test('saved custom theme and sidebar width survive hydration with their settings values', async ({ page }) => {
  const custom = createCustomTheme('Custom', '#123456', '#abcdef');
  await page.addInitScript((theme) => {
    localStorage.setItem('wt_theme', 'custom');
    localStorage.setItem('wt_custom_theme', JSON.stringify(theme));
    localStorage.setItem('wt_sidebar_width', '420');
    localStorage.setItem('wt_proxy', 'false');
  }, custom);
  const hydrationErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /hydration|hydrated|server rendered/i.test(message.text())) hydrationErrors.push(message.text());
  });
  await page.goto(roomUrl());
  await expect(page.getByLabel('Connected to the room')).toBeVisible();
  await page.getByRole('button', { name: 'Room settings' }).click();
  await expect(page.getByRole('button', { name: 'Apply custom theme' })).toBeVisible();
  await expect(page.locator('input[type="color"]').first()).toHaveValue('#123456');
  await expect(page.locator('input[type="color"]').last()).toHaveValue('#abcdef');
  await expect(page.getByRole('switch', { name: /proxy mode/i })).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('[style*="--sidebar-width"]')).toHaveCSS('--sidebar-width', '420px');
  expect(hydrationErrors).toEqual([]);
});

test('a theme changed in another tab updates the open room', async ({ page, context }) => {
  await page.goto(roomUrl());
  await expect(page.getByLabel('Connected to the room')).toBeVisible();
  const other = await context.newPage();
  await other.goto('/');
  const theme = THEMES.find((entry) => entry.colors.accent !== THEMES[0].colors.accent)!;
  await other.evaluate((id) => localStorage.setItem('wt_theme', id), theme.id);
  await page.getByRole('button', { name: 'Room settings' }).click();
  await expect(page.locator(`[data-theme-swatch="${theme.id}"]`).locator('..')).toHaveClass(/border-white\/20/);
  await other.close();
});
