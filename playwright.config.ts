import { defineConfig, devices } from '@playwright/test';

const port = 3100;
const isCI = Boolean(process.env.CI);
// Locally, reuse the installed Microsoft Edge so no browser download is needed.
// CI installs Playwright's Chromium. Override with PLAYWRIGHT_CHANNEL.
const channel = process.env.PLAYWRIGHT_CHANNEL ?? (isCI ? undefined : 'msedge');

export default defineConfig({
  testDir: 'tests/e2e',
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], ...(channel ? { channel } : {}) },
    },
  ],
  webServer: {
    // Requires a prior `npm run build`.
    command: `npm run start -- --hostname 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: !isCI,
    timeout: 120_000,
  },
});
