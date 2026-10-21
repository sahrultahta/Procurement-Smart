import { defineConfig, devices } from '@playwright/test';

const port = 3100;
const baseURL = `http://127.0.0.1:${port}`;
const isCI = Boolean(process.env.CI);
// Locally, reuse the installed Microsoft Edge so no browser download is needed.
// CI installs Playwright's Chromium. Override with PLAYWRIGHT_CHANNEL.
const channel = process.env.PLAYWRIGHT_CHANNEL ?? (isCI ? undefined : 'msedge');

const serverEnv: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) if (value !== undefined) serverEnv[key] = value;
// The auth base URL must be the origin the browser uses, or the origin check rejects requests.
serverEnv.BETTER_AUTH_URL = baseURL;
serverEnv.NEXT_TELEMETRY_DISABLED = '1';

export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], ...(channel ? { channel } : {}) },
    },
  ],
  webServer: {
    // Requires a prior `npm run build` and `npm run db:migrate`.
    command: `npm run start -- --hostname 127.0.0.1 --port ${port}`,
    url: `${baseURL}/api/health`,
    env: serverEnv,
    reuseExistingServer: !isCI,
    timeout: 120_000,
  },
});
