import { randomBytes } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { clientIp, e2eUser, signIn } from './support';

/*
 * What a user typed survives a server-side error (React 19 resets uncontrolled fields after
 * every form action, also a failed one, unless the form submits the action itself).
 */

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

test.describe('forms keep what was typed after a server error', () => {
  test('a requisition refused by the server keeps its title, date, and justification', async ({ browser }) => {
    const rina = await personaPage(browser, 'rina.requester', 248);
    await rina.goto('/requisitions/new');
    // The server refuses a quantity of 0: the title, date, and justification must stay.
    await rina.getByLabel('Title').fill(`Kept fields ${run}`);
    await rina.getByLabel('Needed by').fill('2030-06-30');
    await rina.getByLabel('Justification (optional)').fill('Typed once');
    await rina.locator('#line-0-description').fill('Whiteboard');
    await rina.locator('#line-0-quantity').fill('0');
    await rina.locator('#line-0-uom').fill('pcs');
    await rina.locator('#line-0-price').fill('300');
    await rina.getByRole('button', { name: 'Create draft' }).click();
    await expect(rina.getByText('Quantity must be greater than zero')).toBeVisible();
    await expect(rina.getByLabel('Title')).toHaveValue(`Kept fields ${run}`);
    await expect(rina.getByLabel('Needed by')).toHaveValue('2030-06-30');
    await expect(rina.getByLabel('Justification (optional)')).toHaveValue('Typed once');
    await rina.context().close();
  });

  test('an approver who chose Reject and forgot the comment still has Reject selected', async ({ browser }) => {
    test.setTimeout(60_000);
    const rina = await personaPage(browser, 'rina.requester', 252);
    await rina.goto('/requisitions/new');
    await rina.getByLabel('Title').fill(`Reject kept ${run}`);
    await rina.getByLabel('Needed by').fill('2030-06-30');
    await rina.locator('#line-0-description').fill('Whiteboard');
    // 2 × 300 = 600: under 1,000, so the OPS approver decides alone.
    await rina.locator('#line-0-quantity').fill('2');
    await rina.locator('#line-0-uom').fill('pcs');
    await rina.locator('#line-0-price').fill('300');
    await rina.getByRole('button', { name: 'Create draft' }).click();
    await expect(rina.getByRole('heading', { name: `Reject kept ${run}`, level: 1 })).toBeVisible();
    await rina.getByRole('button', { name: 'Submit for approval' }).click();
    await expect(rina.locator('h1 + [data-slot="badge"]')).toHaveText('Pending approval');
    const path = new URL(rina.url()).pathname;
    await rina.context().close();

    const bayu = await personaPage(browser, 'bayu.approver', 249);
    await bayu.goto(path);
    await bayu.getByLabel('Reject', { exact: true }).check();
    await bayu.getByRole('button', { name: 'Record decision' }).click();
    await expect(bayu.getByText('Explain why you reject it (required)')).toBeVisible();
    await expect(bayu.getByLabel('Reject', { exact: true })).toBeChecked();
    await bayu.getByLabel('Comment (required to reject or return)').fill('Not in this quarter');
    await bayu.getByRole('button', { name: 'Record decision' }).click();
    await expect(bayu.getByRole('status')).toHaveText('Requisition rejected.');
    await expect(bayu.locator('h1 + [data-slot="badge"]')).toHaveText('Rejected');
    await bayu.context().close();
  });

  test('supplier, user, department, and settings forms keep their fields; creating a department clears only on success', async ({ browser }) => {
    const dewi = await personaPage(browser, 'dewi.procurement', 250);
    await dewi.goto('/suppliers/new');
    await dewi.getByLabel('Legal name').fill(`Kept Supplier ${run}`);
    await dewi.getByLabel(/Tax ID/).fill('X');
    await dewi.getByLabel(/City/).fill('Springfield');
    await dewi.getByRole('button', { name: /Register supplier|Create supplier|Save/ }).click();
    await expect(dewi.getByText('A tax ID has 5 to 30 letters or digits')).toBeVisible();
    await expect(dewi.getByLabel('Legal name')).toHaveValue(`Kept Supplier ${run}`);
    await expect(dewi.getByLabel(/City/)).toHaveValue('Springfield');
    await dewi.context().close();

    const ada = await personaPage(browser, 'ada.admin', 251);
    await ada.goto('/admin/users/new');
    await ada.getByLabel('Name', { exact: true }).fill(`Kept User ${run}`);
    await ada.getByLabel('Email').fill('not-an-email');
    await ada.getByRole('checkbox', { name: 'Requester' }).check();
    await ada.getByRole('button', { name: /Create user/ }).click();
    await expect(ada.locator('form').getByRole('alert').first()).toBeVisible();
    await expect(ada.getByLabel('Name', { exact: true })).toHaveValue(`Kept User ${run}`);
    await expect(ada.getByRole('checkbox', { name: 'Requester' })).toBeChecked();

    await ada.goto('/admin/departments');
    await ada.getByLabel('Code').fill('OPS');
    await ada.getByLabel('Name', { exact: true }).fill(`Kept department ${run}`);
    await ada.getByRole('button', { name: 'Create department' }).click();
    await expect(ada.getByText(/already/i).first()).toBeVisible();
    await expect(ada.getByLabel('Name', { exact: true })).toHaveValue(`Kept department ${run}`);
    const code = `K${run.slice(0, 5).toUpperCase()}`;
    await ada.getByLabel('Code').fill(code);
    await ada.getByRole('button', { name: 'Create department' }).click();
    await expect(ada.getByText('Department created.')).toBeVisible();
    await expect(ada.getByLabel('Code')).toHaveValue('');
    await expect(ada.getByLabel('Name', { exact: true })).toHaveValue('');

    await ada.goto('/admin/settings');
    await ada.getByLabel('Time zone').selectOption('Europe/Berlin');
    await ada.getByLabel('Organization name').fill('');
    await ada.getByRole('button', { name: 'Save settings' }).click();
    await expect(ada.locator('form').getByRole('alert').first()).toBeVisible();
    await expect(ada.getByLabel('Time zone')).toHaveValue('Europe/Berlin');
    await ada.context().close();
  });
});
