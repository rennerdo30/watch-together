import path from 'node:path';
import base from '../playwright.config';
import { defineConfig } from '@playwright/test';

/**
 * Renders the Chrome Web Store images (written to store/chrome-web-store/)
 * against the same local servers the end-to-end suite starts:
 *
 *   npx playwright test -c store-images/playwright.config.ts
 */
const FRONTEND = path.resolve(__dirname, '..');
const servers = [base.webServer ?? []].flat();

export default defineConfig({
  ...base,
  testDir: '.',
  testMatch: 'render.spec.ts',
  timeout: 120_000,
  retries: 0,
  // The servers' working directories are relative to frontend/, not here.
  webServer: servers.map((server) => ({ ...server, cwd: path.resolve(FRONTEND, server.cwd ?? '.') })),
});
