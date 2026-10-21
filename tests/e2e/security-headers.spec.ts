import { expect, test } from '@playwright/test';
import { watchCspViolations } from './support';

// P3a-AC9: security headers on HTML responses (threat model section 8).

test('HTML responses carry a nonce-based CSP and the other security headers', async ({ request }) => {
  const response = await request.get('/sign-in');
  expect(response.status()).toBe(200);
  const headers = response.headers();
  const csp = headers['content-security-policy'] ?? '';
  expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("base-uri 'self'");
  expect(csp).toContain("form-action 'self'");
  expect(csp).not.toContain('unsafe-eval'); // `next start` is a production build
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(headers['permissions-policy']).toContain('camera=()');
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  // Plain HTTP here: HSTS and upgrade-insecure-requests apply only over HTTPS.
  expect(headers['strict-transport-security']).toBeUndefined();
});

test('the nonce changes on every request', async ({ request }) => {
  const nonceOf = async () => /'nonce-([^']+)'/.exec((await request.get('/sign-in')).headers()['content-security-policy'] ?? '')?.[1];
  const [a, b] = [await nonceOf(), await nonceOf()];
  expect(a).toBeDefined();
  expect(a).not.toBe(b);
});

test('behind an HTTPS proxy, HSTS and upgrade-insecure-requests are added', async ({ request }) => {
  const response = await request.get('/sign-in', { headers: { 'x-forwarded-proto': 'https' } });
  expect(response.headers()['strict-transport-security']).toBe('max-age=63072000; includeSubDomains');
  expect(response.headers()['content-security-policy']).toContain('upgrade-insecure-requests');
});

test('the page runs under the CSP without violations', async ({ page }) => {
  const violations = watchCspViolations(page);
  await page.goto('/sign-in');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  await page.getByLabel('Email').fill('typing@example.com'); // hydration works: the client form is interactive
  expect(violations).toEqual([]);
});
