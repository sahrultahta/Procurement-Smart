import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

// P1-AC6: a production server with invalid configuration exits instead of serving.
// Needs a prior `npm run build`. No browser is used.
const root = resolve(import.meta.dirname, '../..');
const nextBin = resolve(root, 'node_modules/next/dist/bin/next');

function startWith(databaseUrl: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolvePromise, reject) => {
    // An explicitly set (even empty) variable takes precedence over .env files.
    const child = spawn(process.execPath, [nextBin, 'start', '--hostname', '127.0.0.1', '--port', '3101'], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: databaseUrl, NEXT_TELEMETRY_DISABLED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`next start was still running after 30 s:\n${output}`));
    }, 30_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, output });
    });
  });
}

test('refuses to start without a valid DATABASE_URL and does not echo the value', async () => {
  const { code, output } = await startWith('mysql://someone:do-not-print-me@db.invalid/x');
  expect(code).toBe(1);
  expect(output).toContain('Invalid or missing environment variables: DATABASE_URL');
  expect(output).not.toContain('do-not-print-me');
});

test('refuses to start with an empty DATABASE_URL', async () => {
  const { code, output } = await startWith('');
  expect(code).toBe(1);
  expect(output).toContain('Refusing to start.');
});
