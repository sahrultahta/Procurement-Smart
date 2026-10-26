import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publishApprovalPolicy } from '@/modules/organization';
import { cancelRequisition, createRequisition, submitRequisition } from '@/modules/requisitions';
import {
  AWARD_KEYS,
  COMPARISON_KEYS,
  QUOTATION_KEYS,
  QUOTATION_LINE_KEYS,
  awardQuotation,
  cancelRfq,
  closeRfq,
  createRfq,
  getRfq,
  issueRfq,
  recordQuotation,
  submitQuotation,
  updateQuotationDraft,
  withdrawQuotation,
} from '@/modules/sourcing';
import { blockSupplier, createSupplier, reviewSupplier } from '@/modules/suppliers';
import { decideApproval } from '@/server/approvals';
import { fixedClock, type Clock } from '@/shared/clock';
import { runCommand, runQuery, type Operation } from '@/shared/application/runner';
import type { Result } from '@/shared/result';
import { contextOf, provisionActor } from '../support/actors';
import { createTestDatabase, sqlStateOf, type TestDatabase } from '../support/test-db';

/* Phase 6b: quotations, the comparison, and the award, as the runtime role through the command runner. */

let t: TestDatabase;
type Persona = 'rina' | 'bayu' | 'dewi' | 'fajar' | 'sari' | 'lena' | 'ada' | 'agus';
const u = {} as Record<Persona, string>;
const s = {} as Record<'office' | 'parts' | 'cleaning' | 'pending', string>;
let supplierCount = 0;

async function run<I, O>(as: string, op: Operation<I, O>, input: unknown, clock?: Clock): Promise<Result<O>> {
  const context = await contextOf(t.appDb, as);
  const options = { db: t.appDb, ...(clock ? { clock } : {}) };
  return op.kind === 'command' ? runCommand(context, op, input, options) : runQuery(context, op, input, options);
}

function data<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.data;
}

const rule = (result: Result<unknown>) => (result.ok ? 'ok' : (result.error.rule ?? result.error.code));

/** A new approved supplier (each block test gets its own, so the shared ones stay active). */
async function newSupplier(legalName: string, approve = true): Promise<string> {
  supplierCount++;
  const created = data(
    await run(u.dewi, createSupplier, {
      legalName,
      taxId: `EX-3000-${String(supplierCount).padStart(4, '0')}`,
      email: null,
      phone: null,
      addressLine1: null,
      addressLine2: null,
      city: null,
      region: null,
      postalCode: null,
      countryCode: 'US',
    }),
  );
  if (approve) data(await run(u.sari, reviewSupplier, { supplierId: created.supplierId, expectedVersion: 1, decision: 'approve', note: null }));
  return created.supplierId;
}

async function block(supplierId: string): Promise<void> {
  const { version } = (await t.pool.query('SELECT version FROM suppliers WHERE id = $1', [supplierId])).rows[0];
  data(await run(u.sari, blockSupplier, { supplierId, expectedVersion: version, reason: 'Failed a quality audit' }));
}

beforeAll(async () => {
  t = await createTestDatabase();
  await t.pool.query("INSERT INTO departments (code, name) VALUES ('OPS', 'Operations')");
  u.rina = await provisionActor(t.appDb, 'rina@example.com', 'Rina Requester', ['requester'], { departmentCode: 'OPS' });
  u.bayu = await provisionActor(t.appDb, 'bayu@example.com', 'Bayu Approver', [{ role: 'approver', departmentCode: 'OPS' }], { departmentCode: 'OPS' });
  u.dewi = await provisionActor(t.appDb, 'dewi@example.com', 'Dewi Procurement', ['procurement']);
  u.fajar = await provisionActor(t.appDb, 'fajar@example.com', 'Fajar Procurement', ['procurement']);
  u.sari = await provisionActor(t.appDb, 'sari@example.com', 'Sari Finance', ['finance']);
  u.lena = await provisionActor(t.appDb, 'lena@example.com', 'Lena Auditor', ['auditor']);
  u.ada = await provisionActor(t.appDb, 'ada@example.com', 'Ada Admin', ['admin']);
  u.agus = await provisionActor(t.appDb, 'agus@example.com', 'Agus Receiver', ['receiver']);
  s.office = await newSupplier('Example Office Supplies Ltd');
  s.parts = await newSupplier('Sample Industrial Parts Co');
  s.cleaning = await newSupplier('Demo Cleaning Services');
  s.pending = await newSupplier('Pending Review Trading', false);
  data(
    await run(u.ada, publishApprovalPolicy, {
      documentType: 'requisition',
      name: 'One step',
      rules: [{ departmentCode: null, minAmount: '0', maxAmount: null, steps: [{ role: 'approver', scopeMode: 'document_department' }] }],
    }),
  );
});

afterAll(async () => {
  await t?.drop();
});

// Estimated total 302.30: 20 × 4.25 + 2 × 89.90 + 5 × 7.5.
const LINES = [
  { description: 'A4 paper', quantity: '20', uom: 'ream', estimatedUnitPrice: '4.25' },
  { description: 'Toner cartridge', quantity: '2', uom: 'pcs', estimatedUnitPrice: '89.90' },
  { description: 'Stapler', quantity: '5', uom: 'pcs', estimatedUnitPrice: '7.5' },
];

async function approvedRequisition(): Promise<{ requisitionId: string; lineIds: string[] }> {
  const created = data(await run(u.rina, createRequisition, { title: 'Office supplies', justification: null, neededBy: '2030-06-30', lines: LINES }));
  const submitted = data(await run(u.rina, submitRequisition, { requisitionId: created.requisitionId, expectedVersion: 1 }));
  data(await run(u.bayu, decideApproval, { approvalRequestId: submitted.approvalRequestId, stepNo: 1, expectedVersion: 1, decision: 'approve' }));
  const lineIds = (await t.pool.query('SELECT id FROM requisition_lines WHERE requisition_id = $1 ORDER BY line_no', [created.requisitionId])).rows.map((r) => r.id as string);
  return { requisitionId: created.requisitionId, lineIds };
}

type Rfq = { rfqId: string; number: string; requisitionId: string; lines: string[] };

/** An RFQ for 20 ream of paper and 1.5 toner cartridges, due 2030-03-15 17:00 UTC; issued unless asked otherwise. */
async function rfqFor(supplierIds: string[] = [s.office, s.parts, s.cleaning], issue = true): Promise<Rfq> {
  const pr = await approvedRequisition();
  const created = data(
    await run(u.dewi, createRfq, {
      requisitionId: pr.requisitionId,
      title: 'Quoted supplies',
      responseDueAt: '2030-03-15T17:00',
      lines: [
        { requisitionLineId: pr.lineIds[0], quantity: '20' },
        { requisitionLineId: pr.lineIds[1], quantity: '1.5' },
      ],
      supplierIds,
    }),
  );
  if (issue) data(await run(u.dewi, issueRfq, { rfqId: created.rfqId, expectedVersion: 1 }));
  const detail = data(await run(u.dewi, getRfq, { rfqId: created.rfqId }));
  return { rfqId: created.rfqId, number: created.number, requisitionId: pr.requisitionId, lines: detail.lines.map((l) => l.id) };
}

const quoteInput = (rfq: Rfq, supplierId: string, prices: [string, string], overrides: Record<string, unknown> = {}) => ({
  rfqId: rfq.rfqId,
  supplierId,
  supplierReference: null,
  validUntil: '2030-03-31',
  leadTimeDays: 10,
  lines: rfq.lines.map((rfqLineId, i) => ({ rfqLineId, unitPrice: prices[i] })),
  ...overrides,
});

const priceLines = (rfq: Rfq, prices: [string, string]) => rfq.lines.map((rfqLineId, i) => ({ rfqLineId, unitPrice: prices[i] }));

async function recorded(rfq: Rfq, supplierId: string, prices: [string, string], overrides: Record<string, unknown> = {}): Promise<string> {
  return data(await run(u.dewi, recordQuotation, quoteInput(rfq, supplierId, prices, overrides))).quotationId;
}

