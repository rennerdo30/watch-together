import { test, expect } from '@playwright/test';

/**
 * The theme cards must preview their own accent.
 *
 * The restyle routed every theme's `accent` class through the active
 * `--accent-primary` token so the app recolours when the theme changes —
 * correct everywhere except the picker itself, where it painted all six
 * preview swatches the currently active colour. Choosing between six
 * identical red bars is not a choice.
 */

const USER = 'themes@example.com';

test('every theme card previews its own accent colour', async ({ page }) => {
  await page.goto(`/room/e2e-themes-${Date.now().toString(36)}?user=${encodeURIComponent(USER)}`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: /quality and sync settings|settings/i }).first().click();
  const swatches = page.locator('[data-theme-swatch]');
  await expect(swatches.first()).toBeVisible({ timeout: 10_000 });

  const colors = await swatches.evaluateAll((nodes) =>
    nodes.map((node) => getComputedStyle(node as HTMLElement).backgroundColor));

  expect(colors.length).toBeGreaterThanOrEqual(6);
  // Six themes share one neutral surface but carry six different accents.
  expect(new Set(colors).size).toBeGreaterThanOrEqual(5);
});
