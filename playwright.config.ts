import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';
import { E2E_DATABASE, withDatabase } from './scripts/lib/e2e-database';

if (existsSync('.env')) process.loadEnvFile('.env');
// Point the server and global setup at the E2E database, never the development one.
for (const key of ['DATABASE_URL', 'DATABASE_MIGRATION_URL'] as const) {
  const value = process.env[key];
  if (value) process.env[key] = withDatabase(value, E2E_DATABASE);
}

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
// The standalone server (npm run start) takes its address from the environment.
serverEnv.HOSTNAME = '127.0.0.1';
serverEnv.PORT = String(port);

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
    // Requires a prior `npm run build`: the tests run against the packaged standalone server, the
    // deployment artifact (docs/deployment.md). Recreates the E2E database first (scripts/e2e-db.ts).
    // A server already running on this port is reused as is, without a fresh database.
    command: 'node scripts/e2e-db.ts && npm run start',
    url: `${baseURL}/api/health`,
    env: serverEnv,
    reuseExistingServer: !isCI,
    timeout: 120_000,
  },
});
