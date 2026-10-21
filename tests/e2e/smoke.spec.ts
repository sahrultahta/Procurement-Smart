import { expect, test } from '@playwright/test';

test('the sign-in page renders for anonymous visitors', async ({ page }) => {
  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { name: 'Sign in to ProcureFlow' })).toBeVisible();
});

test('health endpoint reports the database as ok', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok', checks: { database: 'ok' } });
});
