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
 * Rina's requisition totals 600: under 1,000 the seeded policy routes it to the OPS approver only.
 * The seed sets the award rule to "from 500, 3 valid quotations", so 2 quotations need a
 * justification. This spec never saves the settings: requisitions.spec.ts does, in parallel.
 */
async function approvedRequisition(browser: Browser, title: string): Promise<string> {
  const rina = await personaPage(browser, 'rina.requester', 198);
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

  const bayu = await personaPage(browser, 'bayu.approver', 199);
  await bayu.goto(path);
  await bayu.getByLabel('Approve', { exact: true }).check();
  await bayu.getByRole('button', { name: 'Record decision' }).click();
  await expect(badge(bayu)).toHaveText('Approved');
  await bayu.context().close();
  return path;
}

async function recordQuotation(dewi: Page, supplier: RegExp, prices: [string, string], validUntil: string, leadTime: string): Promise<void> {
  await dewi.getByRole('link', { name: supplier }).click();
  await expect(dewi.getByRole('heading', { level: 1 })).toContainText('Quotation from');
  await dewi.getByLabel('Valid until').fill(validUntil);
  await dewi.getByLabel('Lead time (days)').fill(leadTime);
  await dewi.getByLabel(/Unit price for line 1/).fill(prices[0]);
  await dewi.getByLabel(/Unit price for line 2/).fill(prices[1]);
  await dewi.getByRole('button', { name: 'Save draft quotation' }).click();
  await expect(dewi.getByRole('status')).toHaveText('Quotation saved as a draft. Submit it once it is complete.');
}

