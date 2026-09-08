import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * Both servers are started here so the suite runs with one command. The
 * frontend talks to the backend directly via NEXT_PUBLIC_BACKEND_ORIGIN
 * rather than through nginx, and identities come from the development
 * mode `?user=` query parameter.
 */
const FRONTEND_PORT = 3100;
const BACKEND_PORT = 8100;
const BACKEND_ORIGIN = `http://localhost:${BACKEND_PORT}`;
// Stands in for sponsor.ajay.app so the suite never depends on the network.
const SPONSORBLOCK_STUB_PORT = 8300;
const SPONSORBLOCK_STUB_ORIGIN = `http://localhost:${SPONSORBLOCK_STUB_PORT}`;

// CI installs backend dependencies into the job's interpreter; locally the
// repo venv holds them.
const PYTHON_BIN = process.env.PYTHON_BIN ?? (process.env.CI ? 'python' : '../venv/bin/python');

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    trace: 'on-first-retry',
    video: 'off',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],

  webServer: [
    {
      command: 'node e2e/sponsorblock-stub.mjs',
      url: `${SPONSORBLOCK_STUB_ORIGIN}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: { SPONSORBLOCK_STUB_PORT: String(SPONSORBLOCK_STUB_PORT) },
    },
    {
      command: `${PYTHON_BIN} -m uvicorn main:app --host localhost --port ${BACKEND_PORT}`,
      cwd: '../backend',
      url: `${BACKEND_ORIGIN}/`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        DEVELOPMENT_MODE: 'true',
        ALLOWED_ORIGINS: '*',
        ADMIN_EMAILS: 'admin@example.com',
        SPONSORBLOCK_API_URL: SPONSORBLOCK_STUB_ORIGIN,
      },
    },
    {
      // The dev server is used deliberately: NEXT_PUBLIC_* values are
      // inlined when the app compiles, so a pre-built bundle would ignore
      // the backend origin set here.
      command: `npm run dev -- --port ${FRONTEND_PORT}`,
      url: `http://localhost:${FRONTEND_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: {
        NEXT_PUBLIC_BACKEND_ORIGIN: BACKEND_ORIGIN,
      },
    },
  ],
});
