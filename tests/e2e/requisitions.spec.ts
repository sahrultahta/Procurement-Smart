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

test.describe('P5a-AC10: organization settings and the approval policy editor', () => {
  test('an admin renames the organization, sees the locked currency, and publishes a policy version', async ({ browser }) => {
    const ada = await personaPage(browser, 'ada.admin', 150);
    const csp = watchCspViolations(ada);

    await ada.goto('/admin/settings');
    await expect(ada.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    // The seed created a requisition, so the currency is locked.
    await expect(ada.getByLabel('Currency')).toBeDisabled();
    await expect(ada.getByRole('note')).toContainText('The currency is locked');
    await ada.getByLabel('Organization name').fill(`Example Organization ${run}`);
    await ada.getByLabel('Time zone').selectOption('Asia/Jakarta');
    await ada.getByRole('button', { name: 'Save settings' }).click();
    await expect(ada.getByText('Settings saved.')).toBeVisible();

    await ada.goto('/admin/approval-policy');
    await expect(ada.getByRole('table', { name: 'Active rules' })).toContainText('Any department');
    await ada.getByRole('button', { name: 'Add rule' }).click();
    await ada.locator('#rule-2-department').selectOption('OPS');
    await ada.locator('#rule-2-min').fill('0');
    await ada.locator('#rule-2-max').fill('500');
    await ada.getByLabel('Rule 3, step 1').selectOption('finance');
    await ada.getByLabel('Version name').fill(`Small OPS purchases to finance ${run}`);
    await ada.getByRole('button', { name: 'Publish new version' }).click();
    await expect(ada.getByText(/Version \d+ published/)).toBeVisible();
    await ada.reload();
    await expect(ada.getByRole('table', { name: 'Active rules' })).toContainText('Operations (OPS)');
    await expect(ada.getByRole('table', { name: 'Policy versions' }).getByRole('row')).toHaveCount(3); // header + 2 versions

    // A gap is refused, and nothing is published.
    await ada.locator('#rule-1-min').fill('2000');
    await ada.getByRole('button', { name: 'Publish new version' }).click();
    await expect(ada.getByRole('listitem', { name: 'Rule 2' })).toContainText('Leaves a gap');
    await ada.reload();
    await expect(ada.getByRole('table', { name: 'Policy versions' }).getByRole('row')).toHaveCount(3);

    expect(csp).toEqual([]);
    await ada.context().close();
  });
});

test.describe('P5a-AC10: a requester drafts, edits, and cancels a requisition', () => {
  test('server totals, edit with recalculation, cancel; others see it read-only', async ({ browser }) => {
    const rina = await personaPage(browser, 'rina.requester', 160);
    const csp = watchCspViolations(rina);
    const title = `Office supplies ${run}`;

    await rina.getByRole('link', { name: 'Requisitions' }).click();
    await rina.getByRole('link', { name: 'New requisition' }).click();
    await rina.getByLabel('Title').fill(title);
    await rina.getByLabel('Needed by').fill('2030-06-30');
    await rina.getByLabel('Justification (optional)').fill('Monthly restock');
    await rina.locator('#line-0-description').fill('A4 paper');
    await rina.locator('#line-0-quantity').fill('3');
    await rina.locator('#line-0-uom').fill('ream');
    await rina.locator('#line-0-price').fill('10.005');
    await rina.getByRole('button', { name: 'Add line' }).click();
    await rina.locator('#line-1-description').fill('Pens');
    await rina.locator('#line-1-quantity').fill('0.5');
    await rina.locator('#line-1-uom').fill('box');
    await rina.locator('#line-1-price').fill('2.3333');
    await expect(rina.getByText('Estimated total:')).toContainText('$31.19');
    await rina.getByRole('button', { name: 'Create draft' }).click();

    await expect(rina.getByRole('heading', { name: title, level: 1 })).toBeVisible();
    await expect(rina.getByRole('status')).toHaveText('Draft created. You can still edit it.');
    await expect(rina.getByTestId('estimated-total')).toHaveText('$31.19');
    // The number under the title (the history card shows it too, as the created number).
    await expect(rina.locator('span.font-mono').getByText(/PR-\d{4}-\d{6}/)).toBeVisible();
    const url = rina.url();

    await rina.getByRole('link', { name: 'Edit requisition' }).click();
    await rina.locator('#line-0-quantity').fill('4');
    await rina.getByRole('button', { name: 'Save changes' }).click();
    await expect(rina.getByRole('status')).toHaveText('Changes saved. The total was recalculated.');
    await expect(rina.getByTestId('estimated-total')).toHaveText('$41.19');

    // Bayu (approver for OPS) and Dewi (procurement) can read it, but not change it.
    for (const [persona, ip] of [
      ['bayu.approver', 161],
      ['dewi.procurement', 162],
    ] as const) {
      const other = await personaPage(browser, persona, ip);
      await other.goto(url);
      await expect(other.getByRole('heading', { name: title, level: 1 })).toBeVisible();
      await expect(other.getByRole('link', { name: 'Edit requisition' })).toHaveCount(0);
      await expect(other.getByRole('button', { name: 'Cancel requisition' })).toHaveCount(0);
      await other.context().close();
    }

    await rina.getByLabel('Reason (optional)').fill('Ordered through another channel');
    await rina.getByRole('button', { name: 'Cancel requisition' }).click();
    await expect(rina.getByRole('status')).toHaveText('Requisition cancelled.');
    await expect(rina.locator('h1 + [data-slot="badge"]')).toHaveText('Cancelled');
    await expect(rina.getByRole('link', { name: 'Edit requisition' })).toHaveCount(0);

    expect(csp).toEqual([]);
    await rina.context().close();
  });

  test('a receiver has no requisitions, and an unknown id is simply not found', async ({ browser }) => {
    const agus = await personaPage(browser, 'agus.receiver', 170);
    await expect(agus.getByRole('link', { name: 'Requisitions' })).toHaveCount(0);
    await agus.goto('/requisitions');
    await expect(agus.getByRole('heading', { name: 'Access denied' })).toBeVisible();
    await agus.context().close();

    const rina = await personaPage(browser, 'rina.requester', 171);
    const response = await rina.goto('/requisitions/01900000-0000-7000-8000-000000000000');
    expect(response?.status()).toBe(404);
    await rina.context().close();
  });
});

test.describe('P5a-AC10: requisition and settings pages, assistive technology basics', () => {
  test('one h1 per page and every control labeled', async ({ browser }) => {
    const pages: [string, number, string[]][] = [
      ['rina.requester', 180, ['/requisitions', '/requisitions/new']],
      ['ada.admin', 181, ['/admin/settings', '/admin/approval-policy']],
    ];
    for (const [persona, ip, paths] of pages) {
      const page = await personaPage(browser, persona, ip);
      if (persona === 'rina.requester') {
        await page.goto('/requisitions');
        const first = await page.getByRole('link', { name: /PR-\d{4}-\d{6}/ }).first().getAttribute('href');
        if (first) paths.push(first);
      }
      for (const path of paths) {
        await page.goto(path);
        await expect(page.locator('h1')).toHaveCount(1);
        const unlabeled = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input:not([type=hidden]), select, textarea')]
            .filter((el) => (el.labels?.length ?? 0) === 0 && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby'))
            .map((el) => el.getAttribute('name') ?? el.id ?? el.outerHTML.slice(0, 80)),
        );
        expect({ path, unlabeled }).toEqual({ path, unlabeled: [] });
      }
      await page.context().close();
    }
  });
});