async function submitted(rfq: Rfq, supplierId: string, prices: [string, string], overrides: Record<string, unknown> = {}, clock?: Clock): Promise<string> {
  const quotationId = await recorded(rfq, supplierId, prices, overrides);
  data(await run(u.dewi, submitQuotation, { quotationId, expectedVersion: 1 }, clock));
  return quotationId;
}

const get = async (as: string, rfqId: string, clock?: Clock) => data(await run(as, getRfq, { rfqId }, clock));
const quotationOf = async (rfqId: string, quotationId: string) => {
  const found = (await get(u.dewi, rfqId)).quotations.find((q) => q.id === quotationId);
  if (!found) throw new Error(`quotation ${quotationId} not on RFQ ${rfqId}`);
  return found;
};
const versionOf = async (rfqId: string) => (await get(u.dewi, rfqId)).version;
async function close(rfq: Rfq): Promise<number> {
  return data(await run(u.dewi, closeRfq, { rfqId: rfq.rfqId, expectedVersion: await versionOf(rfq.rfqId) })).version;
}
const award = async (rfq: Rfq, quotationId: string, justification?: string, as = u.dewi, clock?: Clock) =>
  run(as, awardQuotation, { rfqId: rfq.rfqId, quotationId, expectedVersion: await versionOf(rfq.rfqId), ...(justification === undefined ? {} : { justification }) }, clock);
const auditOf = async (entityId: string) =>
  (await t.pool.query('SELECT action, actor_user_id AS actor, changes, reason FROM audit_events WHERE entity_id = $1 ORDER BY id', [entityId])).rows;
const quotationCount = async () => (await t.pool.query('SELECT count(*)::int AS n FROM quotations')).rows[0].n as number;
async function setRule(threshold: string | null, minQuotes: number): Promise<void> {
  await t.pool.query('UPDATE org_settings SET rfq_required_above = $1, min_quotes = $2', [threshold, minQuotes]);
}

// Prices for the two RFQ lines (20 ream, 1.5 pcs) and the totals the server must compute.
const OFFICE: [string, string] = ['4.10', '85']; // 82.00 + 127.50 = 209.50
const PARTS: [string, string] = ['4.25', '80']; // 85.00 + 120.00 = 205.00
const CLEANING: [string, string] = ['4', '90']; // 80.00 + 135.00 = 215.00

