import { defineConfig, devices } from '@playwright/test';

/**
 * Pinned to its own port and passed explicitly to `next dev`, so an ambient
 * PORT in the developer's shell cannot silently point the tests at a different
 * server than the one Playwright started.
 */
const PORT = Number(process.env.E2E_PORT ?? 3311);
// `localhost`, not 127.0.0.1: Next dev treats the bare IP as a cross-origin
// host and 403s its own chunks, which silently leaves the page unhydrated.
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Launching three browser engines at full parallelism crashes Chromium on
  // this machine; two workers is both stable and fast enough.
  workers: process.env.CI ? 1 : 2,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'tablet', use: { ...devices['iPad (gen 7)'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: `pnpm exec next dev --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { PORT: String(PORT) },
  },
});
