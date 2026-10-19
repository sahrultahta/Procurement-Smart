import { expect, test } from '@playwright/test';

test('home page renders and does not claim unbuilt features', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('ProcureFlow');
  await expect(page.getByText('No procurement features are implemented yet.')).toBeVisible();
});

test('health endpoint reports the database as ok', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok', checks: { database: 'ok' } });
});
