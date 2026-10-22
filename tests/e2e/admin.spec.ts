import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { clientIp, e2eUser, signIn, watchCspViolations } from './support';

const BASE = 'http://127.0.0.1:3100';
const run = randomBytes(3).toString('hex');

async function signInAs(page: Page, persona: string): Promise<void> {
  const user = e2eUser(persona);
  await signIn(page, user.email, user.password);
  await expect(page).toHaveURL(`${BASE}/`);
}

test.describe('P3b-AC13: an admin manages a user from creation to deactivation', () => {
  test.use({ extraHTTPHeaders: { 'x-forwarded-for': clientIp(110) } });

  test('create with a one-time link, set password, revoke a role, deactivate', async ({ page, browser }) => {
    const csp = watchCspViolations(page);
    const email = `e2e.nina.${run}@example.com`;
    await signInAs(page, 'ada.admin');

    await page.getByRole('link', { name: 'Admin' }).click();
    await expect(page.getByRole('heading', { name: 'Users', level: 1 })).toBeVisible();
    await page.getByRole('link', { name: 'New user' }).click();
    await page.getByLabel('Name').fill('Nina Newhire');
    await page.getByLabel('Work email').fill(email);
    await page.getByLabel('Home department').selectOption('OPS');
    await page.getByRole('checkbox', { name: 'Requester' }).check();
    await page.getByLabel('Requester scope').selectOption('OPS');
    await page.getByRole('button', { name: 'Create user' }).click();
    await expect(page.getByTestId('setup-link')).toBeVisible();
    const link = await page.getByLabel('Setup link').inputValue();
    expect(link).toMatch(new RegExp(`^${BASE}/set-password\\?token=[A-Za-z0-9_-]+$`));

    // The new user, in their own browser.
    const userContext = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': clientIp(111) } });
    const userPage = await userContext.newPage();
    const password = `nina-${run}-long-passphrase`;
    await userPage.goto(link);
    await userPage.getByLabel('New password').fill(password);
    await userPage.getByLabel('Repeat the password').fill(password);
    await userPage.getByRole('button', { name: 'Set password' }).click();
    await expect(userPage.getByText('Your password is set.')).toBeVisible();
    await signIn(userPage, email, password);
    await expect(userPage).toHaveURL(`${BASE}/`);
    await userPage.goto('/account');
    await expect(userPage.getByTestId('role-list')).toHaveText('Requester · OPS');
    // The link worked once.
    await userPage.goto(link);
    await userPage.getByLabel('New password').fill('another-long-passphrase');
    await userPage.getByLabel('Repeat the password').fill('another-long-passphrase');
    await userPage.getByRole('button', { name: 'Set password' }).click();
    await expect(userPage.locator('form').getByRole('alert')).toBeVisible();

    // Revoke the role: the user's next request reflects it.
    await page.getByRole('link', { name: 'Open user' }).click();
    await expect(page.getByRole('heading', { name: 'Nina Newhire', level: 1 })).toBeVisible();
    await page.getByLabel('Reason for revoking Requester').fill('Moved to another team');
    await page.getByRole('button', { name: 'Revoke' }).click();
    await expect(page.getByText('No roles. The user can sign in but cannot do any procurement work.')).toBeVisible();
    await expect(page.getByRole('table', { name: 'Revoked roles' })).toContainText('Moved to another team');
    await userPage.goto('/account');
    await expect(userPage.getByText('No roles assigned.')).toBeVisible();

    // Deactivate: the user's very next request is turned away, and sign-in no longer works.
    await page.getByLabel('Reason for deactivation').fill('Contract ended');
    await page.getByRole('button', { name: 'Deactivate user' }).click();
    await expect(page.getByText('Deactivated', { exact: true })).toBeVisible();
    await userPage.goto('/account');
    await expect(userPage).toHaveURL(/\/sign-in/);
    await signIn(userPage, email, password);
    await expect(userPage.locator('form').getByRole('alert')).toHaveText('Invalid email or password.');
    await userContext.close();
    expect(csp).toEqual([]);
  });

  test('an admin cannot change their own account', async ({ page }) => {
    await signInAs(page, 'ada.admin');
    await page.goto('/admin/users');
    await page.getByRole('link', { name: 'Ada Admin' }).click();
    await expect(page.getByRole('note')).toContainText('This is your own account.');
    await expect(page.getByRole('button', { name: 'Deactivate user' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Revoke' })).toHaveCount(0);
  });
});

test.describe('P3b-AC11: admin Server Actions check access themselves', () => {
  test.use({ extraHTTPHeaders: { 'x-forwarded-for': clientIp(120) } });

  test('a captured action POST is refused without a session, for a requester, and cross-origin', async ({ page, browser, playwright }) => {
    await signInAs(page, 'ada.admin');
    await page.goto('/admin/departments');

    // Capture the browser's real Server Action request, without letting it reach the server.
    let captured: { url: string; headers: Record<string, string>; body: Buffer } | undefined;
    await page.route('**/admin/departments', async (route) => {
      const request = route.request();
      const headers = request.headers();
      if (request.method() === 'POST' && headers['next-action']) {
        captured = { url: request.url(), headers, body: request.postDataBuffer() ?? Buffer.alloc(0) };
        await route.abort();
      } else await route.continue();
    });
    const code = `Q${run.slice(0, 4).toUpperCase()}`;
    await page.getByLabel('Code').fill(code);
    await page.getByLabel('Name', { exact: true }).fill('Quality');
    await page.getByRole('button', { name: 'Create department' }).click();
    await expect.poll(() => captured !== undefined).toBe(true);
    await page.unrouteAll();
    if (!captured) throw new Error('no Server Action request captured');
    const { url, body } = captured;
    // Only what a Server Action call needs; never the cookies of the captured request.
    const actionHeaders = (origin: string) => ({
      'next-action': captured?.headers['next-action'] ?? '',
      'content-type': captured?.headers['content-type'] ?? '',
      accept: 'text/x-component',
      origin,
    });

    // No cookie at all: proxy.ts turns the request away before any page or action code runs.
    const anonymous = await playwright.request.newContext({ extraHTTPHeaders: { 'x-forwarded-for': clientIp(121) } });
    const noCookie = await anonymous.post(url, { headers: actionHeaders(BASE), data: body, maxRedirects: 0 });
    expect(noCookie.status()).toBe(307);
    expect(noCookie.headers()['location']).toContain('/sign-in');
    await anonymous.dispose();

    // A forged cookie passes that optimistic check; the action itself must still refuse.
    const forged = await playwright.request.newContext({
      extraHTTPHeaders: { 'x-forwarded-for': clientIp(123), cookie: 'better-auth.session_token=forged.value' },
    });
    const noSession = await (await forged.post(url, { headers: actionHeaders(BASE), data: body, maxRedirects: 0 })).text();
    expect(noSession).toContain('UNAUTHENTICATED');
    expect(noSession).not.toContain('Department created');
    await forged.dispose();

    const requesterContext = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': clientIp(122) } });
    const requesterPage = await requesterContext.newPage();
    await signInAs(requesterPage, 'rina.requester');
    const forbidden = await (await requesterContext.request.post(url, { headers: actionHeaders(BASE), data: body, maxRedirects: 0 })).text();
    expect(forbidden).toContain('FORBIDDEN');
    expect(forbidden).not.toContain('Department created');
    await requesterContext.close();

    const crossOrigin = await page.request.post(url, { headers: actionHeaders('https://evil.example'), data: body, maxRedirects: 0 });
    expect(crossOrigin.status()).toBeGreaterThanOrEqual(400);
    expect(await crossOrigin.text()).not.toContain('Department created');

    // Positive control: the same request from the admin's own origin is accepted, once.
    const accepted = await (await page.request.post(url, { headers: actionHeaders(BASE), data: body, maxRedirects: 0 })).text();
    expect(accepted).toContain('Department created');
    await page.goto('/admin/departments');
    await expect(page.getByRole('form', { name: `Department ${code}` })).toHaveCount(1);
  });
});

test.describe('P3b-AC11: non-admins', () => {
  test.use({ extraHTTPHeaders: { 'x-forwarded-for': clientIp(130) } });

  test('see no Admin link and no admin data, even by URL', async ({ page }) => {
    await signInAs(page, 'lena.auditor');
    await expect(page.getByRole('link', { name: 'Admin' })).toHaveCount(0);
    for (const path of ['/admin/users', '/admin/users/new', '/admin/departments']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
      await expect(page.locator('main')).not.toContainText('@example.com');
    }
  });
});

test.describe('P3b-AC13: admin pages are usable with assistive technology basics', () => {
  test.use({ extraHTTPHeaders: { 'x-forwarded-for': clientIp(140) } });

  test('one h1 per page, every control labeled, keyboard activation works', async ({ page }) => {
    const csp = watchCspViolations(page);
    await signInAs(page, 'ada.admin');
    await page.goto('/admin/users');
    const someone = page.getByRole('link', { name: 'Rina Requester' });
    const detail = await someone.getAttribute('href');
    for (const path of ['/admin/users', '/admin/users/new', '/admin/departments', detail ?? '/admin/users']) {
      await page.goto(path);
      await expect(page.locator('h1')).toHaveCount(1);
      const unlabeled = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
          'input:not([type=hidden]), select, textarea',
        )]
          .filter((el) => (el.labels?.length ?? 0) === 0 && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby'))
          .map((el) => el.getAttribute('name') ?? el.outerHTML.slice(0, 80)),
      );
      expect({ path, unlabeled }).toEqual({ path, unlabeled: [] });
    }
    await page.goto('/admin/users');
    await page.getByRole('link', { name: 'New user' }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`${BASE}/admin/users/new`);
    expect(csp).toEqual([]);
  });
});
