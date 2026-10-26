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

/*
 * Routes come from the seeded policy: under 1,000 the OPS approver, from 1,000 the OPS approver and
 * then finance. requisitions.spec.ts (running in parallel) may add an OPS rule for 0 to 500, so the
 * single-step cases here stay between 500 and 1,000, where every version routes to the OPS approver.
 */

/** Rina drafts a requisition with one line and submits it; returns its path. */
async function submitRequisition(rina: Page, title: string, quantity: string, price: string): Promise<string> {
  await rina.goto('/requisitions/new');
  await rina.getByLabel('Title').fill(title);
  await rina.getByLabel('Needed by').fill('2030-06-30');
  await rina.locator('#line-0-description').fill('USB-C docking station');
  await rina.locator('#line-0-quantity').fill(quantity);
  await rina.locator('#line-0-uom').fill('pcs');
  await rina.locator('#line-0-price').fill(price);
  await rina.getByRole('button', { name: 'Create draft' }).click();
  await expect(rina.getByRole('heading', { name: title, level: 1 })).toBeVisible();
  await rina.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(rina.getByRole('status')).toHaveText(/Submitted for approval/);
  await expect(rina.locator('h1 + [data-slot="badge"]')).toHaveText('Pending approval');
  return new URL(rina.url()).pathname;
}

async function decide(page: Page, decision: 'Approve' | 'Return for changes' | 'Reject', comment?: string): Promise<void> {
  await page.getByLabel(decision, { exact: true }).check();
  if (comment !== undefined) await page.getByLabel('Comment (required to reject or return)').fill(comment);
  await page.getByRole('button', { name: 'Record decision' }).click();
}

const badge = (page: Page) => page.locator('h1 + [data-slot="badge"]');
const round = (page: Page, n: number) => page.getByRole('table', { name: `Approval round ${n}` });

test.describe('P5b-AC13 / P5-AC11: the golden path', () => {
  test('Rina submits, Bayu approves step 1, Sari approves step 2, the history shows both, Dewi closes it', async ({ browser }) => {
    // Four sign-ins: about 31 s while the Phase 6b specs run in parallel, over the 30 s default.
    test.setTimeout(90_000);
    const rina = await personaPage(browser, 'rina.requester', 190);
    const csp = watchCspViolations(rina);
    const title = `Docking stations ${run}`;
    const url = await submitRequisition(rina, title, '2', '600');
    await expect(round(rina, 1)).toContainText('Approver for OPS');
    await expect(round(rina, 1)).toContainText('Finance');
    await expect(rina.getByRole('heading', { name: 'Your approval' })).toHaveCount(0);
    await expect(rina.getByRole('link', { name: 'Edit requisition' })).toHaveCount(0);
    await expect(rina.getByRole('button', { name: 'Withdraw requisition' })).toBeVisible();

    // Bayu finds it in his inbox and approves step 1.
    const bayu = await personaPage(browser, 'bayu.approver', 191);
    const bayuCsp = watchCspViolations(bayu);
    await bayu.getByRole('link', { name: 'Approvals' }).click();
    const row = bayu.getByRole('table', { name: 'Waiting for your decision' }).getByRole('row', { name: new RegExp(title) });
    await expect(row).toContainText('1 of 2: Approver for OPS');
    await expect(row).toContainText('$1,200.00');
    await row.getByRole('link').click();
    await expect(bayu).toHaveURL(`${BASE}${url}`);
    await expect(bayu.getByRole('group', { name: /Your decision on step 1/ })).toBeVisible();
    await decide(bayu, 'Approve');
    await expect(bayu.getByRole('status')).toHaveText('Your approval was recorded. The next step is now open.');
    await expect(bayu.getByRole('heading', { name: 'Your approval' })).toHaveCount(0);
    await bayu.goto('/approvals');
    await expect(bayu.getByText(title)).toHaveCount(0);

    // Sari (finance) approves step 2, the last one.
    const sari = await personaPage(browser, 'sari.finance', 192);
    await sari.goto('/approvals');
    const sariRow = sari.getByRole('row', { name: new RegExp(title) });
    await expect(sariRow).toContainText('2 of 2: Finance');
    await sariRow.getByRole('link').click();
    await decide(sari, 'Approve', 'Within budget');
    await expect(sari.getByRole('status')).toHaveText('Your approval was recorded. The requisition is approved.');
    await expect(badge(sari)).toHaveText('Approved');

    // Rina sees the full history.
    await rina.reload();
    await expect(badge(rina)).toHaveText('Approved');
    const history = round(rina, 1);
    await expect(history.getByRole('row').nth(1)).toContainText(e2eUser('bayu.approver').name);
    await expect(history.getByRole('row').nth(1)).toContainText('Approved');
    await expect(history.getByRole('row').nth(2)).toContainText(e2eUser('sari.finance').name);
    await expect(history.getByRole('row').nth(2)).toContainText('Within budget');
    await expect(rina.getByText(/Round 1: approved/)).toBeVisible();

    // Procurement closes it.
    const dewi = await personaPage(browser, 'dewi.procurement', 193);
    await dewi.goto(url);
    await dewi.getByRole('button', { name: 'Close requisition' }).click();
    await expect(dewi.getByText('Give a reason (required)')).toBeVisible();
    await dewi.getByLabel('Reason for closing').fill('Ordered outside the system during the pilot');
    await dewi.getByRole('button', { name: 'Close requisition' }).click();
    await expect(dewi.getByRole('status')).toHaveText(/Requisition closed/);
    await expect(badge(dewi)).toHaveText('Closed');

    expect(csp).toEqual([]);
    expect(bayuCsp).toEqual([]);
    for (const page of [rina, bayu, sari, dewi]) await page.context().close();
  });
});

