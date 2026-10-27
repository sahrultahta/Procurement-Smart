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

async function unlabeledControls(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input:not([type=hidden]), select, textarea')]
      .filter((el) => (el.labels?.length ?? 0) === 0 && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby'))
      .map((el) => el.getAttribute('name') ?? el.id ?? el.outerHTML.slice(0, 80)),
  );
}

/*
 * P8-AC10. The requisition is under the RFQ threshold (500), so it is ordered directly, and under the
 * PO approval threshold (1,000), so the order is approved on submission. Its approval route is the OPS
 * approver, or finance if requisitions.spec.ts (running in parallel) has published its OPS rule for
 * 0 to 500 first: whoever has the open decision approves. The over-receipt tolerance is 0.
 */
test.describe('P8-AC10: goods receipts', () => {
  test('golden path: requisition → approval → issued order → partial receipt → final receipt → received; a reversal reopens it', async ({ browser }) => {
    test.setTimeout(240_000);
    const title = `Safety gloves ${run}`;
    const rina = await personaPage(browser, 'rina.requester', 200);
    await rina.goto('/requisitions/new');
    await rina.getByLabel('Title').fill(title);
    await rina.getByLabel('Needed by').fill('2030-06-30');
    await rina.locator('#line-0-description').fill('Cut-resistant gloves');
    await rina.locator('#line-0-quantity').fill('10');
    await rina.locator('#line-0-uom').fill('pair');
    await rina.locator('#line-0-price').fill('4.50');
    await rina.getByRole('button', { name: 'Create draft' }).click();
    await expect(rina.getByRole('heading', { name: title, level: 1 })).toBeVisible();
    await rina.getByRole('button', { name: 'Submit for approval' }).click();
    await expect(badge(rina)).toHaveText('Pending approval');
    const requisitionPath = new URL(rina.url()).pathname;

    for (const [persona, ip] of [
      ['bayu.approver', 201],
      ['sari.finance', 202],
    ] as const) {
      const approver = await personaPage(browser, persona, ip);
      await approver.goto(requisitionPath);
      if ((await approver.getByRole('heading', { name: 'Your approval' }).count()) > 0) {
        await approver.getByLabel('Approve', { exact: true }).check();
        await approver.getByRole('button', { name: 'Record decision' }).click();
        await expect(approver.getByRole('status')).toHaveText(/Your approval was recorded/);
      }
      await approver.context().close();
    }
    await rina.reload();
    await expect(badge(rina)).toHaveText('Approved');
    await rina.context().close();

    // Dewi orders it directly, and issues the order.
    const dewi = await personaPage(browser, 'dewi.procurement', 203);
    await dewi.goto(requisitionPath);
    await dewi.getByRole('link', { name: 'Create purchase order' }).click();
    const supplier = dewi.getByLabel('Supplier', { exact: true });
    await supplier.selectOption((await supplier.locator('option', { hasText: 'Example Office Supplies Ltd' }).getAttribute('value')) ?? '');
    await dewi.getByRole('button', { name: 'Save draft purchase order' }).click();
    await expect(badge(dewi)).toHaveText('Draft');
    await dewi.getByRole('button', { name: 'Submit purchase order' }).click();
    await expect(badge(dewi)).toHaveText('Approved');
    await dewi.getByRole('button', { name: 'Issue purchase order' }).click();
    await expect(badge(dewi)).toHaveText('Issued');
    const poPath = new URL(dewi.url()).pathname;
    const purchaseOrderId = poPath.split('/').at(-1) ?? '';
    const number = (await dewi.locator('h1 .font-mono').textContent()) ?? '';
    expect(number).toMatch(/^PO-\d{4}-\d{6}$/);
    // SOD-04: the buyer is not offered receiving, and cannot reach the form.
    await expect(dewi.getByRole('link', { name: 'Receive goods' })).toHaveCount(0);
    await dewi.goto(`/goods-receipts/new?purchaseOrderId=${purchaseOrderId}`);
    await expect(dewi.getByRole('heading', { name: 'Access denied', level: 1 })).toBeVisible();
    await dewi.context().close();

    // Agus finds the order waiting for goods and receives 6 of the 10 pairs.
    const agus = await personaPage(browser, 'agus.receiver', 204);
    const csp = watchCspViolations(agus);
    await agus.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Receiving' }).click();
    await expect(agus.getByRole('heading', { name: 'Receiving', level: 1 })).toBeVisible();
    await expect(agus.locator('h1')).toHaveCount(1);
    expect(await unlabeledControls(agus)).toEqual([]);
    await agus.getByRole('table', { name: 'Purchase orders waiting for goods' }).getByRole('link', { name: `Receive goods for ${number}` }).click();
    await expect(agus.getByRole('heading', { name: 'Receive goods', level: 1 })).toBeVisible();
    await expect(agus.locator('h1')).toHaveCount(1);
    expect(await unlabeledControls(agus)).toEqual([]);
    const quantity = agus.getByLabel(/Quantity received for line 1/);
    await expect(quantity).toHaveValue('10');
    // More than ordered is refused as a whole, and what was typed stays.
    await quantity.fill('11');
    await agus.getByLabel('Delivery note reference (optional)').fill('DN-E2E-1');
    await agus.getByRole('button', { name: 'Save draft receipt' }).click();
    await expect(agus.getByText('Line 1 can take only 10 pair more, so nothing on this receipt was received.')).toBeVisible();
    await expect(quantity).toHaveValue('11');
    await expect(agus.getByLabel('Delivery note reference (optional)')).toHaveValue('DN-E2E-1');
    await quantity.fill('6');
    await agus.getByRole('button', { name: 'Save draft receipt' }).click();
    await expect(agus.getByRole('status')).toHaveText('Draft receipt recorded. Nothing is received until you post it.');
    await expect(badge(agus)).toHaveText('Draft');
    await agus.getByRole('button', { name: 'Post receipt' }).click();
    await expect(agus.getByRole('status')).toHaveText(/Receipt posted/);
    await expect(badge(agus)).toHaveText('Posted');
    await expect(agus.getByRole('table', { name: 'Lines' })).toContainText('6 of up to 10 pair');
    await expect(agus.getByText('Partially received', { exact: true })).toBeVisible();

    // The rest arrives: received from the order page, where the form offers what is left.
    await agus.goto(poPath);
    await expect(badge(agus)).toHaveText('Partially received');
    await agus.getByRole('link', { name: 'Receive goods' }).click();
    await expect(agus.getByLabel(/Quantity received for line 1/)).toHaveValue('4');
    await agus.getByRole('button', { name: 'Save draft receipt' }).click();
    await expect(badge(agus)).toHaveText('Draft');
    await agus.getByRole('button', { name: 'Post receipt' }).click();
    await expect(badge(agus)).toHaveText('Posted');
    const lastReceipt = new URL(agus.url()).pathname;
    const lastNumber = (await agus.locator('h1 .font-mono').textContent()) ?? '';
    await agus.goto(poPath);
    await expect(badge(agus)).toHaveText('Received');
    await expect(agus.getByRole('link', { name: 'Receive goods' })).toHaveCount(0);
    await expect(agus.getByRole('table', { name: 'Goods receipts' }).getByRole('row')).toHaveCount(3); // header + 2

    // The last delivery was counted wrongly: Agus reverses it, and the order is partially received again.
    await agus.goto(lastReceipt);
    await agus.getByRole('button', { name: 'Reverse receipt' }).click();
    await expect(agus.getByText('Give a reason (required)')).toBeVisible();
    await agus.getByLabel('Reason for reversing').fill('Four pairs were the wrong size');
    await agus.getByRole('button', { name: 'Reverse receipt' }).click();
    await expect(agus.getByRole('status')).toHaveText(/Reversal posted/);
    await expect(agus.getByRole('heading', { name: /^Reversal GR-\d{4}-\d{6}$/, level: 1 })).toBeVisible();
    await expect(agus.getByText(`${lastNumber}: Four pairs were the wrong size`)).toBeVisible();
    await expect(agus.getByText('Partially received', { exact: true })).toBeVisible();
    await expect(agus.getByRole('heading', { name: 'Actions' })).toHaveCount(0);
    expect(csp).toEqual([]);
    const reversalPath = new URL(agus.url()).pathname;
    await agus.context().close();

    // Finance and the auditor read receipts, without actions; the requester has no receiving at all.
    for (const [persona, ip] of [
      ['sari.finance', 205],
      ['lena.auditor', 206],
    ] as const) {
      const reader = await personaPage(browser, persona, ip);
      await reader.goto(lastReceipt);
      await expect(reader.getByRole('heading', { name: `Goods receipt ${lastNumber}`, level: 1 })).toBeVisible();
      await expect(reader.getByRole('heading', { name: 'Actions' })).toHaveCount(0);
      await reader.goto('/goods-receipts');
      await expect(reader.getByRole('table', { name: 'Purchase orders waiting for goods' })).toHaveCount(0);
      await expect(reader.getByRole('table', { name: 'Goods receipts' })).toBeVisible();
      await reader.goto(reversalPath);
      await expect(reader.getByRole('heading', { name: /^Reversal / })).toBeVisible();
      await reader.context().close();
    }
    const requester = await personaPage(browser, 'rina.requester', 207);
    await expect(requester.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Receiving' })).toHaveCount(0);
    await requester.goto('/goods-receipts');
    await expect(requester.getByRole('heading', { name: 'Access denied', level: 1 })).toBeVisible();
    await requester.context().close();
  });
});