test.describe('P6b-AC11: quotations, comparison, and award', () => {
  test('Dewi records two quotations, compares them, closes the RFQ, and awards one with a justification; finance and the auditor only read', async ({ browser }) => {
    // Eight sign-ins and the whole sourcing flow through the UI.
    test.setTimeout(150_000);
    const title = `Quoted desk equipment ${run}`;
    const requisitionPath = await approvedRequisition(browser, title);

    const dewi = await personaPage(browser, 'dewi.procurement', 200);
    const csp = watchCspViolations(dewi);
    await dewi.goto(requisitionPath);
    await dewi.getByRole('link', { name: 'Request quotations' }).click();
    await dewi.getByLabel(/Quotations due/).fill('2030-03-15T17:00');
    await dewi.getByLabel(/Example Office Supplies Ltd/).check();
    await dewi.getByLabel(/Sample Industrial Parts Co/).check();
    await dewi.getByRole('button', { name: 'Create draft RFQ' }).click();
    await expect(badge(dewi)).toHaveText('Draft');
    await dewi.getByRole('button', { name: 'Issue RFQ' }).click();
    await expect(badge(dewi)).toHaveText('Issued');
    const rfqPath = new URL(dewi.url()).pathname;
    await expect(dewi.getByText('No quotation recorded yet.')).toBeVisible();

    // The first quotation: a missing price is refused, and what was typed stays.
    const recordLink = dewi.getByRole('link', { name: /Record quotation from Example Office Supplies Ltd/ });
    const recordPath = (await recordLink.getAttribute('href')) ?? '';
    expect(recordPath).toMatch(/\/quotations\/new\?supplierId=/);
    await recordLink.click();
    await expect(dewi.getByRole('heading', { name: 'Quotation from Example Office Supplies Ltd', level: 1 })).toBeVisible();
    await expect(dewi.locator('h1')).toHaveCount(1);
    expect(await unlabeledControls(dewi)).toEqual([]);
    await dewi.getByLabel("Supplier's reference (optional)").fill(`EOS-${run}`);
    await dewi.getByLabel('Valid until').fill('2030-06-30');
    await dewi.getByLabel('Lead time (days)').fill('10');
    await dewi.getByLabel(/Unit price for line 1/).fill('140');
    await dewi.getByRole('button', { name: 'Save draft quotation' }).click();
    await expect(dewi.getByText(/Enter an amount/).first()).toBeVisible();
    await expect(dewi.getByLabel(/Unit price for line 1/)).toHaveValue('140');
    await expect(dewi.getByLabel('Valid until')).toHaveValue('2030-06-30');
    await dewi.getByLabel(/Unit price for line 2/).fill('95');
    await dewi.getByRole('button', { name: 'Save draft quotation' }).click();
    await expect(dewi.getByRole('status')).toHaveText('Quotation saved as a draft. Submit it once it is complete.');
    // 2 × 140 + 3 × 95 = 565.00, computed by the server.
    const quotations = dewi.getByRole('table', { name: 'Quotations' });
    await expect(quotations).toContainText('Draft');
    await expect(quotations).toContainText('$565.00');
    // A draft can still be edited.
    await dewi.getByRole('link', { name: 'Edit the quotation from Example Office Supplies Ltd' }).click();
    await expect(dewi.getByRole('heading', { name: 'Edit quotation from Example Office Supplies Ltd', level: 1 })).toBeVisible();
    await expect(dewi.getByLabel(/Unit price for line 1/)).toHaveValue('140');
    expect(await unlabeledControls(dewi)).toEqual([]);
    await dewi.getByLabel('Lead time (days)').fill('12');
    await dewi.getByRole('button', { name: 'Save changes' }).click();
    await expect(dewi.getByRole('status')).toHaveText('Quotation saved.');
    await expect(quotations).toContainText('12 days');
    await dewi.getByRole('button', { name: 'Submit the quotation from Example Office Supplies Ltd' }).click();
    await expect(dewi.getByRole('status')).toHaveText('Quotation submitted. It now counts in the comparison.');

    // The second: 2 × 150 + 3 × 85 = 555.00, the lower total; Example Office is lower on line 1.
    await recordQuotation(dewi, /Record quotation from Sample Industrial Parts Co/, ['150', '85'], '2030-05-31', '21');
    await dewi.getByRole('button', { name: /Submit the quotation from Sample Industrial Parts Co/ }).click();
    await expect(dewi.getByRole('status')).toHaveText('Quotation submitted. It now counts in the comparison.');
    const comparison = dewi.getByRole('table', { name: 'Quotation comparison' });
    await expect(comparison.getByRole('row', { name: /Total \(without tax\)/ })).toContainText('$555.00Lowest');
    await expect(comparison.getByRole('row', { name: /Monitor arm/ })).toContainText('140.00 each = $280.00Lowest on this line');
    await expect(dewi.getByText(/At least 3 valid quotations are expected/)).toBeVisible();

    await dewi.getByRole('button', { name: 'Close RFQ' }).click();
    await expect(dewi.getByRole('status')).toHaveText(/RFQ closed/);
    await expect(badge(dewi)).toHaveText('Closed');

    // Finance and the auditor see the comparison, and nothing they could change.
    for (const [persona, ip] of [
      ['sari.finance', 201],
      ['lena.auditor', 202],
    ] as const) {
      const reader = await personaPage(browser, persona, ip);
      await reader.goto(rfqPath);
      await expect(reader.getByRole('table', { name: 'Quotation comparison' })).toContainText('$565.00');
      await expect(reader.getByRole('heading', { name: 'Actions' })).toHaveCount(0);
      await expect(reader.getByRole('button', { name: 'Award RFQ' })).toHaveCount(0);
      await expect(reader.getByRole('button', { name: /Submit|Withdraw/ })).toHaveCount(0);
      await reader.goto(recordPath);
      await expect(reader.getByRole('heading', { level: 1 })).toHaveText('Record quotation');
      await expect(reader.getByText(/Quotations are recorded by procurement/)).toBeVisible();
      await expect(reader.getByRole('button', { name: 'Save draft quotation' })).toHaveCount(0);
      await reader.context().close();
    }

    // Awarding the higher quotation needs a justification; the choice is kept after the refusal.
    await dewi.reload();
    await expect(dewi.getByLabel(/Sample Industrial Parts Co.*\(lowest\)/)).toBeChecked();
    await expect(dewi.getByText('No justification is required for this choice.', { exact: false })).toHaveCount(0);
    await dewi.getByLabel(/^Example Office Supplies Ltd, \$565\.00/).check();
    await expect(dewi.getByText(/A justification is required: fewer than 3 valid quotations were received, and the chosen quotation is not the lowest valid total/)).toBeVisible();
    await dewi.getByRole('button', { name: 'Award RFQ' }).click();
    await expect(dewi.getByText(/Give a justification to award it\./)).toBeVisible();
    await expect(dewi.getByLabel(/^Example Office Supplies Ltd, \$565\.00/)).toBeChecked();
    await expect(badge(dewi)).toHaveText('Closed');
    await dewi.getByLabel(/^Justification/).fill('Faster delivery of the monitor arms; only two suppliers stock them.');
    await dewi.getByRole('button', { name: 'Award RFQ' }).click();
    await expect(dewi.getByRole('status')).toHaveText(/RFQ awarded/);
    await expect(badge(dewi)).toHaveText('Awarded');
    await expect(dewi.getByText('Example Office Supplies Ltd, $565.00')).toBeVisible();
    await expect(dewi.getByText('Faster delivery of the monitor arms; only two suppliers stock them.')).toBeVisible();
    await expect(dewi.getByRole('table', { name: 'Quotations' })).toContainText('Not awarded');
    await expect(dewi.getByRole('button', { name: 'Award RFQ' })).toHaveCount(0);

    expect(csp).toEqual([]);
    await dewi.context().close();
  });

  test('the seeded RFQ shows its comparison; quotation pages and the settings have one h1 and only labeled controls', async ({ browser }) => {
    const dewi = await personaPage(browser, 'dewi.procurement', 203);
    await dewi.goto(`/rfqs?q=${encodeURIComponent('Office chairs for Operations')}`);
    await dewi.getByRole('table', { name: 'RFQs' }).getByRole('link', { name: /RFQ-\d{4}-\d{6}/ }).first().click();
    await expect(dewi.getByRole('heading', { name: 'Office chairs for Operations', level: 1 })).toBeVisible();
    const comparison = dewi.getByRole('table', { name: 'Quotation comparison' });
    await expect(comparison.getByRole('columnheader')).toHaveCount(3); // Line + 2 suppliers
    await expect(comparison.getByRole('row', { name: /Total \(without tax\)/ })).toContainText('$816.00Lowest');
    await expect(dewi.getByText(/At least 3 valid quotations are expected.*Valid now: 2\. Awarding needs a justification\./)).toBeVisible();
    await expect(dewi.locator('h1')).toHaveCount(1);
    expect(await unlabeledControls(dewi)).toEqual([]);
    await dewi.context().close();

    const ada = await personaPage(browser, 'ada.admin', 204);
    await ada.goto('/admin/settings');
    await expect(ada.getByLabel('Minimum applies from (estimated total)')).toHaveValue('500');
    await expect(ada.getByLabel('Minimum valid quotations')).toHaveValue('3');
    await expect(ada.locator('h1')).toHaveCount(1);
    expect(await unlabeledControls(ada)).toEqual([]);
    await ada.context().close();
  });
});
