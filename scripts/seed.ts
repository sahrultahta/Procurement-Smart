/**
 * Fictional demo data (ADR 0001): three departments, one user per role, all @example.com; three
 * suppliers registered by Dewi (procurement), two of them approved by Sari (finance); the organization
 * name, a default approval policy published by Ada (admin), one draft requisition by Rina, one she
 * submitted, waiting for Bayu (step 1) and then Sari (step 2), and one Bayu approved, with an RFQ
 * Dewi issued to the two approved suppliers. All of it goes through the real commands.
 * Idempotent: existing data is left as it is.
 *
 *   npm run seed                                   create missing demo users
 *   npm run seed -- --reset-passwords              also give existing seed users new passwords
 *   npm run seed -- --prefix e2e --out .local/e2e-credentials.json --reset-passwords
 *                                                  separate users for end-to-end tests
 *
 * Passwords are random and written to a gitignored JSON file under .local/ (never printed).
 * Refuses to run with NODE_ENV=production.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const root = resolve(import.meta.dirname, '..');
const envFile = resolve(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo data with NODE_ENV=production.');
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    prefix: { type: 'string', default: '' },
    out: { type: 'string', default: '.local/seed-credentials.json' },
    'reset-passwords': { type: 'boolean', default: false },
  },
});
const prefix = values.prefix ? `${values.prefix}.` : '';
const outFile = resolve(root, values.out);
if (!outFile.startsWith(resolve(root, '.local'))) {
  console.error('--out must point inside .local/ (gitignored).');
  process.exit(1);
}

const { provisionUser, provisionUserInput } = await import('@/modules/identity');
const { ensureDepartment, findUserIdByEmail } = await import('@/modules/identity/infrastructure/identity-repository');
const { recordAuditEvent } = await import('@/modules/audit');
const { createRequestContext } = await import('@/shared/application/context');
const { closeDb, getDb } = await import('@/shared/db/client');
const { getAuth, issuePasswordSetupToken } = await import('@/server/auth');
const { resolveActor } = await import('@/modules/identity');
const { createSupplier, reviewSupplier } = await import('@/modules/suppliers');
const { runCommand, runQuery } = await import('@/shared/application/runner');
const { getActiveApprovalPolicy, getSettings, publishApprovalPolicy, updateOrganizationSettings } = await import('@/modules/organization');
const { createRequisition, getRequisition, listRequisitions, submitRequisition } = await import('@/modules/requisitions');
const { awardQuotation, closeRfq, createRfq, getRfq, issueRfq, listRfqs, recordQuotation, rfqSourcingOptions, submitQuotation } = await import('@/modules/sourcing');
const { decideApproval } = await import('@/server/approvals');

type SeedUser = { email: string; name: string; departmentCode: string | null; roles: { role: string; departmentCode: string | null }[] };

const DEPARTMENTS = [
  { code: 'OPS', name: 'Operations' },
  { code: 'FIN', name: 'Finance' },
  { code: 'WH', name: 'Warehouse' },
];

// Fictional people (docs/user-stories.md personas).
const USERS: SeedUser[] = [
  { email: 'ada.admin', name: 'Ada Admin', departmentCode: null, roles: [{ role: 'admin', departmentCode: null }] },
  { email: 'rina.requester', name: 'Rina Requester', departmentCode: 'OPS', roles: [{ role: 'requester', departmentCode: null }] },
  { email: 'bayu.approver', name: 'Bayu Approver', departmentCode: 'OPS', roles: [{ role: 'approver', departmentCode: 'OPS' }] },
  { email: 'dewi.procurement', name: 'Dewi Procurement', departmentCode: 'OPS', roles: [{ role: 'procurement', departmentCode: null }] },
  { email: 'agus.receiver', name: 'Agus Receiver', departmentCode: 'WH', roles: [{ role: 'receiver', departmentCode: null }] },
  { email: 'sari.finance', name: 'Sari Finance', departmentCode: 'FIN', roles: [{ role: 'finance', departmentCode: null }] },
  { email: 'lena.auditor', name: 'Lena Auditor', departmentCode: null, roles: [{ role: 'auditor', departmentCode: null }] },
];

// Fictional suppliers: example.com contacts, 555-01xx phone numbers, made-up tax IDs.
const SUPPLIERS = [
  { legalName: 'Example Office Supplies Ltd', taxId: 'EX-1000-0001', email: 'orders.office@example.com', phone: '+1 555 0101', addressLine1: '100 Example Avenue', city: 'Springfield', postalCode: '00001', approve: true },
  { legalName: 'Sample Industrial Parts Co.', taxId: 'EX-1000-0002', email: 'sales.parts@example.com', phone: '+1 555 0102', addressLine1: '200 Sample Road', city: 'Riverton', postalCode: '00002', approve: true },
  { legalName: 'Demo Facility Services LLC', taxId: 'EX-1000-0003', email: 'hello.facilities@example.com', phone: '+1 555 0103', addressLine1: '300 Demo Street', city: 'Lakeside', postalCode: '00003', approve: false },
];

const credentials: Record<string, { name: string; password: string; roles: string[] }> = {};
const summary = {
  departmentsCreated: 0,
  usersCreated: 0,
  usersSkipped: 0,
  passwordsSet: 0,
  suppliersCreated: 0,
  suppliersSkipped: 0,
  settingsUpdated: 0,
  policiesPublished: 0,
  requisitionsCreated: 0,
  rfqsCreated: 0,
  quotationsCreated: 0,
  awards: 0,
};

// Fictional quotations for the demo RFQ (by supplier name): Sample Industrial Parts is lower in
// total, Example Office Supplies on the chair mats. Prices exclude tax.
const QUOTATIONS = [
  { legalName: 'Example Office Supplies Ltd', supplierReference: 'EOS-Q-2030-017', validUntil: '2030-06-30', leadTimeDays: 14, prices: ['175.00', '32.00'] },
  { legalName: 'Sample Industrial Parts Co.', supplierReference: 'SIP-7741', validUntil: '2030-05-31', leadTimeDays: 21, prices: ['168.00', '36.00'] },
];

try {
  const db = getDb();
  const auth = getAuth();
  const system = createRequestContext({ actor: null });

  await db.transaction(async (tx) => {
    for (const department of DEPARTMENTS) {
      const { id, created } = await ensureDepartment(tx, department.code, department.name);
      if (created) {
        summary.departmentsCreated++;
        await recordAuditEvent(tx, system, {
          action: 'department.created',
          entityType: 'department',
          entityId: id,
          changes: { code: [null, department.code], name: [null, department.name] },
          reason: 'seed',
        });
      }
    }
  });

  for (const user of USERS) {
    const email = `${prefix}${user.email}@example.com`;
    const exists = (await findUserIdByEmail(db, email)) !== null;
    if (exists) summary.usersSkipped++;
    else {
      const input = provisionUserInput.parse({ ...user, email });
      await db.transaction((tx) => provisionUser(tx, system, input, 'system:seed'));
      summary.usersCreated++;
    }
    if (!exists || values['reset-passwords']) {
      const password = randomBytes(15).toString('base64url'); // 20 characters
      const token = await issuePasswordSetupToken(auth, email);
      if (!token) throw new Error(`No setup token for ${email}`);
      await auth.api.resetPassword({ body: { newPassword: password, token } });
      credentials[email] = { name: user.name, password, roles: user.roles.map((r) => r.role) };
      summary.passwordsSet++;
    }
  }

  // Suppliers go through the commands, so maker-checker and the audit trail apply as usual.
  const actorOf = async (persona: string) => {
    const userId = await findUserIdByEmail(db, `${prefix}${persona}@example.com`);
    const actor = userId ? await resolveActor(db, userId) : null;
    if (!actor) throw new Error(`Seed user ${persona} is missing or inactive`);
    return createRequestContext({ actor });
  };
  const maker = await actorOf('dewi.procurement');
  const checker = await actorOf('sari.finance');
  for (const { approve, ...supplier } of SUPPLIERS) {
    const created = await runCommand(maker, createSupplier, { addressLine2: null, region: null, countryCode: 'US', ...supplier });
    if (!created.ok) {
      if (created.error.rule !== 'SUPPLIER_DUPLICATE') throw new Error(`Seeding ${supplier.legalName} failed: ${created.error.message}`);
      summary.suppliersSkipped++;
      continue;
    }
    summary.suppliersCreated++;
    if (approve) {
      const reviewed = await runCommand(checker, reviewSupplier, {
        supplierId: created.data.supplierId,
        expectedVersion: 1,
        decision: 'approve',
        note: 'Seed data: fictional supplier',
      });
      if (!reviewed.ok) throw new Error(`Approving ${supplier.legalName} failed: ${reviewed.error.message}`);
    }
  }

  // Organization name (USD scale 2 stays, decision D3), the award rule (from 500, 3 valid
  // quotations), the purchase-order rule (approval from 1,000, 5 % price tolerance, no
  // over-receipt), and the default approval policies, as Ada. A missing threshold is set again.
  const admin = await actorOf('ada.admin');
  const settings = await runQuery(admin, getSettings, {});
  if (!settings.ok) throw new Error(`Reading settings failed: ${settings.error.message}`);
  const poRuleMissing = settings.data.poApprovalThreshold === null;
  if (settings.data.orgName === 'My organization' || settings.data.rfqRequiredAbove === null || poRuleMissing) {
    const updated = await runCommand(admin, updateOrganizationSettings, {
      orgName: settings.data.orgName === 'My organization' ? 'Example Organization' : settings.data.orgName,
      timezone: settings.data.timezone,
      currencyCode: settings.data.currencyCode,
      currencyScale: settings.data.currencyScale,
      rfqRequiredAbove: settings.data.rfqRequiredAbove ?? '500',
      minQuotes: settings.data.minQuotes,
      poApprovalThreshold: settings.data.poApprovalThreshold ?? '1000',
      poPriceTolerancePct: poRuleMissing ? '5' : settings.data.poPriceTolerancePct,
      overReceiptTolerancePct: settings.data.overReceiptTolerancePct,
      expectedVersion: settings.data.version,
    });
    if (!updated.ok) throw new Error(`Updating settings failed: ${updated.error.message}`);
    summary.settingsUpdated++;
  }
  const active = await runQuery(admin, getActiveApprovalPolicy, { documentType: 'requisition' });
  if (!active.ok) throw new Error(`Reading the approval policy failed: ${active.error.message}`);
  if (active.data === null) {
    const published = await runCommand(admin, publishApprovalPolicy, {
      documentType: 'requisition',
      name: 'Standard approvals',
      rules: [
        { departmentCode: null, minAmount: '0', maxAmount: '1000', steps: [{ role: 'approver', scopeMode: 'document_department' }] },
        {
          departmentCode: null,
          minAmount: '1000',
          maxAmount: null,
          steps: [
            { role: 'approver', scopeMode: 'document_department' },
            { role: 'finance', scopeMode: 'organization' },
          ],
        },
      ],
    });
    if (!published.ok) throw new Error(`Publishing the approval policy failed: ${published.error.message}`);
    summary.policiesPublished++;
  }
  // Purchase orders that need approval: finance under 5,000; from 5,000 the department approver first.
  const activePo = await runQuery(admin, getActiveApprovalPolicy, { documentType: 'purchase_order' });
  if (!activePo.ok) throw new Error(`Reading the purchase-order approval policy failed: ${activePo.error.message}`);
  if (activePo.data === null) {
    const published = await runCommand(admin, publishApprovalPolicy, {
      documentType: 'purchase_order',
      name: 'Standard purchase-order approvals',
      rules: [
        { departmentCode: null, minAmount: '0', maxAmount: '5000', steps: [{ role: 'finance', scopeMode: 'organization' }] },
        {
          departmentCode: null,
          minAmount: '5000',
          maxAmount: null,
          steps: [
            { role: 'approver', scopeMode: 'document_department' },
            { role: 'finance', scopeMode: 'organization' },
          ],
        },
      ],
    });
    if (!published.ok) throw new Error(`Publishing the purchase-order approval policy failed: ${published.error.message}`);
    summary.policiesPublished++;
  }

  // One draft requisition for Rina, unless she already has it.
  const requester = await actorOf('rina.requester');
  const existing = await runQuery(requester, listRequisitions, { q: 'Printer paper and toner for Operations' });
  if (!existing.ok) throw new Error(`Listing requisitions failed: ${existing.error.message}`);
  if (existing.data.items.length === 0) {
    const draft = await runCommand(requester, createRequisition, {
      title: 'Printer paper and toner for Operations',
      justification: 'Fictional demo requisition (seed data).',
      neededBy: '2030-01-31',
      lines: [
        { description: 'A4 printer paper, 80 g/m²', quantity: '20', uom: 'ream', estimatedUnitPrice: '4.25' },
        { description: 'Black toner cartridge', quantity: '2', uom: 'pcs', estimatedUnitPrice: '89.90' },
      ],
    });
    if (!draft.ok) throw new Error(`Creating the demo requisition failed: ${draft.error.message}`);
    summary.requisitionsCreated++;
  }

  // And one submitted for approval (from 1,000: Bayu for OPS, then Sari for finance).
  const submittedTitle = 'Laptop docking stations for Operations';
  const existingSubmitted = await runQuery(requester, listRequisitions, { q: submittedTitle });
  if (!existingSubmitted.ok) throw new Error(`Listing requisitions failed: ${existingSubmitted.error.message}`);
  if (existingSubmitted.data.items.length === 0) {
    const created = await runCommand(requester, createRequisition, {
      title: submittedTitle,
      justification: 'Fictional demo requisition (seed data), waiting for approval.',
      neededBy: '2030-03-31',
      lines: [{ description: 'USB-C docking station', quantity: '6', uom: 'pcs', estimatedUnitPrice: '189.00' }],
    });
    if (!created.ok) throw new Error(`Creating the submitted demo requisition failed: ${created.error.message}`);
    const submitted = await runCommand(requester, submitRequisition, { requisitionId: created.data.requisitionId, expectedVersion: created.data.version });
    if (!submitted.ok) throw new Error(`Submitting the demo requisition failed: ${submitted.error.message}`);
    summary.requisitionsCreated++;
  }

  // One approved by Bayu (under 1,000: one step), sourced by Dewi with an issued RFQ.
  const sourcedTitle = 'Office chairs for Operations';
  const existingSourced = await runQuery(requester, listRequisitions, { q: sourcedTitle });
  if (!existingSourced.ok) throw new Error(`Listing requisitions failed: ${existingSourced.error.message}`);
  let sourcedId = existingSourced.data.items[0]?.id ?? null;
  if (!sourcedId) {
    const created = await runCommand(requester, createRequisition, {
      title: sourcedTitle,
      justification: 'Fictional demo requisition (seed data), approved and out for quotation.',
      neededBy: '2030-04-30',
      lines: [
        { description: 'Ergonomic office chair', quantity: '4', uom: 'pcs', estimatedUnitPrice: '180.00' },
        { description: 'Chair mat', quantity: '4', uom: 'pcs', estimatedUnitPrice: '35.00' },
      ],
    });
    if (!created.ok) throw new Error(`Creating the sourced demo requisition failed: ${created.error.message}`);
    const submitted = await runCommand(requester, submitRequisition, { requisitionId: created.data.requisitionId, expectedVersion: created.data.version });
    if (!submitted.ok) throw new Error(`Submitting the sourced demo requisition failed: ${submitted.error.message}`);
    const approved = await runCommand(await actorOf('bayu.approver'), decideApproval, {
      approvalRequestId: submitted.data.approvalRequestId,
      stepNo: 1,
      expectedVersion: 1,
      decision: 'approve',
      comment: 'Seed data: approved for the demo',
    });
    if (!approved.ok) throw new Error(`Approving the sourced demo requisition failed: ${approved.error.message}`);
    sourcedId = created.data.requisitionId;
    summary.requisitionsCreated++;
  }
  const buyer = await actorOf('dewi.procurement');
  const existingRfqs = await runQuery(buyer, listRfqs, { requisitionId: sourcedId });
  if (!existingRfqs.ok) throw new Error(`Listing RFQs failed: ${existingRfqs.error.message}`);
  if (existingRfqs.data.items.length === 0) {
    const options = await runQuery(buyer, rfqSourcingOptions, { requisitionId: sourcedId });
    if (!options.ok) throw new Error(`Reading RFQ options failed: ${options.error.message}`);
    const rfq = await runCommand(buyer, createRfq, {
      requisitionId: sourcedId,
      title: sourcedTitle,
      responseDueAt: '2030-03-15T17:00',
      lines: options.data.lines.map((l) => ({ requisitionLineId: l.id, quantity: l.remainingQty })),
      supplierIds: options.data.suppliers.map((s) => s.id),
    });
    if (!rfq.ok) throw new Error(`Creating the demo RFQ failed: ${rfq.error.message}`);
    const issued = await runCommand(buyer, issueRfq, { rfqId: rfq.data.rfqId, expectedVersion: rfq.data.version });
    if (!issued.ok) throw new Error(`Issuing the demo RFQ failed: ${issued.error.message}`);
    summary.rfqsCreated++;
  }

  // Two quotations Dewi recorded and submitted on that RFQ, which stays issued for the demo.
  const sourced = await runQuery(buyer, listRfqs, { requisitionId: sourcedId });
  if (!sourced.ok) throw new Error(`Listing RFQs failed: ${sourced.error.message}`);
  const demoRfqId = sourced.data.items[0]?.id;
  const demo = demoRfqId ? await runQuery(buyer, getRfq, { rfqId: demoRfqId }) : null;
  if (demo && !demo.ok) throw new Error(`Reading the demo RFQ failed: ${demo.error.message}`);
  if (demo?.ok && demo.data.status === 'issued' && demo.data.quotations.length === 0) {
    for (const quotation of QUOTATIONS) {
      const supplier = demo.data.suppliers.find((s) => s.legalName === quotation.legalName);
      if (!supplier) throw new Error(`${quotation.legalName} is not invited to the demo RFQ`);
      const recorded = await runCommand(buyer, recordQuotation, {
        rfqId: demo.data.id,
        supplierId: supplier.id,
        supplierReference: quotation.supplierReference,
        validUntil: quotation.validUntil,
        leadTimeDays: quotation.leadTimeDays,
        lines: demo.data.lines.map((l, i) => ({ rfqLineId: l.id, unitPrice: quotation.prices[i] ?? '0' })),
      });
      if (!recorded.ok) throw new Error(`Recording the quotation from ${quotation.legalName} failed: ${recorded.error.message}`);
      const submitted = await runCommand(buyer, submitQuotation, { quotationId: recorded.data.quotationId, expectedVersion: recorded.data.version });
      if (!submitted.ok) throw new Error(`Submitting the quotation from ${quotation.legalName} failed: ${submitted.error.message}`);
      summary.quotationsCreated++;
    }
  }

  // Phase 7 demo data. An approved requisition under the RFQ threshold, ready for a direct purchase
  // order, and one above it whose RFQ is awarded, ready for a purchase order from the award. Each
  // open approval step is decided by Bayu (OPS), then Sari (finance), so a second run finishes a
  // requisition an earlier, interrupted run left waiting.
  const approvedRequisition = async (title: string, justification: string, lines: { description: string; quantity: string; uom: string; estimatedUnitPrice: string }[]) => {
    const found = await runQuery(requester, listRequisitions, { q: title });
    if (!found.ok) throw new Error(`Listing requisitions failed: ${found.error.message}`);
    let id = found.data.items[0]?.id;
    if (!id) {
      const created = await runCommand(requester, createRequisition, { title, justification, neededBy: '2030-05-31', lines });
      if (!created.ok) throw new Error(`Creating "${title}" failed: ${created.error.message}`);
      const submitted = await runCommand(requester, submitRequisition, { requisitionId: created.data.requisitionId, expectedVersion: created.data.version });
      if (!submitted.ok) throw new Error(`Submitting "${title}" failed: ${submitted.error.message}`);
      id = created.data.requisitionId;
      summary.requisitionsCreated++;
    }
    for (const persona of ['bayu.approver', 'sari.finance']) {
      const approver = await actorOf(persona);
      const detail = await runQuery(approver, getRequisition, { requisitionId: id });
      if (!detail.ok) throw new Error(`Reading "${title}" failed: ${detail.error.message}`);
      const open = detail.data.openDecision;
      if (!open) continue;
      const decided = await runCommand(approver, decideApproval, {
        approvalRequestId: open.approvalRequestId,
        stepNo: open.stepNo,
        expectedVersion: open.requestVersion,
        decision: 'approve',
        comment: 'Seed data: approved for the demo',
      });
      if (!decided.ok) throw new Error(`Approving "${title}" failed: ${decided.error.message}`);
    }
    return { id };
  };
  await approvedRequisition('Cleaning supplies for Operations', 'Fictional demo requisition (seed data), approved and ready to order.', [
    { description: 'Floor cleaner, 5 l', quantity: '10', uom: 'can', estimatedUnitPrice: '8.50' },
    { description: 'Microfibre cloth, pack of 10', quantity: '6', uom: 'pack', estimatedUnitPrice: '12.00' },
  ]);
  const desks = await approvedRequisition('Standing desks for Operations', 'Fictional demo requisition (seed data), sourced and awarded.', [
    { description: 'Electric standing desk', quantity: '2', uom: 'pcs', estimatedUnitPrice: '650.00' },
  ]);
  const deskRfqs = await runQuery(buyer, listRfqs, { requisitionId: desks.id });
  if (!deskRfqs.ok) throw new Error(`Listing RFQs failed: ${deskRfqs.error.message}`);
  if (deskRfqs.data.items.length === 0) {
    const options = await runQuery(buyer, rfqSourcingOptions, { requisitionId: desks.id });
    if (!options.ok) throw new Error(`Reading RFQ options failed: ${options.error.message}`);
    const rfq = await runCommand(buyer, createRfq, {
      requisitionId: desks.id,
      title: 'Standing desks for Operations',
      responseDueAt: '2030-03-15T17:00',
      lines: options.data.lines.map((l) => ({ requisitionLineId: l.id, quantity: l.remainingQty })),
      supplierIds: options.data.suppliers.map((s) => s.id),
    });
    if (!rfq.ok) throw new Error(`Creating the desk RFQ failed: ${rfq.error.message}`);
    const issued = await runCommand(buyer, issueRfq, { rfqId: rfq.data.rfqId, expectedVersion: rfq.data.version });
    if (!issued.ok) throw new Error(`Issuing the desk RFQ failed: ${issued.error.message}`);
    summary.rfqsCreated++;
    const detail = await runQuery(buyer, getRfq, { rfqId: rfq.data.rfqId });
    if (!detail.ok) throw new Error(`Reading the desk RFQ failed: ${detail.error.message}`);
    const deskQuotes = [
      { legalName: 'Example Office Supplies Ltd', supplierReference: 'EOS-Q-2030-031', price: '640.00' },
      { legalName: 'Sample Industrial Parts Co.', supplierReference: 'SIP-7790', price: '655.00' },
    ];
    let lowest = '';
    for (const quotation of deskQuotes) {
      const supplier = detail.data.suppliers.find((s) => s.legalName === quotation.legalName);
      if (!supplier) throw new Error(`${quotation.legalName} is not invited to the desk RFQ`);
      const recorded = await runCommand(buyer, recordQuotation, {
        rfqId: detail.data.id,
        supplierId: supplier.id,
        supplierReference: quotation.supplierReference,
        validUntil: '2030-06-30',
        leadTimeDays: 21,
        lines: detail.data.lines.map((l) => ({ rfqLineId: l.id, unitPrice: quotation.price })),
      });
      if (!recorded.ok) throw new Error(`Recording the desk quotation from ${quotation.legalName} failed: ${recorded.error.message}`);
      const submitted = await runCommand(buyer, submitQuotation, { quotationId: recorded.data.quotationId, expectedVersion: recorded.data.version });
      if (!submitted.ok) throw new Error(`Submitting the desk quotation from ${quotation.legalName} failed: ${submitted.error.message}`);
      if (!lowest) lowest = recorded.data.quotationId;
      summary.quotationsCreated++;
    }
    const closed = await runCommand(buyer, closeRfq, { rfqId: detail.data.id, expectedVersion: issued.data.version });
    if (!closed.ok) throw new Error(`Closing the desk RFQ failed: ${closed.error.message}`);
    const awarded = await runCommand(buyer, awardQuotation, {
      rfqId: detail.data.id,
      quotationId: lowest,
      expectedVersion: closed.data.version,
      justification: 'Seed data: only two suppliers carry this desk model.',
    });
    if (!awarded.ok) throw new Error(`Awarding the desk RFQ failed: ${awarded.error.message}`);
    summary.awards++;
  }

  if (Object.keys(credentials).length > 0) {
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  }
  console.log(
    `Seed done: ${summary.departmentsCreated} departments created, ${summary.usersCreated} users created, ` +
      `${summary.usersSkipped} existing users skipped, ${summary.passwordsSet} passwords set, ` +
      `${summary.suppliersCreated} suppliers created, ${summary.suppliersSkipped} existing suppliers skipped, ` +
      `${summary.settingsUpdated} settings updated, ${summary.policiesPublished} policies published, ${summary.requisitionsCreated} requisitions created, ${summary.rfqsCreated} RFQs created, ${summary.quotationsCreated} quotations created, ${summary.awards} RFQs awarded.`,
  );
  if (summary.passwordsSet > 0) console.log(`Sign-in credentials for the users above: ${outFile}`);
} finally {
  await closeDb();
}
