import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

// P1-AC6 / P10-AC7: the packaged production server (the deployment artifact) with invalid
// configuration exits instead of serving. Needs a prior `npm run build`. No browser is used.
const root = resolve(import.meta.dirname, '../..');
const standalone = resolve(root, '.next/standalone');
const server = resolve(standalone, 'server.js');

function startWith(overrides: Record<string, string>): Promise<{ code: number | null; output: string }> {
  return new Promise((resolvePromise, reject) => {
    // An explicitly set (even empty) variable takes precedence over .env files.
    const child = spawn(process.execPath, [server], {
      cwd: standalone,
      env: { ...process.env, HOSTNAME: '127.0.0.1', PORT: '3101', NEXT_TELEMETRY_DISABLED: '1', ...overrides },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`the server was still running after 30 s:\n${output}`));
    }, 30_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, output });
    });
  });
}

test('refuses to start without a valid DATABASE_URL and does not echo the value', async () => {
  const { code, output } = await startWith({ DATABASE_URL: 'mysql://someone:do-not-print-me@db.invalid/x' });
  expect(code).toBe(1);
  expect(output).toContain('Invalid or missing environment variables: DATABASE_URL');
  expect(output).not.toContain('do-not-print-me');
});

test('refuses to start with an empty DATABASE_URL', async () => {
  const { code, output } = await startWith({ DATABASE_URL: '' });
  expect(code).toBe(1);
  expect(output).toContain('Refusing to start.');
});

test('refuses to start with a weak BETTER_AUTH_SECRET and does not echo it', async () => {
  const { code, output } = await startWith({ BETTER_AUTH_SECRET: 'short-secret-do-not-print' });
  expect(code).toBe(1);
  expect(output).toContain('Invalid or missing environment variables: BETTER_AUTH_SECRET');
  expect(output).not.toContain('short-secret-do-not-print');
});

test('the packaged server carries no .env file and no browser source maps', () => {
  expect(existsSync(server)).toBe(true);
  expect(readdirSync(standalone).filter((name) => name === '.env' || name.startsWith('.env.'))).toEqual([]);
  const maps: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.js.map')) maps.push(path);
    }
  };
  walk(resolve(standalone, '.next/static'));
  expect(maps).toEqual([]);
});
