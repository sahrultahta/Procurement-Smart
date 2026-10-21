import { expect, test } from '@playwright/test';
import { clientIp, e2eUser, expectSignedOutAt, signIn, watchCspViolations } from './support';

// Each describe uses its own client IP (random per run) so the per-IP sign-in rate limit
// of one test, or of an earlier run, cannot affect another. (Better Auth keys it on X-Forwarded-For.)

test.describe('P3a-AC6: anonymous visitors are sent to sign-in', () => {
  test.use({ extraHTTPHeaders: { 'x-forwarded-for': clientIp(10) } });

  test('protected pages redirect, keeping the destination', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/sign-in$/);
    await page.goto('/account');
    await expect(page).toHaveURL(/\/sign-in\?next=%2Faccount$/);
  });

  test('a forged session cookie gets no further than the database check', async ({ page, context }) => {
    await context.addCookies([{ name: 'better-auth.session_token', value: 'forged.value', url: 'http://127.0.0.1:3100' }]);
    await page.goto('/account');
    await expect(page).toHaveURL(/\/sign-in/);
  });
});

test.describe('P3a-AC1/AC3: signing in', () => {
  test.use({ extraHTTPHeaders: { 'x-forwarded-for': clientIp(20) } });

  test('a valid user signs in, sees their name and roles, and gets a hardened cookie', async ({ page, context }) => {
    const csp = watchCspViolations(page);
    const user = e2eUser('rina.requester');
    await signIn(page, user.email, user.password);
    await expect(page).toHaveURL('http://127.0.0.1:3100/');
    await expect(page.getByTestId('signed-in-as')).toHaveText(user.name);

    await page.getByRole('link', { name: 'My account' }).click();
    await expect(page.getByRole('heading', { name: 'My account' })).toBeVisible();
    await expect(page.getByText(user.email)).toBeVisible();
    await expect(page.getByTestId('role-list')).toHaveText('Requester');

    const session = (await context.cookies()).find((c) => c.name.endsWith('better-auth.session_token'));
    expect(session).toBeDefined();
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe('Lax');
    expect(csp).toEqual([]);
  });

  test('a wrong password and an unknown email show the same message', async ({ page }) => {
    const user = e2eUser('rina.requester');
    await signIn(page, user.email, 'not-the-password-at-all');
    const first = await page.locator('form').getByRole('alert').textContent();
    await signIn(page, 'nobody@example.com', 'not-the-password-at-all');
    const second = await page.locator('form').getByRole('alert').textContent();
    expect(first).toBe('Invalid email or password.');
    expect(second).toBe(first);
    await expect(page).toHaveURL(/\/sign-in/);
  });

  test('the next parameter cannot redirect off-site', async ({ page }) => {
    const user = e2eUser('lena.auditor');
    await page.goto('/sign-in?next=//evil.example/steal');
    await page.getByLabel('Email').fill(user.email);
    await page.getByLabel('Password').fill(user.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL('http://127.0.0.1:3100/');
  });
});

test.describe('P3a-AC2: sign-in rate limit in the browser', () => {
  test.use({ extraHTTPHeaders: { 'x-forwarded-for': clientIp(30) } });

  test('after 5 failures the form says to wait', async ({ page }) => {
    const user = e2eUser('agus.receiver');
    for (let i = 0; i < 5; i++) {
      await signIn(page, user.email, `wrong-${i}-password`);
      await expect(page.locator('form').getByRole('alert')).toHaveText('Invalid email or password.');
    }
    await signIn(page, user.email, user.password);
    await expect(page.locator('form').getByRole('alert')).toHaveText('Too many sign-in attempts. Wait a minute, then try again.');
  });
});

test.describe('P3a-AC4/AC8: signing out', () => {
  test.use({ extraHTTPHeaders: { 'x-forwarded-for': clientIp(40) } });

  test('sign-out ends the session; the old cookie no longer works', async ({ page, context, browser }) => {
    const user = e2eUser('dewi.procurement');
    await signIn(page, user.email, user.password);
    await expect(page).toHaveURL('http://127.0.0.1:3100/');
    const stolen = (await context.cookies()).filter((c) => c.name.endsWith('better-auth.session_token'));

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/sign-in$/);

    // Replay the copied cookie in a fresh browser context.
    const replay = await browser.newContext();
    await replay.addCookies(stolen);
    const replayPage = await replay.newPage();
    await expectSignedOutAt(replayPage, '/account');
    await replay.close();
  });

  test('a cross-origin POST to the sign-out Server Action is rejected and signs nobody out', async ({ page }) => {
    const user = e2eUser('sari.finance');
    await signIn(page, user.email, user.password);
    await expect(page).toHaveURL('http://127.0.0.1:3100/');

    const html = await (await page.request.get('/')).text();
    const actionField = /name="(\$ACTION_ID_[0-9a-f]+)"/.exec(html)?.[1];
    expect(actionField, 'sign-out form should carry a Server Action id').toBeDefined();

    const forged = await page.request.post('/', {
      headers: { origin: 'https://evil.example' },
      multipart: { [actionField ?? '']: '' },
      maxRedirects: 0,
    });
    expect(forged.status()).toBeGreaterThanOrEqual(400);

    // Still signed in.
    await page.goto('/account');
    await expect(page.getByRole('heading', { name: 'My account' })).toBeVisible();
  });
});
