import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * Creates (or re-passwords) dedicated fictional E2E users, e2e.<persona>@example.com,
 * through the real provisioning + password-setup flow. Credentials land in
 * .local/e2e-credentials.json (gitignored); the demo users are left alone.
 */
export default function globalSetup(): void {
  const root = resolve(import.meta.dirname, '../..');
  execFileSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'seed', '--', '--prefix', 'e2e', '--out', '.local/e2e-credentials.json', '--reset-passwords'],
    { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' },
  );
}
