import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { clientIp, e2eUser, signIn, watchCspViolations } from './support';

const BASE = 'http://127.0.0.1:3100';

async function personaPage(browser: Browser, persona: string, ip: number): Promise<Page> {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': clientIp(ip) } });
  const page = await context.newPage();
  const user = e2eUser(persona);
  await signIn(page, user.email, user.password);
  await expect(page).toHaveURL(`${BASE}/`);
  return page;
}

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });

/*
 * P9-AC9. Other specs add orders while this one runs, so it checks what the seed guarantees
 * (the printer-supplies order, the toner split pair) and the shape of each page, never exact totals;
 * the integration tests check the figures.
 */
test.describe('P9-AC9: reports and the audit trail', () => {
  test('Sari reads spend by supplier, downloads it as CSV, and sees an explicit empty state', async ({ browser }) => {
    const sari = await personaPage(browser, 'sari.finance', 60);
    const csp = watchCspViolations(sari);
    await nav(sari).getByRole('link', { name: 'Reports' }).click();
    await expect(sari.getByRole('heading', { name: 'Reports', level: 1 })).toBeVisible();
    await sari.getByRole('link', { name: /Spend by supplier/ }).click();
    await expect(sari.getByRole('heading', { name: 'Spend by supplier', level: 1 })).toBeVisible();
    await expect(sari.getByTestId('report-as-of')).toContainText('Figures as of');
    const table = sari.getByRole('table', { name: 'Spend by supplier' });
    await expect(table.getByRole('row').filter({ hasText: 'Example Office Supplies Ltd' })).toHaveCount(1);

    const [download] = await Promise.all([sari.waitForEvent('download'), sari.getByRole('link', { name: 'Download CSV' }).click()]);
    expect(download.suggestedFilename()).toMatch(/^spendBySupplier-\d{4}-\d{2}-\d{2}\.csv$/);
    const csv = readFileSync(await download.path(), 'utf8');
    expect(csv.startsWith('﻿Supplier code,Supplier,Basis,Purchase orders,Currency,Total,As of\r\n')).toBe(true);
    expect(csv).toMatch(/\r\nSUP-[^,]+,Example Office Supplies Ltd,issued,\d+,[A-Z]{3},\d+\.\d{2},\d{4}-\d{2}-\d{2}T/);

    await sari.getByLabel('From').fill('2020-01-01');
    await sari.getByLabel('To').fill('2020-01-31');
    await sari.getByRole('button', { name: 'Show' }).click();
    await expect(sari.getByTestId('report-empty')).toHaveText(/No spend between/);
    await expect(sari.getByRole('table', { name: 'Spend by supplier' })).toHaveCount(0);

    for (const [link, heading] of [
      ['Spend by department', 'Spend by department'],
      ['Requisition cycle time', 'Requisition cycle time'],
      ['Approval aging', 'Approval aging'],
      ['Open purchase orders', 'Open purchase orders'],
    ] as const) {
      await sari.goto('/reports');
      await sari.getByRole('link', { name: new RegExp(link) }).click();
      await expect(sari.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
      await expect(sari.getByTestId('report-as-of')).toBeVisible();
    }
    await expect(sari.getByRole('table', { name: 'Open purchase orders' }).getByRole('row').filter({ hasText: 'Example Office Supplies Ltd' }).first()).toBeVisible();
    // Finance has no audit search.
    await expect(nav(sari).getByRole('link', { name: 'Audit' })).toHaveCount(0);
    expect(csp).toEqual([]);
    await sari.context().close();
  });

  test('Lena searches the audit trail and finds the seeded split purchase', async ({ browser }) => {
    const lena = await personaPage(browser, 'lena.auditor', 61);
    const csp = watchCspViolations(lena);
    await nav(lena).getByRole('link', { name: 'Audit' }).click();
    await expect(lena.getByRole('heading', { name: 'Audit trail', level: 1 })).toBeVisible();
    await lena.getByLabel('Record type').selectOption('purchase_order');
    await lena.getByLabel('Action').fill('po.issued');
    await lena.getByRole('button', { name: 'Search' }).click();
    await expect(lena).toHaveURL(/entityType=purchase_order/);
    const rows = lena.getByRole('table', { name: 'Audit events' }).getByRole('row');
    await expect(rows.nth(1)).toContainText('po.issued');
    await rows.nth(1).getByText(/^\d+ changes?/).click();
    await expect(rows.nth(1).getByText('IP address')).toBeVisible();
    await expect(rows.nth(1).getByText('User agent')).toBeVisible();

    await lena.getByLabel('Action').fill('nothing.happened');
    await lena.getByRole('button', { name: 'Search' }).click();
    await expect(lena.getByRole('cell', { name: 'No audit events match these filters.' })).toBeVisible();

    await nav(lena).getByRole('link', { name: 'Reports' }).click();
    await lena.getByRole('link', { name: /Potential split purchases/ }).click();
    await expect(lena.getByRole('heading', { name: 'Potential split purchases', level: 1 })).toBeVisible();
    const rinaGroups = lena.getByTestId('split-group').filter({ hasText: 'Rina Requester · Example Office Supplies Ltd' }).filter({ hasText: 'RFQ threshold' });
    await expect(rinaGroups.first()).toBeVisible();
    expect(csp).toEqual([]);
    await lena.context().close();
  });

  test('report and audit pages have one h1 and only labeled controls', async ({ browser }) => {
    const lena = await personaPage(browser, 'lena.auditor', 63);
    for (const path of [
      '/reports',
      '/reports/spend-by-supplier',
      '/reports/spend-by-department',
      '/reports/cycle-time',
      '/reports/approval-aging',
      '/reports/open-purchase-orders',
      '/reports/split-purchases',
      '/audit',
    ]) {
      await lena.goto(path);
      await expect(lena.locator('h1'), path).toHaveCount(1);
      const unlabeled = await lena.evaluate(() =>
        [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input:not([type=hidden]), select, textarea')]
          .filter((el) => (el.labels?.length ?? 0) === 0 && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby'))
          .map((el) => el.getAttribute('name') ?? el.id),
      );
      expect(unlabeled, path).toEqual([]);
    }
    await lena.context().close();
  });

  test('Rina sees her requisition history, and neither reports nor the audit trail', async ({ browser }) => {
    const rina = await personaPage(browser, 'rina.requester', 62);
    await expect(nav(rina).getByRole('link', { name: 'Reports' })).toHaveCount(0);
    await expect(nav(rina).getByRole('link', { name: 'Audit' })).toHaveCount(0);
    await rina.goto('/requisitions?q=Toner%20cartridges%20for%20Operations');
    await rina.getByRole('link', { name: /PR-\d{4}-\d{6}/ }).first().click();
    await expect(rina.getByRole('heading', { name: 'Toner cartridges for Operations', level: 1 })).toBeVisible();
    const history = rina.getByRole('list', { name: 'Document history' });
    await expect(history.getByRole('listitem').first()).toContainText('requisition.created');
    await expect(history).toContainText('by Rina Requester');
    await expect(history).not.toContainText('IP');

    await rina.goto('/reports');
    await expect(rina.getByRole('heading', { name: 'Access denied' })).toBeVisible();
    await rina.goto('/audit');
    await expect(rina.getByRole('heading', { name: 'Access denied' })).toBeVisible();
    const csv = await rina.request.get('/reports/export/spendBySupplier?from=2025-01-01&to=2025-12-31');
    expect(csv.status()).toBe(403);
    expect(await csv.text()).not.toContain('Example Office Supplies');
    await rina.context().close();
  });
});
