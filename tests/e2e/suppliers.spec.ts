import { randomBytes } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { clientIp, e2eUser, signIn, watchCspViolations } from './support';

const BASE = 'http://127.0.0.1:3100';
const run = randomBytes(3).toString('hex');

async function personaPage(browser: Browser, persona: string, ip: number): Promise<Page> {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': clientIp(ip) } });
  const page = await context.newPage();
  const user = e2eUser(persona);
  await signIn(page, user.email, user.password);
  await expect(page).toHaveURL(`${BASE}/`);
  return page;
}

async function expectStatus(page: Page, label: string): Promise<void> {
  await expect(page.locator('h1 + [data-slot="badge"]')).toHaveText(label);
}

test.describe('P4-AC11: supplier lifecycle with maker-checker', () => {
  test('register, approve, identity change back to review, block, unblock', async ({ browser }) => {
    const dewi = await personaPage(browser, 'dewi.procurement', 210);
    const sari = await personaPage(browser, 'sari.finance', 211);
    const csp = watchCspViolations(dewi);
    const name = `E2E Supplier ${run}`;

    // Dewi registers it.
    await dewi.getByRole('link', { name: 'Suppliers' }).click();
    await dewi.getByRole('link', { name: 'Register supplier' }).click();
    await dewi.getByLabel('Legal name').fill(name);
    await dewi.getByLabel('Tax ID (optional)').fill(`E2E.${run}-01`);
    await dewi.getByLabel('Email (optional)').fill(`sales.${run}@example.com`);
    await dewi.getByLabel('City (optional)').fill('Springfield');
    await dewi.getByLabel('Country').selectOption('ID');
    await dewi.getByRole('button', { name: 'Register supplier' }).click();
    await expect(dewi.getByRole('heading', { name, level: 1 })).toBeVisible();
    await expectStatus(dewi, 'Pending review');
    const url = dewi.url();
    await expect(dewi.getByRole('button', { name: 'Approve' })).toHaveCount(0);

    // A second registration under a differently punctuated name is a duplicate.
    await dewi.goto('/suppliers/new');
    await dewi.getByLabel('Legal name').fill(`e2e-supplier. ${run.toUpperCase()}`);
    await dewi.getByLabel('Country').selectOption('ID');
    await dewi.getByRole('button', { name: 'Register supplier' }).click();
    await expect(dewi.locator('form').getByRole('alert')).toContainText('already has this name');

    // Sari finds it by tax ID typed differently, and approves it.
    await sari.goto('/suppliers');
    await sari.getByLabel('Search').fill(`e2e ${run} 01`.toUpperCase());
    await sari.getByRole('button', { name: 'Search' }).click();
    await sari.getByRole('link', { name }).click();
    await sari.getByRole('button', { name: 'Approve' }).click();
    await expect(sari.getByRole('status')).toHaveText('Supplier approved. It can now be used for purchasing.');
    await expectStatus(sari, 'Active');

    // Dewi changes the legal name: back to review, and she cannot approve it herself.
    await dewi.goto(url);
    await dewi.getByLabel('Legal name').fill(`${name} Group`);
    await dewi.getByRole('button', { name: 'Save changes' }).click();
    await expect(dewi.getByText('Saved. The supplier is pending review')).toBeVisible();
    await dewi.reload();
    await expectStatus(dewi, 'Pending review');

    await sari.goto(url);
    await expect(sari.getByText(`Identity last changed by`)).toBeVisible();
    await sari.getByRole('button', { name: 'Approve' }).click();
    await expectStatus(sari, 'Active');

    // Dewi blocks it with a reason; only finance can unblock, and then it needs a new review.
    await dewi.goto(url);
    await dewi.getByLabel('Reason for blocking').fill('Late deliveries');
    await dewi.getByRole('button', { name: 'Block supplier' }).click();
    await expect(dewi.getByRole('status')).toHaveText('Supplier blocked.');
    await expectStatus(dewi, 'Blocked');
    await expect(dewi.getByRole('button', { name: 'Unblock supplier' })).toHaveCount(0);

    await sari.goto(url);
    await sari.getByLabel('Reason for unblocking').fill('Deliveries back on time');
    await sari.getByRole('button', { name: 'Unblock supplier' }).click();
    await expect(sari.getByRole('status')).toContainText('Supplier unblocked.');
    await expectStatus(sari, 'Pending review');

    expect(csp).toEqual([]);
    await dewi.context().close();
    await sari.context().close();
  });
});

test.describe('P4-AC11: who sees suppliers', () => {
  test('an auditor reads, without any controls; a requester gets nothing', async ({ browser }) => {
    const lena = await personaPage(browser, 'lena.auditor', 220);
    await lena.getByRole('link', { name: 'Suppliers' }).click();
    await expect(lena.getByRole('heading', { name: 'Suppliers', level: 1 })).toBeVisible();
    await expect(lena.getByRole('link', { name: 'Register supplier' })).toHaveCount(0);
    await lena.getByRole('link', { name: 'Example Office Supplies Ltd' }).click();
    await expect(lena.getByRole('heading', { name: 'Example Office Supplies Ltd', level: 1 })).toBeVisible();
    await expect(lena.getByText('Sari Finance', { exact: false })).toBeVisible();
    for (const button of ['Save changes', 'Approve', 'Block supplier', 'Deactivate supplier']) {
      await expect(lena.getByRole('button', { name: button })).toHaveCount(0);
    }
    await lena.context().close();

    const rina = await personaPage(browser, 'rina.requester', 221);
    await expect(rina.getByRole('link', { name: 'Suppliers' })).toHaveCount(0);
    for (const path of ['/suppliers', '/suppliers/new']) {
      await rina.goto(path);
      await expect(rina.getByRole('heading', { name: 'Access denied' })).toBeVisible();
      await expect(rina.locator('main')).not.toContainText('Example Office Supplies');
    }
    await rina.context().close();
  });
});

test.describe('P4-AC11: supplier pages, assistive technology basics', () => {
  test('one h1 per page and every control labeled', async ({ browser }) => {
    const dewi = await personaPage(browser, 'dewi.procurement', 230);
    await dewi.goto('/suppliers');
    const detail = await dewi.getByRole('link', { name: 'Example Office Supplies Ltd' }).getAttribute('href');
    for (const path of ['/suppliers', '/suppliers/new', detail ?? '/suppliers']) {
      await dewi.goto(path);
      await expect(dewi.locator('h1')).toHaveCount(1);
      const unlabeled = await dewi.evaluate(() =>
        [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input:not([type=hidden]), select, textarea')]
          .filter((el) => (el.labels?.length ?? 0) === 0 && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby'))
          .map((el) => el.getAttribute('name') ?? el.outerHTML.slice(0, 80)),
      );
      expect({ path, unlabeled }).toEqual({ path, unlabeled: [] });
    }
    await dewi.context().close();
  });
});