describe('P6b-AC3: recording a quotation (QUO-T01)', () => {
  it('records a draft priced by the server (half-up at the currency scale), in the requisition currency, and audits it', async () => {
    const rfq = await rfqFor();
    // 20 × 0.0125 = 0.25; 1.5 × 0.11 = 0.165 → 0.17 (half-up; half-even would give 0.16).
    const created = data(await run(u.dewi, recordQuotation, quoteInput(rfq, s.office, ['0.0125', '0.11'], { supplierReference: '  EOS-17 ', leadTimeDays: 0 })));
    expect(created).toEqual({ quotationId: expect.any(String), version: 1 });
    const q = await quotationOf(rfq.rfqId, created.quotationId);
    expect(q).toMatchObject({
      supplierName: 'Example Office Supplies Ltd',
      supplierStatus: 'active',
      supplierReference: 'EOS-17',
      status: 'draft',
      validUntil: '2030-03-31',
      leadTimeDays: 0,
      total: '0.42',
      recordedBy: 'Dewi Procurement',
      submittedAt: null,
      late: false,
      validity: 'draft',
      lowest: false,
      callerActions: ['edit', 'submit', 'discard'],
    });
    expect(q.lines).toEqual([
      { rfqLineId: rfq.lines[0], rfqLineNo: 1, unitPrice: '0.0125', lineTotal: '0.25', lowestOnLine: false },
      { rfqLineId: rfq.lines[1], rfqLineNo: 2, unitPrice: '0.11', lineTotal: '0.17', lowestOnLine: false },
    ]);
    const stored = (await t.pool.query('SELECT currency_code, total FROM quotations WHERE id = $1', [created.quotationId])).rows[0];
    expect(stored).toEqual({ currency_code: 'USD', total: '0.4200' });
    expect((await t.pool.query('SELECT quantity FROM quotation_lines WHERE quotation_id = $1 ORDER BY quantity', [created.quotationId])).rows.map((r) => r.quantity)).toEqual([
      '1.500',
      '20.000',
    ]);
    expect((await auditOf(created.quotationId))[0]).toMatchObject({
      action: 'quotation.recorded',
      actor: u.dewi,
      changes: {
        rfqNumber: [null, rfq.number],
        supplier: [null, expect.stringMatching(/^SUP-\S+ Example Office Supplies Ltd$/)],
        supplierReference: [null, 'EOS-17'],
        currencyCode: [null, 'USD'],
        validUntil: [null, '2030-03-31'],
        leadTimeDays: [null, 0],
        lines: [null, ['1. 20 ream A4 paper @ 0.0125 = 0.25', '2. 1.5 pcs Toner cartridge @ 0.11 = 0.17']],
        total: [null, '0.42'],
        status: [null, 'draft'],
      },
    });
    // A free offer is a price too.
    const free = await recorded(rfq, s.parts, ['0', '0']);
    expect((await quotationOf(rfq.rfqId, free)).total).toBe('0.00');
  });

  it('only from an invited, active supplier without another live quotation on this RFQ', async () => {
    const extra = await newSupplier('Soon Blocked Supplies');
    const rfq = await rfqFor([s.office, s.parts, extra]);
    expect(await run(u.dewi, recordQuotation, quoteInput(rfq, s.cleaning, OFFICE))).toMatchObject({
      ok: false,
      error: { code: 'BUSINESS_RULE', rule: 'SUPPLIER_NOT_INVITED', message: expect.stringContaining(rfq.number) },
    });
    expect(rule(await run(u.dewi, recordQuotation, quoteInput(rfq, randomUUID(), OFFICE)))).toBe('SUPPLIER_NOT_INVITED');
    expect(rule(await run(u.dewi, recordQuotation, quoteInput(rfq, s.pending, OFFICE)))).toBe('SUPPLIER_NOT_INVITED');
    await block(extra);
    expect(await run(u.dewi, recordQuotation, quoteInput(rfq, extra, OFFICE))).toMatchObject({
      ok: false,
      error: { rule: 'SUPPLIER_NOT_ACTIVE', message: expect.stringContaining('Soon Blocked Supplies') },
    });

    const draft = await recorded(rfq, s.office, OFFICE);
    expect(await run(u.fajar, recordQuotation, quoteInput(rfq, s.office, PARTS))).toMatchObject({
      ok: false,
      error: { rule: 'SUPPLIER_ALREADY_QUOTED', message: expect.stringContaining('already has a draft quotation') },
    });
    data(await run(u.dewi, submitQuotation, { quotationId: draft, expectedVersion: 1 }));
    expect(await run(u.fajar, recordQuotation, quoteInput(rfq, s.office, PARTS))).toMatchObject({
      ok: false,
      error: { rule: 'SUPPLIER_ALREADY_QUOTED', message: expect.stringContaining('already has a submitted quotation') },
    });
    data(await run(u.dewi, withdrawQuotation, { quotationId: draft, expectedVersion: 2, reason: 'Supplier sent a revised offer' }));
    // After a withdrawal the supplier may quote again.
    expect(rule(await run(u.fajar, recordQuotation, quoteInput(rfq, s.office, PARTS)))).toBe('ok');
  });

  it('only while the RFQ is issued', async () => {
    const draftRfq = await rfqFor([s.office], false);
    expect(await run(u.dewi, recordQuotation, quoteInput(draftRfq, s.office, OFFICE))).toMatchObject({
      ok: false,
      error: { code: 'INVALID_TRANSITION', message: expect.stringContaining('only while the RFQ is issued') },
    });
    const closedRfq = await rfqFor([s.office]);
    await close(closedRfq);
    expect(rule(await run(u.dewi, recordQuotation, quoteInput(closedRfq, s.office, OFFICE)))).toBe('INVALID_TRANSITION');
    const cancelledRfq = await rfqFor([s.office]);
    data(await run(u.dewi, cancelRfq, { rfqId: cancelledRfq.rfqId, expectedVersion: 2, reason: 'Budget moved' }));
    expect(rule(await run(u.dewi, recordQuotation, quoteInput(cancelledRfq, s.office, OFFICE)))).toBe('INVALID_TRANSITION');
    expect(rule(await run(u.dewi, recordQuotation, { ...quoteInput(cancelledRfq, s.office, OFFICE), rfqId: randomUUID() }))).toBe('NOT_FOUND');
  });

  it('prices every RFQ line exactly once, with valid terms, and refuses server fields; replays an idempotency key', async () => {
    const rfq = await rfqFor();
    const other = await rfqFor();
    const before = await quotationCount();
    expect(await run(u.dewi, recordQuotation, { ...quoteInput(rfq, s.office, OFFICE), lines: [{ rfqLineId: rfq.lines[0], unitPrice: '4' }] })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', fieldErrors: { lines: [expect.stringContaining('line 2 is missing')] } },
    });
    expect(
      await run(u.dewi, recordQuotation, {
        ...quoteInput(rfq, s.office, OFFICE),
        lines: [
          { rfqLineId: rfq.lines[0], unitPrice: '4' },
          { rfqLineId: rfq.lines[0], unitPrice: '5' },
        ],
      }),
    ).toMatchObject({ ok: false, error: { fieldErrors: { 'lines.1.rfqLineId': ['This line is priced twice'] } } });
    expect(
      await run(u.dewi, recordQuotation, {
        ...quoteInput(rfq, s.office, OFFICE),
        lines: [
          { rfqLineId: other.lines[0], unitPrice: '4' },
          { rfqLineId: rfq.lines[1], unitPrice: '5' },
        ],
      }),
    ).toMatchObject({ ok: false, error: { fieldErrors: { 'lines.0.rfqLineId': [expect.stringContaining(rfq.number)] } } });
    for (const extra of [
      { total: '1.00' },
      { status: 'submitted' },
      { currencyCode: 'EUR' },
      { recordedByUserId: u.fajar },
      { submittedAt: '2030-01-01T00:00:00Z' },
      { lines: [{ rfqLineId: rfq.lines[0], unitPrice: '4', quantity: '1' }, { rfqLineId: rfq.lines[1], unitPrice: '5' }] },
      { lines: [{ rfqLineId: rfq.lines[0], unitPrice: '4', lineTotal: '1' }, { rfqLineId: rfq.lines[1], unitPrice: '5' }] },
      { lines: [{ rfqLineId: rfq.lines[0], unitPrice: 4 }, { rfqLineId: rfq.lines[1], unitPrice: '5' }] },
      { lines: [{ rfqLineId: rfq.lines[0], unitPrice: '-1' }, { rfqLineId: rfq.lines[1], unitPrice: '5' }] },
      { lines: [{ rfqLineId: rfq.lines[0], unitPrice: '1.00001' }, { rfqLineId: rfq.lines[1], unitPrice: '5' }] },
      { lines: [{ rfqLineId: rfq.lines[0], unitPrice: '1e3' }, { rfqLineId: rfq.lines[1], unitPrice: '5' }] },
      { lines: [] },
      { leadTimeDays: 366 },
      { leadTimeDays: -1 },
      { leadTimeDays: 1.5 },
      { leadTimeDays: '10' },
      { validUntil: '2030-02-30' },
      { validUntil: '31/03/2030' },
      { supplierReference: 'x'.repeat(101) },
    ]) {
      const result = await run(u.dewi, recordQuotation, { ...quoteInput(rfq, s.office, OFFICE), ...extra });
      expect({ extra, result: rule(result) }).toEqual({ extra, result: 'VALIDATION_FAILED' });
    }
    expect(await quotationCount()).toBe(before);

    const key = `quote-${randomUUID()}`;
    const first = data(await run(u.dewi, recordQuotation, { ...quoteInput(rfq, s.office, OFFICE), idempotencyKey: key }));
    expect(data(await run(u.dewi, recordQuotation, { ...quoteInput(rfq, s.office, OFFICE), idempotencyKey: key }))).toEqual(first);
    expect(await quotationCount()).toBe(before + 1);
    expect(rule(await run(u.dewi, recordQuotation, { ...quoteInput(rfq, s.office, PARTS), idempotencyKey: key }))).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('P6b-AC4: editing, submitting, and withdrawing (QUO-T02 to T04)', () => {
  it('edits a draft only, with a version check; an unchanged draft writes nothing; the change is audited', async () => {
    const rfq = await rfqFor();
    const id = await recorded(rfq, s.office, OFFICE);
    const input = { quotationId: id, expectedVersion: 1, supplierReference: 'EOS-18', validUntil: '2030-04-15', leadTimeDays: 7, lines: priceLines(rfq, ['4.05', '85']) };
    expect(data(await run(u.fajar, updateQuotationDraft, input))).toEqual({ version: 2, rfqId: rfq.rfqId });
    expect(await quotationOf(rfq.rfqId, id)).toMatchObject({ supplierReference: 'EOS-18', validUntil: '2030-04-15', leadTimeDays: 7, total: '208.50', version: 2 });
    const updated = (await auditOf(id)).find((e) => e.action === 'quotation.updated');
    expect(updated).toMatchObject({
      actor: u.fajar,
      changes: {
        supplierReference: [null, 'EOS-18'],
        validUntil: ['2030-03-31', '2030-04-15'],
        leadTimeDays: [10, 7],
        total: ['209.50', '208.50'],
        lines: [
          ['1. 20 ream A4 paper @ 4.1 = 82.00', '2. 1.5 pcs Toner cartridge @ 85 = 127.50'],
          ['1. 20 ream A4 paper @ 4.05 = 81.00', '2. 1.5 pcs Toner cartridge @ 85 = 127.50'],
        ],
      },
    });
    const events = (await auditOf(id)).length;
    // The same values, a price written differently: nothing is written.
    expect(data(await run(u.dewi, updateQuotationDraft, { ...input, expectedVersion: 2, lines: priceLines(rfq, ['4.0500', '85.00']) }))).toEqual({ version: 2, rfqId: rfq.rfqId });
    expect((await auditOf(id)).length).toBe(events);
    expect(rule(await run(u.dewi, updateQuotationDraft, { ...input, expectedVersion: 1 }))).toBe('CONFLICT');
    expect(rule(await run(u.dewi, updateQuotationDraft, { ...input, expectedVersion: 2, lines: priceLines(rfq, ['4', '85']).slice(0, 1) }))).toBe('VALIDATION_FAILED');
    expect(rule(await run(u.dewi, updateQuotationDraft, { ...input, quotationId: randomUUID() }))).toBe('NOT_FOUND');
    expect(rule(await run(u.dewi, updateQuotationDraft, { ...input, expectedVersion: 2, status: 'draft' }))).toBe('VALIDATION_FAILED');

    data(await run(u.dewi, submitQuotation, { quotationId: id, expectedVersion: 2 }));
    expect(await run(u.dewi, updateQuotationDraft, { ...input, expectedVersion: 3 })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_TRANSITION', message: 'A quotation that is submitted cannot be edited.' },
    });
  });

  it('submits a quotation that is still valid today in the org time zone, from an active supplier', async () => {
    const extra = await newSupplier('Blocked Before Submitting');
    const rfq = await rfqFor([s.office, s.parts, extra]);
    const lastDay = await recorded(rfq, s.office, OFFICE, { validUntil: '2030-03-31' });
    const expired = await recorded(rfq, s.parts, PARTS, { validUntil: '2030-03-31' });
    await t.pool.query("UPDATE org_settings SET timezone = 'Asia/Jakarta'");
    try {
      // 2030-03-31 16:59 UTC is 23:59 in Jakarta: still the last day.
      expect(data(await run(u.dewi, submitQuotation, { quotationId: lastDay, expectedVersion: 1 }, fixedClock('2030-03-31T16:59:00Z')))).toEqual({
        version: 2,
        status: 'submitted',
        late: true,
        rfqId: rfq.rfqId,
      });
      // 17:00 UTC is midnight in Jakarta: 1 April, one day too late.
      expect(await run(u.dewi, submitQuotation, { quotationId: expired, expectedVersion: 1 }, fixedClock('2030-03-31T17:00:00Z'))).toMatchObject({
        ok: false,
        error: { code: 'BUSINESS_RULE', rule: 'QUOTATION_EXPIRED', message: expect.stringContaining('2030-03-31') },
      });
    } finally {
      await t.pool.query("UPDATE org_settings SET timezone = 'UTC'");
    }
    expect((await quotationOf(rfq.rfqId, expired)).status).toBe('draft');

    const blocked = await recorded(rfq, extra, CLEANING);
    await block(extra);
    expect(await run(u.dewi, submitQuotation, { quotationId: blocked, expectedVersion: 1 })).toMatchObject({
      ok: false,
      error: { rule: 'SUPPLIER_NOT_ACTIVE', message: expect.stringContaining('Blocked Before Submitting') },
    });
    expect(rule(await run(u.dewi, submitQuotation, { quotationId: lastDay, expectedVersion: 2 }))).toBe('INVALID_TRANSITION');
    expect(rule(await run(u.dewi, submitQuotation, { quotationId: expired, expectedVersion: 2 }))).toBe('CONFLICT');
  });

  it('accepts a quotation after the due time while the RFQ is issued, and marks it late (submitted from the app clock)', async () => {
    const rfq = await rfqFor();
    const onTime = await recorded(rfq, s.office, OFFICE);
    const late = await recorded(rfq, s.parts, PARTS);
    expect(data(await run(u.dewi, submitQuotation, { quotationId: onTime, expectedVersion: 1 }, fixedClock('2030-03-15T17:00:00Z'))).late).toBe(false);
    expect(data(await run(u.fajar, submitQuotation, { quotationId: late, expectedVersion: 1 }, fixedClock('2030-03-15T17:00:01Z'))).late).toBe(true);
    const detail = await get(u.lena, rfq.rfqId);
    expect(detail.quotations.map((q) => [q.supplierName, q.status, q.late, q.submittedAt, q.submittedBy])).toEqual([
      ['Example Office Supplies Ltd', 'submitted', false, '2030-03-15T17:00:00.000Z', 'Dewi Procurement'],
      ['Sample Industrial Parts Co', 'submitted', true, '2030-03-15T17:00:01.000Z', 'Fajar Procurement'],
    ]);
    expect((await auditOf(late)).at(-1)).toMatchObject({ action: 'quotation.submitted', actor: u.fajar, changes: { status: ['draft', 'submitted'], late: [null, true] } });
    expect((await auditOf(onTime)).at(-1)).toMatchObject({ changes: { late: [null, false] } });
    expect(detail.comparison.pastDue).toBe(false);
    expect((await get(u.lena, rfq.rfqId, fixedClock('2030-03-15T17:00:01Z'))).comparison.pastDue).toBe(true);
  });

  it('withdraws with a reason: a submitted quotation until the award, a draft while the RFQ is issued', async () => {
    const rfq = await rfqFor();
    const submittedId = await submitted(rfq, s.office, OFFICE);
    const draftId = await recorded(rfq, s.parts, PARTS);
    for (const reason of [undefined, '', '   ', 'x'.repeat(501)]) {
      expect(rule(await run(u.dewi, withdrawQuotation, { quotationId: submittedId, expectedVersion: 2, ...(reason === undefined ? {} : { reason }) }))).toBe('VALIDATION_FAILED');
    }
    expect(data(await run(u.dewi, withdrawQuotation, { quotationId: draftId, expectedVersion: 1, reason: ' Entered for the wrong supplier ' }))).toEqual({
      version: 2,
      status: 'withdrawn',
      rfqId: rfq.rfqId,
    });
    await close(rfq);
    // After closing, a submitted quotation can still be withdrawn (until the award).
    expect(data(await run(u.fajar, withdrawQuotation, { quotationId: submittedId, expectedVersion: 2, reason: 'Supplier cannot deliver' })).status).toBe('withdrawn');
    const detail = await get(u.dewi, rfq.rfqId);
    expect(detail.quotations.map((q) => [q.supplierName, q.status, q.withdrawReason, q.withdrawnBy, q.callerActions])).toEqual([
      ['Example Office Supplies Ltd', 'withdrawn', 'Supplier cannot deliver', 'Fajar Procurement', []],
      ['Sample Industrial Parts Co', 'withdrawn', 'Entered for the wrong supplier', 'Dewi Procurement', []],
    ]);
    expect((await auditOf(draftId)).at(-1)).toMatchObject({ action: 'quotation.withdrawn', changes: { status: ['draft', 'withdrawn'] }, reason: 'Entered for the wrong supplier' });
    expect(rule(await run(u.dewi, withdrawQuotation, { quotationId: submittedId, expectedVersion: 3, reason: 'Again' }))).toBe('INVALID_TRANSITION');

    // A cancelled RFQ keeps its quotations as recorded: nothing can be withdrawn or discarded.
    const cancelled = await rfqFor();
    const kept = await submitted(cancelled, s.office, OFFICE);
    const keptDraft = await recorded(cancelled, s.parts, PARTS);
    data(await run(u.dewi, cancelRfq, { rfqId: cancelled.rfqId, expectedVersion: 2, reason: 'Requirement dropped' }));
    expect(await run(u.dewi, withdrawQuotation, { quotationId: kept, expectedVersion: 2, reason: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_TRANSITION', message: expect.stringContaining('is cancelled') },
    });
    expect(rule(await run(u.dewi, withdrawQuotation, { quotationId: keptDraft, expectedVersion: 1, reason: 'x' }))).toBe('INVALID_TRANSITION');
    expect(rule(await run(u.dewi, submitQuotation, { quotationId: keptDraft, expectedVersion: 1 }))).toBe('INVALID_TRANSITION');
    expect(rule(await run(u.dewi, updateQuotationDraft, { quotationId: keptDraft, expectedVersion: 1, supplierReference: null, validUntil: '2030-03-31', leadTimeDays: 1, lines: priceLines(cancelled, PARTS) }))).toBe(
      'INVALID_TRANSITION',
    );
  });
});

describe('P6b-AC5: closing and cancelling the RFQ', () => {
  it('closing discards the drafts with an automatic reason (audited) and keeps the submitted ones', async () => {
    const rfq = await rfqFor();
    const kept = await submitted(rfq, s.office, OFFICE);
    const draftA = await recorded(rfq, s.parts, PARTS);
    const draftB = await recorded(rfq, s.cleaning, CLEANING);
    expect(data(await run(u.fajar, closeRfq, { rfqId: rfq.rfqId, expectedVersion: 2 }))).toEqual({ version: 3, status: 'closed' });
    const detail = await get(u.dewi, rfq.rfqId);
    expect(detail.quotations.map((q) => [q.id, q.status, q.withdrawReason, q.withdrawnBy])).toEqual([
      [kept, 'submitted', null, null],
      [draftA, 'withdrawn', 'Not submitted before the RFQ was closed', 'Fajar Procurement'],
      [draftB, 'withdrawn', 'Not submitted before the RFQ was closed', 'Fajar Procurement'],
    ]);
    for (const id of [draftA, draftB]) {
      expect((await auditOf(id)).at(-1)).toMatchObject({
        action: 'quotation.withdrawn',
        actor: u.fajar,
        changes: { status: ['draft', 'withdrawn'] },
        reason: 'Not submitted before the RFQ was closed',
      });
    }
    expect(detail.callerActions).toEqual(['cancel', 'award']);
    expect(detail.quotations.find((q) => q.id === kept)?.callerActions).toEqual(['withdraw']);
  });

  it('cancelling keeps every quotation as recorded', async () => {
    const rfq = await rfqFor();
    const kept = await submitted(rfq, s.office, OFFICE);
    const draft = await recorded(rfq, s.parts, PARTS);
    data(await run(u.dewi, cancelRfq, { rfqId: rfq.rfqId, expectedVersion: 2, reason: 'Requirement dropped' }));
    const detail = await get(u.dewi, rfq.rfqId);
    expect(detail.quotations.map((q) => [q.id, q.status, q.callerActions])).toEqual([
      [kept, 'submitted', []],
      [draft, 'draft', []],
    ]);
    expect(detail.callerActions).toEqual([]);
  });
});

describe('P6b-AC6: the comparison (server-side)', () => {
  it('marks the lowest valid total and the lowest price per line, ignoring drafts, withdrawn, expired, and inactive suppliers', async () => {
    await setRule('300', 3);
    const extra = await newSupplier('Cheapest But Blocked');
    const late = await newSupplier('Cheap But Expiring');
    const rfq = await rfqFor([s.office, s.parts, s.cleaning, extra, late]);
    const office = await submitted(rfq, s.office, OFFICE);
    const parts = await submitted(rfq, s.parts, PARTS);
    const cleaning = await recorded(rfq, s.cleaning, ['1', '1']);
    const blocked = await submitted(rfq, extra, ['1', '2']);
    const expiring = await submitted(rfq, late, ['3', '3'], { validUntil: '2030-01-31' });
    await block(extra);

    const at = async (clock?: Clock) => get(u.sari, rfq.rfqId, clock);
    const detail = await at(fixedClock('2030-01-31T12:00:00Z'));
    const byId = new Map(detail.quotations.map((q) => [q.id, q]));
    expect([office, parts, cleaning, blocked, expiring].map((id) => [byId.get(id)?.validity, byId.get(id)?.lowest])).toEqual([
      ['valid', false],
      ['valid', false],
      ['draft', false],
      ['supplier_not_active', false],
      // Valid through its last day: 64.50 is the lowest valid total.
      ['valid', true],
    ]);
    expect(detail.comparison).toEqual({
      today: '2030-01-31',
      pastDue: false,
      validCount: 3,
      lowestTotal: '64.50',
      rfqRequiredAbove: '300',
      minQuotes: 3,
      minQuotesApplies: true,
      belowMinQuotes: false,
    });

    // A day later it has expired: Sample Industrial Parts is the lowest total, Example Office the lowest on line 1.
    const later = await at(fixedClock('2030-02-01T00:00:00Z'));
    const after = new Map(later.quotations.map((q) => [q.id, q]));
    expect(after.get(expiring)?.validity).toBe('expired');
    expect([after.get(office)?.lowest, after.get(parts)?.lowest]).toEqual([false, true]);
    expect(after.get(office)?.lines.map((l) => l.lowestOnLine)).toEqual([true, false]);
    expect(after.get(parts)?.lines.map((l) => l.lowestOnLine)).toEqual([false, true]);
    expect(later.comparison).toMatchObject({ validCount: 2, lowestTotal: '205.00', belowMinQuotes: true });
    expect(Object.keys(later.comparison).sort()).toEqual([...COMPARISON_KEYS].sort());
    expect(Object.keys(later.quotations[0] ?? {}).sort()).toEqual([...QUOTATION_KEYS].sort());
    expect(Object.keys(later.quotations[0]?.lines[0] ?? {}).sort()).toEqual([...QUOTATION_LINE_KEYS].sort());
  });

  it('applies the minimum from the threshold itself, and only below the minimum count; ties are all the lowest', async () => {
    const rfq = await rfqFor();
    const a = await submitted(rfq, s.office, ['4.25', '80']);
    const b = await submitted(rfq, s.parts, ['4.25', '80.0000']);
    const summary = async () => (await get(u.lena, rfq.rfqId)).comparison;
    // The requisition's estimated total is 302.30.
    await setRule('302.30', 2);
    expect(await summary()).toMatchObject({ minQuotesApplies: true, belowMinQuotes: false, validCount: 2 });
    await setRule('302.30', 3);
    expect(await summary()).toMatchObject({ minQuotesApplies: true, belowMinQuotes: true });
    await setRule('302.31', 3);
    expect(await summary()).toMatchObject({ minQuotesApplies: false, belowMinQuotes: false });
    await setRule(null, 10);
    expect(await summary()).toMatchObject({ rfqRequiredAbove: null, minQuotesApplies: false, belowMinQuotes: false });
    const detail = await get(u.lena, rfq.rfqId);
    expect(detail.quotations.filter((q) => q.lowest).map((q) => q.id).sort()).toEqual([a, b].sort());
    expect(detail.quotations.every((q) => q.lines.every((l) => l.lowestOnLine))).toBe(true);
  });
});

describe('P6b-AC7: the award (RFQ-T05)', () => {
  it('awards the lowest valid quotation without a justification when enough arrived; the others are not awarded; audited', async () => {
    await setRule('300', 2);
    const rfq = await rfqFor();
    const office = await submitted(rfq, s.office, OFFICE);
    const parts = await submitted(rfq, s.parts, PARTS);
    const withdrawn = await submitted(rfq, s.cleaning, CLEANING);
    data(await run(u.dewi, withdrawQuotation, { quotationId: withdrawn, expectedVersion: 2, reason: 'Offer expired early' }));
    expect(await award(rfq, parts)).toMatchObject({ ok: false, error: { code: 'INVALID_TRANSITION', message: 'An RFQ that is issued cannot be awarded.' } });
    await close(rfq);
    expect(data(await award(rfq, parts, undefined, u.fajar))).toEqual({ version: 4, status: 'awarded' });

    const detail = await get(u.lena, rfq.rfqId);
    expect(detail.status).toBe('awarded');
    expect(detail.quotations.map((q) => [q.id, q.status])).toEqual([
      [office, 'not_awarded'],
      [parts, 'awarded'],
      [withdrawn, 'withdrawn'],
    ]);
    expect(detail.award).toEqual({
      quotationId: parts,
      supplierName: 'Sample Industrial Parts Co',
      total: '205.00',
      awardedBy: 'Fajar Procurement',
      awardedAt: expect.any(String),
      justification: null,
      rfqRequiredAbove: '300',
      minQuotes: 2,
      validQuotations: 2,
      belowMinQuotes: false,
      notLowest: false,
    });
    expect(Object.keys(detail.award ?? {}).sort()).toEqual([...AWARD_KEYS].sort());
    expect(detail.callerActions).toEqual([]);
    expect((await get(u.dewi, rfq.rfqId)).callerActions).toEqual([]);
    expect((await t.pool.query('SELECT awarded_by_user_id FROM rfqs WHERE id = $1', [rfq.rfqId])).rows[0].awarded_by_user_id).toBe(u.fajar);
    expect((await auditOf(rfq.rfqId)).at(-1)).toMatchObject({
      action: 'rfq.awarded',
      actor: u.fajar,
      reason: null,
      changes: {
        status: ['closed', 'awarded'],
        awardedTo: [null, expect.stringMatching(/Sample Industrial Parts Co$/)],
        awardedTotal: [null, '205.00 USD'],
        rfqRequiredAbove: [null, '300'],
        minQuotes: [null, 2],
        validQuotations: [null, 2],
        belowMinQuotes: [null, false],
        notLowest: [null, false],
      },
    });
    expect((await auditOf(parts)).at(-1)).toMatchObject({ action: 'quotation.awarded', changes: { status: ['submitted', 'awarded'] } });
    expect((await auditOf(office)).at(-1)).toMatchObject({ action: 'quotation.notAwarded', changes: { status: ['submitted', 'not_awarded'] } });
    // Awarded is final.
    expect(rule(await award(rfq, office, 'Changed our mind'))).toBe('INVALID_TRANSITION');
    expect(rule(await run(u.dewi, withdrawQuotation, { quotationId: parts, expectedVersion: 3, reason: 'Too late' }))).toBe('INVALID_TRANSITION');
  });

  it('needs a justification when fewer valid quotations than the minimum arrived, from the threshold itself', async () => {
    await setRule('302.30', 3);
    const rfq = await rfqFor();
    await submitted(rfq, s.office, OFFICE);
    const parts = await submitted(rfq, s.parts, PARTS);
    await close(rfq);
    const refused = await award(rfq, parts);
    expect(refused).toMatchObject({
      ok: false,
      error: {
        code: 'BUSINESS_RULE',
        rule: 'MIN_QUOTES_JUSTIFICATION_REQUIRED',
        message: 'Only 2 valid quotations were received; 3 are expected because the requisition\'s estimated total (302.30 USD) is at or above 302.30 USD. Give a justification to award it.',
        details: { reasons: ['below_min_quotes'], validQuotations: 2, minQuotes: 3, lowestTotal: '205.00' },
      },
    });
    for (const blank of ['', '   ']) expect(rule(await award(rfq, parts, blank))).toBe('MIN_QUOTES_JUSTIFICATION_REQUIRED');
    expect(rule(await award(rfq, parts, 'x'.repeat(2001)))).toBe('VALIDATION_FAILED');
    expect(data(await award(rfq, parts, '  Only two suppliers stock this toner.  '))).toMatchObject({ status: 'awarded' });
    expect((await get(u.dewi, rfq.rfqId)).award).toMatchObject({ justification: 'Only two suppliers stock this toner.', belowMinQuotes: true, notLowest: false, validQuotations: 2, minQuotes: 3 });
    expect((await auditOf(rfq.rfqId)).at(-1)).toMatchObject({ action: 'rfq.awarded', reason: 'Only two suppliers stock this toner.', changes: { belowMinQuotes: [null, true] } });

    // Just below the threshold, two are enough without a justification.
    await setRule('302.31', 3);
    const below = await rfqFor();
    await submitted(below, s.office, OFFICE);
    const lowest = await submitted(below, s.parts, PARTS);
    await close(below);
    expect(data(await award(below, lowest))).toMatchObject({ status: 'awarded' });
  });

  it('needs a justification for a quotation that is not the lowest valid one; one text covers both reasons', async () => {
    await setRule(null, 3);
    const rfq = await rfqFor();
    const office = await submitted(rfq, s.office, OFFICE);
    await submitted(rfq, s.parts, PARTS);
    await close(rfq);
    expect(await award(rfq, office)).toMatchObject({
      ok: false,
      error: {
        rule: 'NON_LOWEST_JUSTIFICATION_REQUIRED',
        message: 'This quotation (209.50 USD) is not the lowest valid one (205.00 USD). Give a justification to award it.',
        details: { reasons: ['not_lowest'] },
      },
    });
    expect(data(await award(rfq, office, 'Faster delivery on the toner'))).toMatchObject({ status: 'awarded' });
    expect((await get(u.dewi, rfq.rfqId)).award).toMatchObject({ notLowest: true, belowMinQuotes: false, rfqRequiredAbove: null });

    await setRule('100', 3);
    const both = await rfqFor();
    const pick = await submitted(both, s.office, OFFICE);
    await submitted(both, s.parts, PARTS);
    await close(both);
    const refused = await award(both, pick);
    expect(refused).toMatchObject({ ok: false, error: { rule: 'MIN_QUOTES_JUSTIFICATION_REQUIRED', details: { reasons: ['below_min_quotes', 'not_lowest'] } } });
    expect(refused.ok ? '' : refused.error.message).toContain('is not the lowest valid one (205.00 USD)');
    expect(data(await award(both, pick, 'Framework agreement with this supplier'))).toMatchObject({ status: 'awarded' });
    expect((await get(u.dewi, both.rfqId)).award).toMatchObject({ belowMinQuotes: true, notLowest: true });

    // Equal totals: either one is the lowest.
    await setRule(null, 3);
    const tie = await rfqFor();
    await submitted(tie, s.office, ['4.25', '80']);
    const tied = await submitted(tie, s.parts, PARTS);
    await close(tie);
    expect(data(await award(tie, tied))).toMatchObject({ status: 'awarded' });
  });

  it('refuses expired, inactive-supplier, withdrawn, and foreign quotations, stale versions, and a requisition no longer approved', async () => {
    await setRule(null, 1);
    const extra = await newSupplier('Blocked After Quoting');
    const rfq = await rfqFor([s.office, s.parts, s.cleaning, extra]);
    const expiring = await submitted(rfq, s.office, ['1', '1'], { validUntil: '2030-03-31' });
    const parts = await submitted(rfq, s.parts, PARTS);
    const withdrawn = await submitted(rfq, s.cleaning, CLEANING);
    const blockedId = await submitted(rfq, extra, ['2', '2']);
    data(await run(u.dewi, withdrawQuotation, { quotationId: withdrawn, expectedVersion: 2, reason: 'Withdrawn by supplier' }));
    await block(extra);
    await close(rfq);

    expect(await award(rfq, expiring, undefined, u.dewi, fixedClock('2030-04-01T00:00:00Z'))).toMatchObject({
      ok: false,
      error: { rule: 'QUOTATION_EXPIRED', message: expect.stringContaining('2030-03-31') },
    });
    expect(await award(rfq, blockedId, 'Cheapest')).toMatchObject({ ok: false, error: { rule: 'SUPPLIER_NOT_ACTIVE', message: expect.stringContaining('Blocked After Quoting') } });
    expect(await award(rfq, withdrawn, 'x')).toMatchObject({ ok: false, error: { code: 'INVALID_TRANSITION', message: 'A quotation that is withdrawn cannot be awarded.' } });
    const elsewhere = await rfqFor();
    const foreign = await submitted(elsewhere, s.office, OFFICE);
    expect(rule(await award(rfq, foreign))).toBe('NOT_FOUND');
    expect(rule(await run(u.dewi, awardQuotation, { rfqId: rfq.rfqId, quotationId: parts, expectedVersion: 1 }))).toBe('CONFLICT');
    expect(rule(await run(u.dewi, awardQuotation, { rfqId: randomUUID(), quotationId: parts, expectedVersion: 1 }))).toBe('NOT_FOUND');
    // On its last day the expiring one is valid, the lowest, and can be awarded; but first the requisition is cancelled.
    const prVersion = (await t.pool.query('SELECT version FROM purchase_requisitions WHERE id = $1', [rfq.requisitionId])).rows[0].version;
    data(await run(u.dewi, cancelRequisition, { requisitionId: rfq.requisitionId, expectedVersion: prVersion, reason: 'Budget withdrawn' }));
    expect(rule(await award(rfq, expiring, undefined, u.dewi, fixedClock('2030-03-31T23:59:00Z')))).toBe('REQUISITION_NOT_APPROVED');
    expect((await get(u.dewi, rfq.rfqId)).callerActions).toEqual(['cancel']);
    expect((await get(u.dewi, rfq.rfqId)).status).toBe('closed');

    const valid = await rfqFor();
    const last = await submitted(valid, s.office, ['1', '1'], { validUntil: '2030-03-31' });
    await close(valid);
    expect(data(await award(valid, last, undefined, u.dewi, fixedClock('2030-03-31T23:59:00Z')))).toMatchObject({ status: 'awarded' });
  });

  it('keeps the rule it used when the settings change later', async () => {
    await setRule('300', 3);
    const rfq = await rfqFor();
    const parts = await submitted(rfq, s.parts, PARTS);
    await close(rfq);
    data(await award(rfq, parts, 'Single source for this toner'));
    await setRule(null, 1);
    expect((await get(u.lena, rfq.rfqId)).award).toMatchObject({ rfqRequiredAbove: '300', minQuotes: 3, validQuotations: 1, belowMinQuotes: true });
  });
});

describe('P6b-AC8: who can see and change quotations', () => {
  it('only procurement records, edits, submits, withdraws, and awards', async () => {
    await setRule(null, 1);
    const rfq = await rfqFor();
    const draft = await recorded(rfq, s.office, OFFICE);
    for (const as of [u.rina, u.bayu, u.sari, u.lena, u.ada, u.agus]) {
      expect(rule(await run(as, recordQuotation, quoteInput(rfq, s.parts, PARTS)))).toBe('FORBIDDEN');
      expect(rule(await run(as, updateQuotationDraft, { quotationId: draft, expectedVersion: 1, supplierReference: null, validUntil: '2030-03-31', leadTimeDays: 1, lines: priceLines(rfq, OFFICE) }))).toBe('FORBIDDEN');
      expect(rule(await run(as, submitQuotation, { quotationId: draft, expectedVersion: 1 }))).toBe('FORBIDDEN');
      expect(rule(await run(as, withdrawQuotation, { quotationId: draft, expectedVersion: 1, reason: 'x' }))).toBe('FORBIDDEN');
      expect(rule(await run(as, awardQuotation, { rfqId: rfq.rfqId, quotationId: draft, expectedVersion: 2 }))).toBe('FORBIDDEN');
    }
    expect((await quotationOf(rfq.rfqId, draft)).version).toBe(1);
  });

  it('finance and the auditor read quotations and the comparison, without actions or user ids', async () => {
    const rfq = await rfqFor();
    await submitted(rfq, s.office, OFFICE);
    await recorded(rfq, s.parts, PARTS);
    for (const as of [u.sari, u.lena]) {
      const detail = await get(as, rfq.rfqId);
      expect(detail.quotations.map((q) => [q.status, q.total, q.callerActions])).toEqual([
        ['submitted', '209.50', []],
        ['draft', '205.00', []],
      ]);
      expect(detail.callerActions).toEqual([]);
      expect(detail.comparison.validCount).toBe(1);
      const json = JSON.stringify(detail);
      for (const id of [u.dewi, u.fajar]) expect(json).not.toContain(id);
    }
    expect((await get(u.dewi, rfq.rfqId)).callerActions).toEqual(['close', 'cancel', 'record']);
    for (const as of [u.rina, u.bayu, u.ada, u.agus]) expect(rule(await run(as, getRfq, { rfqId: rfq.rfqId }))).toBe('FORBIDDEN');
  });
});

describe('P6b-AC9: database backstops', () => {
  const insertQuotation = (pool: TestDatabase['appPool'], rfqId: string, supplierId: string, status = 'draft', currency = 'USD') =>
    pool.query(
      `INSERT INTO quotations (rfq_id, supplier_id, status, currency_code, valid_until, lead_time_days, total, recorded_by_user_id, submitted_at, submitted_by_user_id)
       VALUES ($1, $2, $3, $4, '2030-03-31', 5, 0, $5, CASE WHEN $3 = 'submitted' THEN now() END, CASE WHEN $3 = 'submitted' THEN $5::uuid END)`,
      [rfqId, supplierId, status, currency, u.dewi],
    );

  it('quotations: from invited, active suppliers of an issued RFQ, as drafts, one live per supplier, frozen once submitted, never deleted', async () => {
    const extra = await newSupplier('Direct SQL Blocked');
    const rfq = await rfqFor([s.office, s.parts, extra]);
    const draftRfq = await rfqFor([s.office], false);
    await block(extra);
    for (const pool of [t.appPool, t.pool]) {
      expect(await sqlStateOf(() => insertQuotation(pool, rfq.rfqId, s.cleaning))).toBe('23503');
      expect(await sqlStateOf(() => insertQuotation(pool, rfq.rfqId, s.office, 'submitted'))).toBe('PFB02');
      expect(await sqlStateOf(() => insertQuotation(pool, draftRfq.rfqId, s.office))).toBe('PFB02');
      expect(await sqlStateOf(() => insertQuotation(pool, rfq.rfqId, extra))).toBe('PFB02');
      expect(await sqlStateOf(() => insertQuotation(pool, rfq.rfqId, s.office, 'draft', 'EUR'))).toBe('PFB02');
    }
    // A draft without lines does not cover the RFQ: refused at commit.
    expect(await sqlStateOf(() => insertQuotation(t.appPool, rfq.rfqId, s.office))).toBe('PFB02');

    const live = await submitted(rfq, s.office, OFFICE);
    const draft = await recorded(rfq, s.parts, PARTS);
    expect(await sqlStateOf(() => insertQuotation(t.appPool, rfq.rfqId, s.office))).toBe('23505');
    for (const pool of [t.appPool, t.pool]) {
      for (const [statement, id] of [
        ['UPDATE quotations SET lead_time_days = 1 WHERE id = $1', live],
        ["UPDATE quotations SET valid_until = '2031-01-01' WHERE id = $1", live],
        ['UPDATE quotations SET total = 1 WHERE id = $1', live],
        ["UPDATE quotations SET status = 'draft', submitted_at = NULL, submitted_by_user_id = NULL WHERE id = $1", live],
        ["UPDATE quotations SET status = 'awarded' WHERE id = $1", live],
        ["UPDATE quotations SET status = 'not_awarded' WHERE id = $1", live],
        ['UPDATE quotations SET submitted_at = now() - interval $$1 day$$ WHERE id = $1', live],
        ['UPDATE quotations SET supplier_id = (SELECT id FROM suppliers WHERE id <> (SELECT supplier_id FROM quotations WHERE id = $1) LIMIT 1) WHERE id = $1', draft],
        ["UPDATE quotations SET currency_code = 'EUR' WHERE id = $1", draft],
        ["UPDATE quotations SET status = 'awarded', submitted_at = now(), submitted_by_user_id = recorded_by_user_id WHERE id = $1", draft],
        ['DELETE FROM quotations WHERE id = $1', draft],
      ] as const) {
        const expected = pool === t.appPool && statement.startsWith('DELETE') ? '42501' : 'PFB02';
        expect({ statement, state: await sqlStateOf(() => pool.query(statement, [id])) }).toEqual({ statement, state: expected });
      }
    }
    // Terms cannot change together with a status change either: not while submitting, not while withdrawing.
    for (const pool of [t.appPool, t.pool]) {
      for (const [statement, id] of [
        ["UPDATE quotations SET status = 'submitted', submitted_at = now(), submitted_by_user_id = recorded_by_user_id, lead_time_days = 99 WHERE id = $1", draft],
        ["UPDATE quotations SET status = 'withdrawn', withdrawn_at = now(), withdrawn_by_user_id = recorded_by_user_id, withdraw_reason = 'x', valid_until = '2031-01-01' WHERE id = $1", live],
      ] as const) {
        expect({ statement, state: await sqlStateOf(() => pool.query(statement, [id])) }).toEqual({ statement, state: 'PFB02' });
      }
    }
    // A draft's total must stay the sum of its lines (checked at commit).
    expect(await sqlStateOf(() => t.appPool.query('UPDATE quotations SET total = total + 1 WHERE id = $1', [draft]))).toBe('PFB02');
    expect(await sqlStateOf(() => t.appPool.query('UPDATE quotations SET lead_time_days = 30 WHERE id = $1', [draft]))).toBe('none');
    // Submitting directly is refused for a supplier blocked after recording.
    const later = await newSupplier('Blocked Before Direct Submit');
    const laterRfq = await rfqFor([later]);
    const laterDraft = await recorded(laterRfq, later, CLEANING);
    await block(later);
    expect(
      await sqlStateOf(() => t.appPool.query("UPDATE quotations SET status = 'submitted', submitted_at = now(), submitted_by_user_id = recorded_by_user_id WHERE id = $1", [laterDraft])),
    ).toBe('PFB02');
    expect(await sqlStateOf(() => t.appPool.query("UPDATE quotations SET status = 'withdrawn' WHERE id = $1", [draft]))).toBe('23514');
  });

  it('quotation lines: only in drafts of an issued RFQ, for the RFQ line quantity, with rounded totals, on the own RFQ; totals checked at commit', async () => {
    const rfq = await rfqFor();
    const other = await rfqFor();
    const draft = await recorded(rfq, s.office, OFFICE);
    const done = await submitted(rfq, s.parts, PARTS);
    const lineOf = async (quotationId: string) =>
      (await t.pool.query('SELECT id, rfq_line_id FROM quotation_lines WHERE quotation_id = $1 ORDER BY quantity DESC', [quotationId])).rows as { id: string; rfq_line_id: string }[];
    const [paper] = await lineOf(draft);
    const [submittedPaper] = await lineOf(done);
    if (!paper || !submittedPaper) throw new Error('lines missing');
    for (const pool of [t.appPool, t.pool]) {
      for (const [statement, params] of [
        // Submitted: no change at all.
        ['UPDATE quotation_lines SET unit_price = 1, line_total = 20 WHERE id = $1', [submittedPaper.id]],
        ['DELETE FROM quotation_lines WHERE id = $1', [submittedPaper.id]],
        // Draft: the quantity is the RFQ's, the total is rounded, the line is on this RFQ.
        ['UPDATE quotation_lines SET quantity = 19, line_total = 77.90 WHERE id = $1', [paper.id]],
        ['UPDATE quotation_lines SET line_total = 82.01 WHERE id = $1', [paper.id]],
        ['UPDATE quotation_lines SET rfq_line_id = $2 WHERE id = $1', [paper.id, other.lines[0]]],
        ['INSERT INTO quotation_lines (quotation_id, rfq_line_id, quantity, unit_price, line_total) VALUES ($1, $2, 20, 1, 20)', [draft, other.lines[0]]],
      ] as const) {
        expect({ statement, state: await sqlStateOf(() => pool.query(statement, [...params])) }).toEqual({ statement, state: 'PFB02' });
      }
    }
    // Consistent with the line rule but not with the header total: refused at commit.
    expect(await sqlStateOf(() => t.appPool.query('UPDATE quotation_lines SET unit_price = 4, line_total = 80 WHERE id = $1', [paper.id]))).toBe('PFB02');
    expect(await sqlStateOf(() => t.appPool.query('DELETE FROM quotation_lines WHERE id = $1', [paper.id]))).toBe('PFB02');
    expect(await sqlStateOf(() => t.appPool.query('UPDATE quotation_lines SET unit_price = -1, line_total = -20 WHERE id = $1', [paper.id]))).toBe('23514');
    // A line total off by one cent, with a header that matches it: still refused (rounding rule).
    const skewed = await t.appPool.connect();
    try {
      await skewed.query('BEGIN');
      expect(
        await sqlStateOf(async () => {
          await skewed.query('UPDATE quotations SET total = 209.51 WHERE id = $1', [draft]);
          await skewed.query('UPDATE quotation_lines SET line_total = 82.01 WHERE id = $1', [paper.id]);
          await skewed.query('COMMIT');
        }),
      ).toBe('PFB02');
    } finally {
      await skewed.query('ROLLBACK').catch(() => undefined);
      skewed.release();
    }
    // Line and header together, in one transaction: accepted.
    const client = await t.appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE quotation_lines SET unit_price = 4, line_total = 80 WHERE id = $1', [paper.id]);
      await client.query('UPDATE quotations SET total = 207.50 WHERE id = $1', [draft]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect((await quotationOf(rfq.rfqId, draft)).total).toBe('207.50');
  });

  it('rfqs: closing leaves no draft, the award names a submitted quotation of the RFQ with a consistent rule, and an awarded RFQ is frozen', async () => {
    await setRule('300', 3);
    const rfq = await rfqFor();
    const parts = await submitted(rfq, s.parts, PARTS);
    const office = await submitted(rfq, s.office, OFFICE);
    const draft = await recorded(rfq, s.cleaning, CLEANING);
    const closeDirectly = "UPDATE rfqs SET status = 'closed', closed_at = now(), closed_by_user_id = created_by_user_id WHERE id = $1";
    for (const pool of [t.appPool, t.pool]) expect(await sqlStateOf(() => pool.query(closeDirectly, [rfq.rfqId]))).toBe('PFB01');
    await t.pool.query("UPDATE quotations SET status = 'withdrawn', withdrawn_at = now(), withdrawn_by_user_id = recorded_by_user_id, withdraw_reason = 'Test' WHERE id = $1", [draft]);
    expect(await sqlStateOf(() => t.appPool.query(closeDirectly, [rfq.rfqId]))).toBe('none');

    const awardDirectly = (quotationId: string, valid: number, belowMin: boolean, notLowest: boolean, justification: string | null) =>
      t.appPool.query(
        `UPDATE rfqs SET status = 'awarded', awarded_quotation_id = $2, awarded_by_user_id = created_by_user_id, awarded_at = now(),
           award_rfq_required_above = 300, award_min_quotes = 3, award_valid_quotes = $3, award_below_min_quotes = $4, award_not_lowest = $5, award_justification = $6
         WHERE id = $1`,
        [rfq.rfqId, quotationId, valid, belowMin, notLowest, justification],
      );
    expect(await sqlStateOf(() => awardDirectly(draft, 2, true, false, 'x'))).toBe('PFB01'); // withdrawn
    const foreignRfq = await rfqFor();
    const foreign = await submitted(foreignRfq, s.office, OFFICE);
    expect(await sqlStateOf(() => awardDirectly(foreign, 2, true, false, 'x'))).toBe('PFB01');
    expect(await sqlStateOf(() => awardDirectly(parts, 2, false, false, null))).toBe('PFB01'); // 2 < 3 above 300: below the minimum
    expect(await sqlStateOf(() => awardDirectly(parts, 3, true, false, 'x'))).toBe('PFB01'); // more valid than submitted
    expect(await sqlStateOf(() => awardDirectly(parts, 2, true, false, null))).toBe('23514'); // no justification
    expect(await sqlStateOf(() => awardDirectly(office, 2, true, true, null))).toBe('23514');
    expect(await sqlStateOf(() => t.appPool.query('UPDATE rfqs SET award_justification = $2 WHERE id = $1', [rfq.rfqId, 'Not awarded yet']))).toBe('PFB01');
    expect(await sqlStateOf(() => awardDirectly(parts, 2, true, false, 'Direct award'))).toBe('none');
    // Then the quotations follow the award only: the chosen one is awarded, the others not.
    expect(await sqlStateOf(() => t.appPool.query("UPDATE quotations SET status = 'awarded' WHERE id = $1", [office]))).toBe('PFB02');
    expect(await sqlStateOf(() => t.appPool.query("UPDATE quotations SET status = 'not_awarded' WHERE id = $1", [parts]))).toBe('PFB02');
    expect(await sqlStateOf(() => t.appPool.query("UPDATE quotations SET status = 'awarded' WHERE id = $1", [parts]))).toBe('none');
    expect(await sqlStateOf(() => t.appPool.query("UPDATE quotations SET status = 'not_awarded' WHERE id = $1", [office]))).toBe('none');
    for (const pool of [t.appPool, t.pool]) {
      for (const statement of [
        'UPDATE rfqs SET award_justification = $$Rewritten$$ WHERE id = $1',
        'UPDATE rfqs SET awarded_quotation_id = (SELECT id FROM quotations WHERE rfq_id = $1 AND status = $$not_awarded$$) WHERE id = $1',
        "UPDATE rfqs SET status = 'cancelled', cancelled_at = now(), cancelled_by_user_id = created_by_user_id, cancel_reason = 'x' WHERE id = $1",
      ]) {
        expect({ statement, state: await sqlStateOf(() => pool.query(statement, [rfq.rfqId])) }).toEqual({ statement, state: 'PFB01' });
      }
    }
  });
});
