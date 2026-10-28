import { test, expect } from '@playwright/test';

/** The mascot keeps the empty places company, and stays still on request. */

test('the front page mascot cheers on "Create room" and the empty room shows it', async ({ page }) => {
  await page.goto('/');
  const hero = page.getByRole('region', { name: 'Watch videos together' }).locator('[data-mascot]');
  await expect(hero).toHaveAttribute('data-mascot', 'idle');
  await page.getByRole('button', { name: 'Create room' }).hover();
  await expect(hero).toHaveAttribute('data-mascot', 'happy');

  await page.goto(`/room/e2e-mascot-${Date.now().toString(36)}?user=mascot@example.com`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-mascot="idle"]')).toBeVisible();
  await expect(page.locator('[data-mascot="sleepy"]')).toBeVisible();
});

test('with reduced motion the mascot does not move', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto('/');
  const body = page.locator('[data-mascot] .mascot-body').first();
  await expect(body).toBeAttached();
  const duration = await body.evaluate((el) => parseFloat(getComputedStyle(el).animationDuration));
  expect(duration).toBeLessThan(0.01);
  await context.close();
});
