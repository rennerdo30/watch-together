import { expect, test } from '@playwright/test';

const PLAYLIST = 'https://www.youtube.com/playlist?list=PLabcdefghij12345';

test('playlist preview requires selection and confirmation before import', async ({ page }) => {
  const confirmed: unknown[] = [];
  let previews = 0;
  let singleResolves = 0;
  await page.route('**/api/resolve**', (route) => {
    singleResolves += 1;
    return route.fulfill({ status: 400, body: 'Playlist is not one video' });
  });
  await page.route('**/api/rooms/**/playlist/preview*', (route) => {
    previews += 1;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      preview_id: 'preview-1', title: 'A sample playlist', total: 3, expires_at: Date.now() / 1000 + 300,
      entries: [
        { id: 'row-1', index: 1, title: 'First video', thumbnail: null, duration: 61,
          available: true, reason: null, already_queued: false },
        { id: 'row-2', index: 2, title: 'Second video', thumbnail: null, duration: 125,
          available: true, reason: null, already_queued: false },
        { id: 'row-3', index: 3, title: 'Private video', thumbnail: null, duration: null,
          available: false, reason: 'Private video', already_queued: false },
      ],
    }) });
  });
  await page.route('**/api/rooms/**/playlist/confirm*', (route) => {
    confirmed.push(route.request().postDataJSON());
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ added: 1, skipped: 0 }) });
  });

  await page.goto(`/room/e2e-playlist-preview-${Date.now().toString(36)}?user=admin@example.com`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  const input = page.getByPlaceholder('Paste video URL...');
  await input.fill(PLAYLIST);
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'A sample playlist' });
  await expect(dialog).toBeVisible();
  expect(previews).toBeGreaterThan(0);
  expect(singleResolves).toBe(0);
  expect(confirmed).toEqual([]);
  await expect(page.locator('[data-testid="queue-item"]')).toHaveCount(0);
  await expect(dialog.getByText('3 videos')).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: 'Select video 3: Private video' })).toBeDisabled();
  await dialog.getByRole('checkbox', { name: 'Select video 2: Second video' }).uncheck();
  await expect(dialog.getByRole('button', { name: 'Add 1 video' })).toBeEnabled();

  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  expect(confirmed).toEqual([]);
  await expect(page.locator('[data-testid="queue-item"]')).toHaveCount(0);

  await page.getByRole('button', { name: 'Import playlist' }).click();
  const reopened = page.getByRole('dialog', { name: 'A sample playlist' });
  await expect(reopened).toBeVisible();
  await reopened.getByRole('checkbox', { name: 'Select video 2: Second video' }).uncheck();
  await reopened.getByRole('button', { name: 'Add 1 video' }).click();
  await expect(reopened).toHaveCount(0);
  expect(confirmed).toEqual([{ preview_id: 'preview-1', selected_ids: ['row-1'] }]);
});

test('a regular member cannot open the playlist import flow', async ({ browser }) => {
  const context = await browser.newContext();
  const admin = await context.newPage();
  const member = await context.newPage();
  const room = `e2e-playlist-role-${Date.now().toString(36)}`;
  try {
    await admin.goto(`/room/${room}?user=admin@example.com`);
    await expect(admin.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
    await member.goto(`/room/${room}?user=member@example.com`);
    await expect(member.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
    await member.getByPlaceholder('Paste video URL...').fill(PLAYLIST);
    await expect(member.getByRole('button', { name: 'Import playlist' })).toHaveCount(0);
    await member.getByRole('button', { name: 'Queue', exact: true }).click();
    await expect(member.getByText('Only room moderators and admins can import playlists.')).toBeVisible();
    await expect(member.getByRole('dialog', { name: /playlist/i })).toHaveCount(0);
  } finally {
    await context.close();
  }
});
