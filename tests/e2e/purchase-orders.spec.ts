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

const badge = (page: Page) => page.locator('h1 + [data-slot="badge"]');

async function unlabeledControls(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input:not([type=hidden]), select, textarea')]
      .filter((el) => (el.labels?.length ?? 0) === 0 && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby'))
      .map((el) => el.getAttribute('name') ?? el.id ?? el.outerHTML.slice(0, 80)),
  );
}

/** Opens a seeded requisition by its title, as `page`'s user. */
async function openRequisition(page: Page, title: string): Promise<void> {
  await page.goto(`/requisitions?q=${encodeURIComponent(title)}`);
  await page.getByRole('main').getByRole('table').getByRole('link', { name: /PR-\d{4}-\d{6}/ }).first().click();
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
}

/*
 * The seed (scripts/seed.ts) provides two requisitions for this spec, used nowhere else:
 * "Cleaning supplies for Operations" (157.00, under the RFQ threshold of 500: ordered directly) and
 * "Standing desks for Operations" (1,300.00), whose RFQ is awarded to Example Office Supplies at 640
 * a desk. Purchase orders from 1,000 need approval (finance, under the seeded PO policy).
 */
test.describe('P7-AC13: purchase orders', () => {
  test('a direct order below the threshold is approved on submit, issued, and printed; the print view is 404 for whoever cannot read it', async ({ browser }) => {
    test.setTimeout(120_000);
    const dewi = await personaPage(browser, 'dewi.procurement', 182);
    const csp = watchCspViolations(dewi);
    await openRequisition(dewi, 'Cleaning supplies for Operations');
    await dewi.getByRole('link', { name: 'Create purchase order' }).click();
    await expect(dewi.getByRole('heading', { name: 'New purchase order', level: 1 })).toBeVisible();
    await expect(dewi.locator('h1')).toHaveCount(1);
    expect(await unlabeledControls(dewi)).toEqual([]);

    // A missing supplier is refused, and what was typed stays.
    await dewi.getByLabel(/Tax rate in percent for line 1/).fill('11');
    await dewi.getByLabel('Payment terms (optional)').fill('Net 30');
    await dewi.getByRole('button', { name: 'Save draft purchase order' }).click();
    await expect(dewi.getByText('Some fields are invalid.')).toBeVisible();
    await expect(dewi.getByLabel(/Tax rate in percent for line 1/)).toHaveValue('11');
    const supplier = dewi.getByLabel('Supplier', { exact: true });
    await supplier.selectOption((await supplier.locator('option', { hasText: 'Example Office Supplies Ltd' }).getAttribute('value')) ?? '');
    await dewi.getByRole('button', { name: 'Save draft purchase order' }).click();
    await expect(dewi.getByRole('status')).toHaveText('Draft purchase order created. You can still change it.');
    await expect(badge(dewi)).toHaveText('Draft');
    // 10 × 8.50 = 85.00 + 11 % = 9.35; 6 × 12.00 = 72.00: 166.35.
    const totals = dewi.getByLabel('Totals');
    await expect(totals).toContainText('$157.00');
    await expect(totals).toContainText('$9.35');
    await expect(totals).toContainText('$166.35');
    const poPath = new URL(dewi.url()).pathname;
    const number = (await dewi.locator('h1 .font-mono').textContent()) ?? '';
    expect(number).toMatch(/^PO-\d{4}-\d{6}$/);

    // A draft prints with a warning.
    await dewi.getByRole('link', { name: 'Print view' }).click();
    await expect(dewi.getByText(/Not issued: this purchase order is draft and must not be sent to the supplier\./)).toBeVisible();
    await dewi.goto(poPath);

    await dewi.getByRole('button', { name: 'Submit purchase order' }).click();
    await expect(dewi.getByRole('status')).toHaveText(/Approved without an approval round/);
    await expect(badge(dewi)).toHaveText('Approved');
    await expect(dewi.getByText('No approval round: approved on submission, below the approval threshold.')).toBeVisible();
    await dewi.getByRole('button', { name: 'Issue purchase order' }).click();
    await expect(dewi.getByRole('status')).toHaveText(/Purchase order issued/);
    await expect(badge(dewi)).toHaveText('Issued');
    await expect(dewi.getByRole('table', { name: 'Lines' })).toContainText('10 can');

    await dewi.getByRole('link', { name: 'Print view' }).click();
    await expect(dewi.getByRole('heading', { name: `Purchase order ${number}`, level: 1 })).toBeVisible();
    await expect(dewi.getByText(/Not issued/)).toHaveCount(0);
    await expect(dewi.getByRole('table', { name: 'Order lines' })).toContainText('Floor cleaner, 5 l');
    await expect(dewi.getByText('Example Office Supplies Ltd').first()).toBeVisible();
    await expect(dewi.getByLabel('Totals')).toContainText('$166.35');
    await expect(dewi.getByText('Approved on submission: below the approval threshold.')).toBeVisible();
    await expect(dewi.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
    expect(csp).toEqual([]);
    await dewi.context().close();

    // The receiver reads issued orders; the requester cannot read purchase orders at all.
    const agus = await personaPage(browser, 'agus.receiver', 183);
    const printed = await agus.goto(`${poPath}/print`);
    expect(printed?.status()).toBe(200);
    await expect(agus.getByRole('heading', { name: `Purchase order ${number}`, level: 1 })).toBeVisible();
    await agus.context().close();
    const rina = await personaPage(browser, 'rina.requester', 184);
    const refused = await rina.goto(`${poPath}/print`);
    expect(refused?.status()).toBe(404);
    await expect(rina.getByText(number)).toHaveCount(0);
    await rina.goto(poPath);
    await expect(rina.getByRole('heading', { name: 'Access denied', level: 1 })).toBeVisible();
    await expect(rina.getByText(number)).toHaveCount(0);
    await rina.context().close();
  });

  test('an order from the award goes to finance, which approves it from the inbox; then it is issued and printed with the approval', async ({ browser }) => {
    test.setTimeout(120_000);
    const dewi = await personaPage(browser, 'dewi.procurement', 185);
    await openRequisition(dewi, 'Standing desks for Operations');
    await dewi.getByRole('table', { name: 'Requests for quotation' }).getByRole('link', { name: /RFQ-\d{4}-\d{6}/ }).click();
    await expect(badge(dewi)).toHaveText('Awarded');
    await dewi.getByRole('link', { name: 'Create purchase order from this award' }).click();
    await expect(dewi.getByText(/Supplier: Example Office Supplies Ltd \(from the awarded quotation\)/)).toBeVisible();
    await expect(dewi.getByText('from the quotation', { exact: true })).toBeVisible();
    await expect(dewi.getByLabel(/Unit price for line 1/)).toHaveCount(0);
    expect(await unlabeledControls(dewi)).toEqual([]);
    await dewi.getByLabel(/Tax rate in percent for line 1/).fill('11');
    await dewi.getByRole('button', { name: 'Save draft purchase order' }).click();
    await expect(badge(dewi)).toHaveText('Draft');
    // 2 × 640 (quoted) = 1,280.00 + 11 % = 140.80: 1,420.80.
    await expect(dewi.getByLabel('Totals')).toContainText('$1,420.80');
    const poPath = new URL(dewi.url()).pathname;
    const number = (await dewi.locator('h1 .font-mono').textContent()) ?? '';
    await dewi.getByRole('button', { name: 'Submit purchase order' }).click();
    await expect(dewi.getByRole('status')).toHaveText(/Submitted for approval/);
    await expect(badge(dewi)).toHaveText('Pending approval');
    await expect(dewi.getByText('The total is at or above the approval threshold of $1,000.00.')).toBeVisible();
    await expect(dewi.getByRole('heading', { name: 'Your decision' })).toHaveCount(0);
    await dewi.context().close();

    const sari = await personaPage(browser, 'sari.finance', 186);
    await sari.goto('/approvals');
    await sari.getByRole('table', { name: 'Waiting for your decision' }).getByRole('link', { name: number }).click();
    await expect(sari).toHaveURL(`${BASE}${poPath}`);
    await expect(sari.getByRole('heading', { name: 'Your decision' })).toBeVisible();
    await expect(sari.getByRole('heading', { name: 'Actions' })).toHaveCount(0);
    await sari.getByLabel('Approve', { exact: true }).check();
    await sari.getByLabel('Comment (required to reject or return)').fill('Within budget');
    await sari.getByRole('button', { name: 'Record decision' }).click();
    await expect(sari).toHaveURL(new RegExp(`${poPath}\\?notice=decided-approved`));
    await expect(sari.getByRole('status')).toHaveText('Your approval was recorded. The purchase order is approved.');
    await expect(badge(sari)).toHaveText('Approved');
    await expect(sari.getByRole('table', { name: 'Approval round 1' })).toContainText('Sari Finance');
    await sari.context().close();

    const buyer = await personaPage(browser, 'dewi.procurement', 187);
    await buyer.goto(poPath);
    await buyer.getByRole('button', { name: 'Issue purchase order' }).click();
    await expect(badge(buyer)).toHaveText('Issued');
    await buyer.getByRole('link', { name: 'Print view' }).click();
    await expect(buyer.getByText(/Approved by Finance: Sari Finance/)).toBeVisible();
    await expect(buyer.getByText(/EOS-Q-2030-031/)).toBeVisible();
    await buyer.context().close();
  });

  test('the settings show the purchase-order rule and the policy page the purchase-order policy, each with labeled controls', async ({ browser }) => {
    const ada = await personaPage(browser, 'ada.admin', 188);
    await ada.goto('/admin/settings');
    await expect(ada.getByLabel('Approval needed from (total with tax)')).toHaveValue('1000');
    await expect(ada.getByLabel('Price tolerance (%)')).toHaveValue('5');
    await expect(ada.getByLabel('Over-receipt tolerance (%)')).toHaveValue('0');
    expect(await unlabeledControls(ada)).toEqual([]);
    await ada.goto('/admin/approval-policy');
    await ada.getByRole('navigation', { name: 'Document type' }).getByRole('link', { name: 'Purchase orders' }).click();
    await expect(ada.getByRole('heading', { name: 'Approval policy for purchase orders', level: 1 })).toBeVisible();
    await expect(ada.getByText(/“Standard purchase-order approvals”/)).toBeVisible();
    await expect(ada.getByRole('table', { name: 'Active rules' })).toContainText('Finance');
    await expect(ada.locator('h1')).toHaveCount(1);
    expect(await unlabeledControls(ada)).toEqual([]);
    await ada.context().close();
  });
});
