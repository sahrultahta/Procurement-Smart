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

const badge = (page: Page) => page.locator('h1 + [data-slot="badge"]');

/*
 * Rina's requisition totals 600: under 1,000 the seeded policy routes it to the OPS approver
 * only, and requisitions.spec.ts (in parallel) only adds an OPS rule below 500.
 */
async function approvedRequisition(browser: Browser, title: string): Promise<string> {
  const rina = await personaPage(browser, 'rina.requester', 241);
  await rina.goto('/requisitions/new');
  await rina.getByLabel('Title').fill(title);
  await rina.getByLabel('Needed by').fill('2030-06-30');
  await rina.locator('#line-0-description').fill('Monitor arm');
  await rina.locator('#line-0-quantity').fill('2');
  await rina.locator('#line-0-uom').fill('pcs');
  await rina.locator('#line-0-price').fill('150');
  await rina.getByRole('button', { name: 'Add line' }).click();
  await rina.locator('#line-1-description').fill('Desk lamp');
  await rina.locator('#line-1-quantity').fill('3');
  await rina.locator('#line-1-uom').fill('pcs');
  await rina.locator('#line-1-price').fill('100');
  await rina.getByRole('button', { name: 'Create draft' }).click();
  await expect(rina.getByRole('heading', { name: title, level: 1 })).toBeVisible();
  await rina.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(badge(rina)).toHaveText('Pending approval');
  const path = new URL(rina.url()).pathname;
  await rina.context().close();

  const bayu = await personaPage(browser, 'bayu.approver', 242);
  await bayu.goto(path);
  await bayu.getByLabel('Approve', { exact: true }).check();
  await bayu.getByRole('button', { name: 'Record decision' }).click();
  await expect(badge(bayu)).toHaveText('Approved');
  await bayu.context().close();
  return path;
}

