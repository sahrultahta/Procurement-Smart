import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';

// Rate-limit counters live in PostgreSQL and outlive a test run, so each run (and worker)
// uses its own random client addresses: 10.<a>.<b>.<n>.
const RUN_OCTETS = [1 + Math.floor(Math.random() * 254), 1 + Math.floor(Math.random() * 254)];
export function clientIp(n: number): string {
  return `10.${RUN_OCTETS[0]}.${RUN_OCTETS[1]}.${n}`;
}

type Credentials = Record<string, { name: string; password: string; roles: string[] }>;

export function e2eUser(persona: string): { email: string; name: string; password: string } {
  const file = resolve(import.meta.dirname, '../../.local/e2e-credentials.json');
  const all = JSON.parse(readFileSync(file, 'utf8')) as Credentials;
  const email = `e2e.${persona}@example.com`;
  const entry = all[email];
  if (!entry) throw new Error(`No E2E credentials for ${email}; global setup should have created them.`);
  return { email, name: entry.name, password: entry.password };
}

export async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Collects Content-Security-Policy violations reported in the browser console. */
export function watchCspViolations(page: Page): string[] {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy|Content-Security-Policy/i.test(message.text())) {
      violations.push(message.text());
    }
  });
  return violations;
}

export async function expectSignedOutAt(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page).toHaveURL(/\/sign-in/);
}
