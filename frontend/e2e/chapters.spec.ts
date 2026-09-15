import { test, expect } from '@playwright/test';

import { chapterAt, type VideoChapter } from '../lib/chapters';
import { stubAdaptiveStream, FIXTURE_DURATION_SECONDS } from './adaptive-fixture';

/**
 * Chapters (YouTube: sections) come with the resolved video. They are
 * notched on the seek bar, named under the pointer and beside the time,
 * and listed in a sidebar tab — where picking one moves the whole room,
 * not just the viewer who clicked.
 */

const ORIGINAL_URL = 'https://youtu.be/chapters-fixture';

const CHAPTERS: VideoChapter[] = [
  { start: 0, end: 2, title: 'Intro' },
  { start: 2, end: 4, title: 'Middle' },
  { start: 4, end: FIXTURE_DURATION_SECONDS, title: 'Outro' },
];

test('a time maps to the chapter containing it', () => {
  expect(chapterAt(CHAPTERS, 0)?.title).toBe('Intro');
  expect(chapterAt(CHAPTERS, 1.99)?.title).toBe('Intro');
  expect(chapterAt(CHAPTERS, 2)?.title).toBe('Middle');
  expect(chapterAt(CHAPTERS, 5.9)?.title).toBe('Outro');
  expect(chapterAt([], 1)).toBeNull();
  expect(chapterAt(CHAPTERS, NaN)).toBeNull();
});

test('chapters are marked, listed, and a pick moves the whole room', async ({ browser }) => {
  const roomId = `e2e-chapters-${Date.now().toString(36)}`;
  const pickerCtx = await browser.newContext();
  const otherCtx = await browser.newContext();
  const picker = await pickerCtx.newPage();
  const other = await otherCtx.newPage();
  await stubAdaptiveStream(picker, ORIGINAL_URL, undefined, { chapters: CHAPTERS });
  await stubAdaptiveStream(other, ORIGINAL_URL, undefined, { chapters: CHAPTERS });

  await picker.goto(`/room/${roomId}?user=picker@example.com`);
  await expect(picker.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  await other.goto(`/room/${roomId}?user=other@example.com`);
  await expect(other.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });

  await picker.getByPlaceholder('Paste video URL...').fill(ORIGINAL_URL);
  await picker.getByPlaceholder('Paste video URL...').press('Enter');
  const pickerMedia = picker.locator('video[data-stream-type="mse"]');
  const otherMedia = other.locator('video[data-stream-type="mse"]');
  await expect(pickerMedia).toHaveCount(1, { timeout: 15_000 });
  await expect(otherMedia).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(() => pickerMedia.evaluate((v: HTMLVideoElement) => v.duration), { timeout: 15_000 }).toBeGreaterThan(5);
  await expect.poll(() => otherMedia.evaluate((v: HTMLVideoElement) => v.duration), { timeout: 15_000 }).toBeGreaterThan(5);

  // Two boundaries for three chapters: the first starts at 0 and needs none.
  await expect(picker.locator('[data-chapter-marker]')).toHaveCount(2);

  // Hovering the last fifth of the bar names the chapter there.
  const seek = picker.getByLabel('Seek');
  const box = await seek.boundingBox();
  if (!box) throw new Error('no seek bar');
  await picker.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2);
  await expect(picker.getByTestId('seek-preview-chapter')).toHaveText('Outro');
  await picker.mouse.move(box.x - 50, box.y - 200);

  // The sidebar lists them; picking one moves this viewer and the room.
  await picker.getByRole('tab', { name: /Chapters/ }).click();
  const list = picker.getByTestId('chapter-list');
  await expect(list.getByRole('button')).toHaveCount(3);
  await list.getByRole('button', { name: /Outro/ }).click();
  await expect.poll(() => pickerMedia.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 10_000 }).toBeGreaterThanOrEqual(3.9);
  await expect.poll(() => otherMedia.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 10_000 }).toBeGreaterThanOrEqual(3.9);
  await expect(list.getByRole('button', { name: /Outro/ })).toHaveAttribute('aria-current', 'true');

  await pickerCtx.close();
  await otherCtx.close();
});