test.describe('P6a-AC9: the RFQ lifecycle', () => {
  test('Dewi drafts an RFQ from an approved requisition, invites 2 suppliers, issues and closes it; finance and the auditor only read', async ({ browser }) => {
    // Seven sign-ins and two documents through the UI: longer than the 30 s default when the suite runs in parallel.
    test.setTimeout(90_000);
    const title = `Desk equipment ${run}`;
    const requisitionPath = await approvedRequisition(browser, title);

    const dewi = await personaPage(browser, 'dewi.procurement', 243);
    const csp = watchCspViolations(dewi);
    await dewi.goto(requisitionPath);
    await expect(dewi.getByText('No RFQ for this requisition yet.')).toBeVisible();
    await dewi.getByRole('link', { name: 'Request quotations' }).click();
    await expect(dewi.getByRole('heading', { level: 1 })).toContainText('New RFQ for PR-');
    await expect(dewi.getByLabel('Title')).toHaveValue(title);
    await dewi.getByLabel(/Quotations due/).fill('2030-03-15T17:00');
    await expect(dewi.locator('#line-1-selected')).toBeChecked();
    await dewi.locator('#line-2-quantity').fill('3.5');
    await dewi.getByRole('button', { name: 'Create draft RFQ' }).click();
    // More than is left: the server refuses it and nothing is created.
    await expect(dewi.getByText(/has only 3 pcs left to order/)).toBeVisible();
    await dewi.locator('#line-2-quantity').fill('2');
    await dewi.getByLabel(/Example Office Supplies Ltd/).check();
    await dewi.getByLabel(/Sample Industrial Parts Co/).check();
    await dewi.getByRole('button', { name: 'Create draft RFQ' }).click();

    await expect(dewi.getByRole('status')).toHaveText('Draft RFQ created. You can still change it.');
    await expect(badge(dewi)).toHaveText('Draft');
    await expect(dewi.getByRole('table', { name: 'Lines' })).toContainText('2 pcs');
    await expect(dewi.getByRole('table', { name: 'Invited suppliers' }).getByRole('row')).toHaveCount(3); // header + 2
    const rfqPath = new URL(dewi.url()).pathname;
    const number = (await dewi.getByText(/RFQ-\d{4}-\d{6}/).first().textContent())?.match(/RFQ-\d{4}-\d{6}/)?.[0] ?? '';
    expect(number).not.toBe('');

    await dewi.getByRole('link', { name: 'Edit RFQ' }).click();
    await expect(dewi.getByLabel(/Example Office Supplies Ltd/)).toBeChecked();
    await dewi.getByLabel(/Sample Industrial Parts Co/).uncheck();
    await dewi.getByRole('button', { name: 'Save changes' }).click();
    await expect(dewi.getByRole('status')).toHaveText('Changes saved.');
    await expect(dewi.getByRole('table', { name: 'Invited suppliers' }).getByRole('row')).toHaveCount(2); // header + 1

    await dewi.getByRole('button', { name: 'Issue RFQ' }).click();
    await expect(dewi.getByRole('status')).toHaveText(/RFQ issued/);
    await expect(badge(dewi)).toHaveText('Issued');
    await expect(dewi.getByRole('link', { name: 'Edit RFQ' })).toHaveCount(0);

    // The requisition page lists it, and its lines can no longer be put on another RFQ.
    await dewi.goto(requisitionPath);
    await expect(dewi.getByRole('table', { name: 'Requests for quotation' })).toContainText(number);
    await dewi.getByRole('link', { name: 'Request quotations' }).click();
    await expect(dewi.locator('#line-1-selected')).toBeDisabled();
    await expect(dewi.getByText(`already on ${number}`).first()).toBeVisible();

    for (const [persona, ip] of [
      ['sari.finance', 244],
      ['lena.auditor', 245],
    ] as const) {
      const reader = await personaPage(browser, persona, ip);
      await reader.getByRole('link', { name: 'RFQs' }).click();
      await reader.getByRole('link', { name: number }).click();
      await expect(badge(reader)).toHaveText('Issued');
      await expect(reader.getByRole('heading', { name: 'Actions' })).toHaveCount(0);
      await reader.goto(`/rfqs/new?requisitionId=${requisitionPath.split('/').at(-1)}`);
      await expect(reader.getByRole('heading', { name: 'Access denied' })).toBeVisible();
      await reader.context().close();
    }

    await dewi.goto(rfqPath);
    await dewi.getByRole('button', { name: 'Close RFQ' }).click();
    await expect(dewi.getByRole('status')).toHaveText(/RFQ closed/);
    await expect(badge(dewi)).toHaveText('Closed');
    await dewi.getByRole('button', { name: 'Cancel RFQ' }).click();
    await expect(dewi.getByText('Give a reason (required)')).toBeVisible();
    await expect(badge(dewi)).toHaveText('Closed');

    expect(csp).toEqual([]);
    await dewi.context().close();
  });

  test('requesters see no RFQs; RFQ pages have one h1 and only labeled controls', async ({ browser }) => {
    const rina = await personaPage(browser, 'rina.requester', 246);
    await expect(rina.getByRole('link', { name: 'RFQs' })).toHaveCount(0);
    await rina.goto('/rfqs');
    await expect(rina.getByRole('heading', { name: 'Access denied' })).toBeVisible();
    await rina.context().close();

    const dewi = await personaPage(browser, 'dewi.procurement', 247);
    await dewi.goto('/rfqs');
    const first = await dewi.getByRole('table', { name: 'RFQs' }).getByRole('link', { name: /RFQ-\d{4}-\d{6}/ }).first().getAttribute('href');
    const requisition = await dewi.getByRole('table', { name: 'RFQs' }).getByRole('link', { name: /PR-\d{4}-\d{6}/ }).first().getAttribute('href');
    const paths = ['/rfqs', ...(first ? [first] : []), ...(requisition ? [`/rfqs/new?requisitionId=${requisition.split('/').at(-1)}`] : [])];
    expect(paths).toHaveLength(3);
    for (const path of paths) {
      await dewi.goto(path);
      await expect(dewi.locator('h1')).toHaveCount(1);
      const unlabeled = await dewi.evaluate(() =>
        [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input:not([type=hidden]), select, textarea')]
          .filter((el) => (el.labels?.length ?? 0) === 0 && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby'))
          .map((el) => el.getAttribute('name') ?? el.id ?? el.outerHTML.slice(0, 80)),
      );
      expect({ path, unlabeled }).toEqual({ path, unlabeled: [] });
    }
    await dewi.context().close();
  });
});
