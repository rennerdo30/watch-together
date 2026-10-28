import type { Page } from '@playwright/test';

/** The player's settings button in the control bar. */
export const playerSettingsButton = (page: Page) =>
  page.getByRole('button', { name: 'Player settings', exact: true });

export type PlayerSettingsPage = 'Quality' | 'Audio track' | 'Sound' | 'Picture' | 'Sync';

/** Opens the player settings menu, and one of its pages if asked. */
export async function openPlayerSettings(page: Page, section?: PlayerSettingsPage) {
  await playerSettingsButton(page).click();
  if (section) await openPlayerSettingsPage(page, section);
}

/** Goes to one of the menu's pages; `fromSubpage` goes back to the first page first. */
export async function openPlayerSettingsPage(page: Page, section: PlayerSettingsPage, fromSubpage = false) {
  const menu = page.getByRole('dialog', { name: 'Player settings' });
  if (fromSubpage) await menu.getByRole('button', { name: /back to all settings/ }).click();
  await menu.getByRole('button', { name: new RegExp(`^${section}`) }).click();
}