test.describe('P5b-AC13: return, resubmit, withdraw', () => {
  test('Bayu returns it with a comment, Rina edits and resubmits (round 2), then withdraws another one', async ({ browser }) => {
    const rina = await personaPage(browser, 'rina.requester', 194);
    const csp = watchCspViolations(rina);
    const title = `Desk lamps ${run}`;
    const url = await submitRequisition(rina, title, '4', '150');

    const bayu = await personaPage(browser, 'bayu.approver', 195);
    await bayu.goto(url);
    await decide(bayu, 'Return for changes');
    await expect(bayu.getByText('Explain why you return it (required)')).toBeVisible();
    await decide(bayu, 'Return for changes', 'Please use the standard lamp model');
    await expect(bayu.getByRole('status')).toHaveText('Requisition returned to the requester for changes.');

    await rina.reload();
    await expect(badge(rina)).toHaveText('Returned');
    await expect(rina.getByText(`Returned for changes by ${e2eUser('bayu.approver').name}`)).toBeVisible();
    await expect(rina.getByText('Please use the standard lamp model').first()).toBeVisible();
    await rina.getByRole('link', { name: 'Edit requisition' }).click();
    await rina.locator('#line-0-description').fill('Standard desk lamp');
    await rina.getByRole('button', { name: 'Save changes' }).click();
    await expect(rina.getByRole('status')).toHaveText('Changes saved. The total was recalculated.');
    await rina.getByRole('button', { name: 'Submit for approval' }).click();
    await expect(rina.getByRole('status')).toHaveText(/Submitted for approval/);
    await expect(rina.getByText('Round 2: in progress')).toBeVisible();
    await expect(rina.getByText('Round 1: returned for changes')).toBeVisible();

    await bayu.goto(url);
    await decide(bayu, 'Approve');
    await expect(bayu.getByRole('status')).toHaveText('Your approval was recorded. The requisition is approved.');

    // Withdrawing a pending requisition needs a reason, and takes it out of the inbox.
    const other = `Spare chairs ${run}`;
    await submitRequisition(rina, other, '2', '300');
    await rina.getByRole('button', { name: 'Withdraw requisition' }).click();
    await expect(rina.getByText('Say why you are withdrawing it (required)')).toBeVisible();
    await rina.getByLabel('Reason for withdrawing').fill('Found spare chairs in storage');
    await rina.getByRole('button', { name: 'Withdraw requisition' }).click();
    await expect(rina.getByRole('status')).toHaveText('Requisition withdrawn. Its approval was cancelled.');
    await expect(badge(rina)).toHaveText('Cancelled');
    await bayu.goto('/approvals');
    await expect(bayu.getByText(other)).toHaveCount(0);

    expect(csp).toEqual([]);
    await rina.context().close();
    await bayu.context().close();
  });

  test('approval pages: one h1, labeled controls; roles without approvals see no inbox', async ({ browser }) => {
    const rina = await personaPage(browser, 'rina.requester', 196);
    await expect(rina.getByRole('link', { name: 'Approvals' })).toHaveCount(0);
    await rina.goto('/approvals');
    await expect(rina.getByRole('heading', { name: 'Access denied' })).toBeVisible();
    const url = await submitRequisition(rina, `Whiteboard markers ${run}`, '10', '60');
    await rina.context().close();

    const bayu = await personaPage(browser, 'bayu.approver', 197);
    for (const path of ['/approvals', url]) {
      await bayu.goto(path);
      await expect(bayu.locator('h1')).toHaveCount(1);
      const unlabeled = await bayu.evaluate(() =>
        [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input:not([type=hidden]), select, textarea')]
          .filter((el) => (el.labels?.length ?? 0) === 0 && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby'))
          .map((el) => el.getAttribute('name') ?? el.id ?? el.outerHTML.slice(0, 80)),
      );
      expect({ path, unlabeled }).toEqual({ path, unlabeled: [] });
    }
    await expect(bayu.getByRole('heading', { name: 'Your approval' })).toBeVisible();
    await bayu.context().close();
  });
});
