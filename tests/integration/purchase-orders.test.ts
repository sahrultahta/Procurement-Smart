import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { approvalInbox } from '@/modules/approvals';
import { getActiveApprovalPolicy, listApprovalPolicyVersions, publishApprovalPolicy } from '@/modules/organization';
import {
  PO_DETAIL_KEYS,
  PO_FORM_LINE_KEYS,
  PO_FORM_OPTIONS_KEYS,
  PO_LINE_KEYS,
  PO_QUOTATION_KEYS,
  PO_SUMMARY_KEYS,
  PO_SUPPLIER_KEYS,
  cancelPurchaseOrder,
  closePurchaseOrder,
  createPurchaseOrder,
  getPurchaseOrder,
  issuePurchaseOrder,
  listPurchaseOrders,
  purchaseOrderFormOptions,
  submitPurchaseOrder,
  updatePurchaseOrderDraft,
} from '@/modules/purchasing';
import { createGoodsReceipt, postGoodsReceipt } from '@/modules/receiving';
import { cancelRequisition, closeRequisition, createRequisition, submitRequisition } from '@/modules/requisitions';
import { awardQuotation, closeRfq, createRfq, getRfq, issueRfq, recordQuotation, submitQuotation } from '@/modules/sourcing';
import { blockSupplier, createSupplier, reviewSupplier } from '@/modules/suppliers';
import { decideApproval } from '@/server/approvals';
import { runCommand, runQuery, type Operation } from '@/shared/application/runner';
import { fixedClock, type Clock } from '@/shared/clock';
import type { Result } from '@/shared/result';
import { contextOf, provisionActor } from '../support/actors';
import { createTestDatabase, sqlStateOf, type TestDatabase } from '../support/test-db';

/* Phase 7: purchase orders, as the runtime role through the command runner. */

let t: TestDatabase;
type Persona = 'rina' | 'bayu' | 'nina' | 'dewi' | 'fajar' | 'paul' | 'olga' | 'sari' | 'lena' | 'ada' | 'agus';
const u = {} as Record<Persona, string>;
const s = {} as Record<'office' | 'parts' | 'pending', string>;
let supplierCount = 0;
let finDepartment = '';

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

async function newSupplier(legalName: string, approve = true): Promise<string> {
  supplierCount++;
  const created = data(
    await run(u.dewi, createSupplier, {
      legalName,
      taxId: `EX-7000-${String(supplierCount).padStart(4, '0')}`,
      email: `orders${supplierCount}@example.com`,
      phone: '+1 555 0170',
      addressLine1: '700 Example Way',
      addressLine2: null,
      city: 'Springfield',
      region: null,
      postalCode: '00070',
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

/** The requisition and PO approval rules, set directly (the settings command is tested in organization.test.ts). */
async function setRules(rules: { rfqRequiredAbove?: string | null; threshold?: string | null; tolerance?: string; receipt?: string }): Promise<void> {
  const current = (await t.pool.query('SELECT rfq_required_above, po_approval_threshold, po_price_tolerance_pct, over_receipt_tolerance_pct FROM org_settings')).rows[0];
  await t.pool.query('UPDATE org_settings SET rfq_required_above = $1, po_approval_threshold = $2, po_price_tolerance_pct = $3, over_receipt_tolerance_pct = $4', [
    rules.rfqRequiredAbove === undefined ? current.rfq_required_above : rules.rfqRequiredAbove,
    rules.threshold === undefined ? current.po_approval_threshold : rules.threshold,
    rules.tolerance ?? current.po_price_tolerance_pct,
    rules.receipt ?? current.over_receipt_tolerance_pct,
  ]);
}

const DEFAULT_RULES = { rfqRequiredAbove: null, threshold: '1000', tolerance: '5', receipt: '0' } as const;

const FINANCE = { role: 'finance', scopeMode: 'organization' } as const;
const APPROVER = { role: 'approver', scopeMode: 'document_department' } as const;

beforeAll(async () => {
  t = await createTestDatabase();
  await t.pool.query("INSERT INTO departments (code, name) VALUES ('OPS', 'Operations'), ('FIN', 'Finance')");
  finDepartment = (await t.pool.query("SELECT id FROM departments WHERE code = 'FIN'")).rows[0].id;
  u.rina = await provisionActor(t.appDb, 'rina@example.com', 'Rina Requester', ['requester'], { departmentCode: 'OPS' });
  u.bayu = await provisionActor(t.appDb, 'bayu@example.com', 'Bayu Approver', [{ role: 'approver', departmentCode: 'OPS' }], { departmentCode: 'OPS' });
  u.nina = await provisionActor(t.appDb, 'nina@example.com', 'Nina Approver', [{ role: 'approver', departmentCode: 'FIN' }], { departmentCode: 'FIN' });
  u.dewi = await provisionActor(t.appDb, 'dewi@example.com', 'Dewi Procurement', ['procurement']);
  u.fajar = await provisionActor(t.appDb, 'fajar@example.com', 'Fajar Procurement', ['procurement']);
  // Buyers who also hold finance: SOD-01 (paul creates) and SOD-06 (olga awards).
  u.paul = await provisionActor(t.appDb, 'paul@example.com', 'Paul Buyer-Finance', ['procurement', 'finance']);
  u.olga = await provisionActor(t.appDb, 'olga@example.com', 'Olga Buyer-Finance', ['procurement', 'finance']);
  u.sari = await provisionActor(t.appDb, 'sari@example.com', 'Sari Finance', ['finance']);
  u.lena = await provisionActor(t.appDb, 'lena@example.com', 'Lena Auditor', ['auditor']);
  u.ada = await provisionActor(t.appDb, 'ada@example.com', 'Ada Admin', ['admin']);
  u.agus = await provisionActor(t.appDb, 'agus@example.com', 'Agus Receiver', ['receiver']);
  s.office = await newSupplier('Example Office Supplies Ltd');
  s.parts = await newSupplier('Sample Industrial Parts Co');
  s.pending = await newSupplier('Pending Review Trading', false);
  data(
    await run(u.ada, publishApprovalPolicy, {
      documentType: 'requisition',
      name: 'One step',
      rules: [{ departmentCode: null, minAmount: '0', maxAmount: null, steps: [APPROVER] }],
    }),
  );
  await setRules(DEFAULT_RULES);
});

afterAll(async () => {
  await t?.drop();
});

/** PO-I1 after every test: each requisition line's ordered quantity is what its live orders hold. Then the default rules again. */
afterEach(async () => {
  const { rows } = await t.pool.query(`
    SELECT r.id, r.ordered_qty::text AS ordered, coalesce(sum(CASE WHEN po.status = 'closed' THEN least(l.quantity, l.received_qty) ELSE l.quantity END)
      FILTER (WHERE po.status NOT IN ('cancelled', 'rejected')), 0)::text AS expected
    FROM requisition_lines r
    LEFT JOIN purchase_order_lines l ON l.requisition_line_id = r.id
    LEFT JOIN purchase_orders po ON po.id = l.purchase_order_id
    GROUP BY r.id, r.ordered_qty
    HAVING r.ordered_qty <> coalesce(sum(CASE WHEN po.status = 'closed' THEN least(l.quantity, l.received_qty) ELSE l.quantity END)
      FILTER (WHERE po.status NOT IN ('cancelled', 'rejected')), 0)`);
  expect(rows).toEqual([]);
  await setRules(DEFAULT_RULES);
});

// Estimated total 860.00: 4 × 180 + 4 × 35.
const LINES = [
  { description: 'Ergonomic office chair', quantity: '4', uom: 'pcs', estimatedUnitPrice: '180' },
  { description: 'Chair mat', quantity: '4', uom: 'pcs', estimatedUnitPrice: '35' },
];

type Requisition = { requisitionId: string; number: string; lineIds: string[] };

async function approvedRequisition(lines: typeof LINES = LINES, title = 'Office chairs'): Promise<Requisition> {
  const created = data(await run(u.rina, createRequisition, { title, justification: null, neededBy: '2030-06-30', lines }));
  const submitted = data(await run(u.rina, submitRequisition, { requisitionId: created.requisitionId, expectedVersion: 1 }));
  data(await run(u.bayu, decideApproval, { approvalRequestId: submitted.approvalRequestId, stepNo: 1, expectedVersion: 1, decision: 'approve' }));
  const lineIds = (await t.pool.query('SELECT id FROM requisition_lines WHERE requisition_id = $1 ORDER BY line_no', [created.requisitionId])).rows.map((r) => r.id as string);
  return { requisitionId: created.requisitionId, number: created.number, lineIds };
}

type LineSpec = { quantity: string; unitPrice?: string; taxRatePct?: string; quotationLineId?: string | null };

/** A direct order: by default 2 chairs at 175 and 4 mats at 33.333, both taxed. */
function poInput(pr: Requisition, overrides: Record<string, unknown> = {}, lines: (LineSpec | null)[] = [{ quantity: '2', unitPrice: '175', taxRatePct: '11' }, { quantity: '4', unitPrice: '33.333', taxRatePct: '12.5' }]) {
  return {
    requisitionId: pr.requisitionId,
    supplierId: s.office,
    paymentTerms: 'Net 30',
    deliveryAddress: '1 Example Plaza, Springfield',
    expectedDeliveryDate: '2030-05-15',
    lines: lines.flatMap((line, i) => (line ? [{ requisitionLineId: pr.lineIds[i], taxRatePct: '0', ...line }] : [])),
    ...overrides,
  };
}

/** The same fields for po.update, which takes neither the requisition nor the supplier. */
function editInput(pr: Requisition, purchaseOrderId: string, expectedVersion: number, overrides: Record<string, unknown> = {}, lines?: (LineSpec | null)[]) {
  const { paymentTerms, deliveryAddress, expectedDeliveryDate, lines: items } = poInput(pr, {}, lines);
  return { purchaseOrderId, expectedVersion, paymentTerms, deliveryAddress, expectedDeliveryDate, lines: items, ...overrides };
}

async function created(pr: Requisition, overrides: Record<string, unknown> = {}, lines?: (LineSpec | null)[], as = u.dewi): Promise<{ purchaseOrderId: string; number: string }> {
  return data(await run(as, createPurchaseOrder, poInput(pr, overrides, lines)));
}

const get = async (as: string, purchaseOrderId: string, clock?: Clock) => data(await run(as, getPurchaseOrder, { purchaseOrderId }, clock));
const versionOf = async (purchaseOrderId: string) => (await t.pool.query('SELECT version FROM purchase_orders WHERE id = $1', [purchaseOrderId])).rows[0].version as number;
const statusOf = async (purchaseOrderId: string) => (await t.pool.query('SELECT status FROM purchase_orders WHERE id = $1', [purchaseOrderId])).rows[0].status as string;
const ordered = async (lineId: string) => (await t.pool.query('SELECT ordered_qty::text AS q FROM requisition_lines WHERE id = $1', [lineId])).rows[0].q as string;
const auditOf = async (entityId: string) =>
  (await t.pool.query('SELECT action, actor_user_id AS actor, changes, reason FROM audit_events WHERE entity_id = $1 ORDER BY id', [entityId])).rows;
const poCount = async () => (await t.pool.query('SELECT count(*)::int AS n FROM purchase_orders')).rows[0].n as number;

const submit = async (purchaseOrderId: string, as = u.dewi, clock?: Clock) => run(as, submitPurchaseOrder, { purchaseOrderId, expectedVersion: await versionOf(purchaseOrderId) }, clock);
const issue = async (purchaseOrderId: string, as = u.dewi) => run(as, issuePurchaseOrder, { purchaseOrderId, expectedVersion: await versionOf(purchaseOrderId) });
const cancel = async (purchaseOrderId: string, reason: unknown = 'No longer needed', as = u.dewi) =>
  run(as, cancelPurchaseOrder, { purchaseOrderId, expectedVersion: await versionOf(purchaseOrderId), reason });
const close = async (purchaseOrderId: string, reason: unknown = 'Supplier cannot deliver the rest', as = u.dewi) =>
  run(as, closePurchaseOrder, { purchaseOrderId, expectedVersion: await versionOf(purchaseOrderId), reason });

/** The pending step of the order's current round, decided by `as`. */
async function decide(purchaseOrderId: string, as: string, decision: 'approve' | 'reject' | 'return', comment?: string) {
  const { rows } = await t.pool.query(
    `SELECT r.id, r.version, s.step_no FROM purchase_orders po JOIN approval_requests r ON r.id = po.current_approval_request_id
     JOIN approval_steps s ON s.approval_request_id = r.id AND s.status = 'pending' WHERE po.id = $1`,
    [purchaseOrderId],
  );
  const step = rows[0];
  if (!step) throw new Error(`purchase order ${purchaseOrderId} has no pending step`);
  return run(as, decideApproval, { approvalRequestId: step.id, stepNo: step.step_no, expectedVersion: step.version, decision, ...(comment ? { comment } : {}) });
}

/** An approved order (below the threshold, so no approval round): 1 chair at 175. */
async function approvedOrder(pr?: Requisition): Promise<{ pr: Requisition; purchaseOrderId: string }> {
  const requisition = pr ?? (await approvedRequisition());
  const { purchaseOrderId } = await created(requisition, {}, [{ quantity: '1', unitPrice: '175' }, null]);
  expect(data(await submit(purchaseOrderId)).status).toBe('approved');
  return { pr: requisition, purchaseOrderId };
}

/** An RFQ for the whole requisition from office and parts, closed; parts (816.00) is the lowest. */
async function awardedRfq(pr: Requisition, awardTo: 'office' | 'parts' = 'parts', awardedBy = u.dewi, validUntil = '2030-03-31') {
  const rfq = data(
    await run(u.dewi, createRfq, {
      requisitionId: pr.requisitionId,
      title: 'Chairs',
      responseDueAt: '2030-03-15T17:00',
      lines: pr.lineIds.map((requisitionLineId) => ({ requisitionLineId, quantity: '4' })),
      supplierIds: [s.office, s.parts],
    }),
  );
  data(await run(u.dewi, issueRfq, { rfqId: rfq.rfqId, expectedVersion: 1 }));
  const rfqLines = data(await run(u.dewi, getRfq, { rfqId: rfq.rfqId })).lines.map((l) => l.id);
  const quotations: Record<'office' | 'parts', string> = { office: '', parts: '' };
  for (const [name, prices] of [
    ['office', ['175', '32']],
    ['parts', ['168', '36']],
  ] as const) {
    const recorded = data(
      await run(u.dewi, recordQuotation, {
        rfqId: rfq.rfqId,
        supplierId: s[name],
        supplierReference: `${name.toUpperCase()}-Q1`,
        validUntil,
        leadTimeDays: 10,
        lines: rfqLines.map((rfqLineId, i) => ({ rfqLineId, unitPrice: prices[i] })),
      }),
    );
    data(await run(u.dewi, submitQuotation, { quotationId: recorded.quotationId, expectedVersion: 1 }));
    quotations[name] = recorded.quotationId;
  }
  data(await run(u.dewi, closeRfq, { rfqId: rfq.rfqId, expectedVersion: 2 }));
  data(
    await run(awardedBy, awardQuotation, {
      rfqId: rfq.rfqId,
      quotationId: quotations[awardTo],
      expectedVersion: 3,
      ...(awardTo === 'office' ? { justification: 'Faster delivery' } : {}),
    }),
  );
  const lineOf = async (quotationId: string) =>
    (await t.pool.query('SELECT ql.id FROM quotation_lines ql JOIN rfq_lines rl ON rl.id = ql.rfq_line_id WHERE ql.quotation_id = $1 ORDER BY rl.line_no', [quotationId])).rows.map(
      (r) => r.id as string,
    );
  return { rfqId: rfq.rfqId, rfqNumber: rfq.number, quotations, awardedLines: await lineOf(quotations[awardTo]), otherLines: await lineOf(quotations[awardTo === 'parts' ? 'office' : 'parts']) };
}

describe('P7-AC3: approval policies for purchase orders', () => {
  it('without a published policy, a PO that needs approval cannot be submitted; publishing one is versioned and audited separately from requisitions', async () => {
    const pr = await approvedRequisition();
    const { purchaseOrderId } = await created(pr, {}, [{ quantity: '4', unitPrice: '180', taxRatePct: '11' }, null]); // 799.20: below 1000
    data(await run(u.dewi, updatePurchaseOrderDraft, editInput(pr, purchaseOrderId, 1, {}, [{ quantity: '4', unitPrice: '250', taxRatePct: '11' }, null])));
    const before = await auditOf(purchaseOrderId);
    expect(rule(await submit(purchaseOrderId))).toBe('NO_APPROVAL_ROUTE');
    expect(await statusOf(purchaseOrderId)).toBe('draft');
    expect(await auditOf(purchaseOrderId)).toEqual(before);
    expect((await t.pool.query("SELECT count(*)::int AS n FROM approval_requests WHERE document_type = 'purchase_order'")).rows[0].n).toBe(0);

    expect(data(await run(u.ada, getActiveApprovalPolicy, { documentType: 'purchase_order' }))).toBeNull();
    const published = data(
      await run(u.ada, publishApprovalPolicy, {
        documentType: 'purchase_order',
        name: 'PO approvals',
        rules: [
          { departmentCode: null, minAmount: '0', maxAmount: '5000', steps: [FINANCE] },
          { departmentCode: null, minAmount: '5000', maxAmount: null, steps: [APPROVER, FINANCE] },
        ],
      }),
    );
    expect(published).toEqual({ policyId: expect.any(String), versionNo: 1 });
    expect(data(await run(u.ada, getActiveApprovalPolicy, { documentType: 'purchase_order' }))).toMatchObject({ versionNo: 1, name: 'PO approvals' });
    expect(data(await run(u.ada, listApprovalPolicyVersions, { documentType: 'purchase_order' }))).toHaveLength(1);
    // The requisition policy is a separate series, still at version 1.
    expect(data(await run(u.ada, getActiveApprovalPolicy, { documentType: 'requisition' }))).toMatchObject({ versionNo: 1, name: 'One step' });
    expect((await auditOf(published.policyId)).at(-1)).toMatchObject({ action: 'approvalPolicy.published', changes: { documentType: [null, 'purchase_order'], versionNo: [null, 1] } });

    expect(data(await submit(purchaseOrderId))).toMatchObject({ status: 'pending_approval', approvalReasons: ['AMOUNT_THRESHOLD', 'PRICE_VARIANCE', 'TOTAL_VARIANCE'], round: 1 });
  });
});

describe('P7-AC4 / P7-AC10: creating a purchase order (PO-T01)', () => {
  it('creates a draft priced by the server (ADR 0007, tax per line), reserves the quantities, and audits it', async () => {
    const pr = await approvedRequisition();
    const result = data(await run(u.dewi, createPurchaseOrder, { ...poInput(pr), paymentTerms: '  Net 30 ', deliveryAddress: '' }));
    expect(result).toEqual({ purchaseOrderId: expect.any(String), number: expect.stringMatching(/^PO-\d{4}-\d{6}$/), version: 1, total: '538.50' });
    const po = await get(u.dewi, result.purchaseOrderId);
    // 2 × 175 = 350.00 + 11 % = 38.50; 4 × 33.333 = 133.332 → 133.33 + 12.5 % = 16.66625 → 16.67.
    expect(po).toMatchObject({
      status: 'draft',
      requisitionNumber: pr.number,
      requisitionTitle: 'Office chairs',
      departmentCode: 'OPS',
      supplier: { legalName: 'Example Office Supplies Ltd', status: 'active', addressLines: ['700 Example Way', '00070 Springfield'], countryCode: 'US' },
      quotation: null,
      currencyCode: 'USD',
      currencyScale: 2,
      subtotal: '483.33',
      taxTotal: '55.17',
      total: '538.50',
      paymentTerms: 'Net 30',
      deliveryAddress: null,
      expectedDeliveryDate: '2030-05-15',
      approvalReasons: [],
      createdBy: 'Dewi Procurement',
      version: 1,
      callerActions: ['edit', 'submit', 'cancel'],
    });
    expect(po.lines).toEqual([
      expect.objectContaining({
        lineNo: 1,
        requisitionLineNo: 1,
        description: 'Ergonomic office chair',
        uom: 'pcs',
        quantity: '2',
        unitPrice: '175',
        estimatedUnitPrice: '180',
        taxRatePct: '11',
        lineSubtotal: '350.00',
        lineTax: '38.50',
        lineTotal: '388.50',
        receivedQty: '0',
        maxReceivableQty: null,
      }),
      expect.objectContaining({ lineNo: 2, requisitionLineNo: 2, description: 'Chair mat', quantity: '4', unitPrice: '33.333', taxRatePct: '12.5', lineSubtotal: '133.33', lineTax: '16.67', lineTotal: '150.00' }),
    ]);
    expect(await ordered(pr.lineIds[0] as string)).toBe('2.000');
    expect(await ordered(pr.lineIds[1] as string)).toBe('4.000');
    expect((await auditOf(result.purchaseOrderId)).at(-1)).toEqual({
      action: 'po.created',
      actor: u.dewi,
      reason: null,
      changes: {
        number: [null, result.number],
        requisitionNumber: [null, pr.number],
        supplier: [null, expect.stringMatching(/^SUP-\d{6} Example Office Supplies Ltd$/)],
        paymentTerms: [null, 'Net 30'],
        expectedDeliveryDate: [null, '2030-05-15'],
        currencyCode: [null, 'USD'],
        lines: [null, ['1. 2 pcs Ergonomic office chair @ 175, tax 11% = 388.50 (requisition line 1)', '2. 4 pcs Chair mat @ 33.333, tax 12.5% = 150.00 (requisition line 2)']],
        subtotal: [null, '483.33'],
        taxTotal: [null, '55.17'],
        total: [null, '538.50'],
        status: [null, 'draft'],
      },
    });
  });

  it('refuses server-only and malformed fields with nothing written', async () => {
    const pr = await approvedRequisition();
    const base = poInput(pr);
    const line = base.lines[0] as Record<string, unknown>;
    const before = await poCount();
    const bad: Record<string, unknown>[] = [
      { total: '1.00' },
      { subtotal: '1.00' },
      { taxTotal: '0' },
      { status: 'approved' },
      { number: 'PO-2030-000001' },
      { currencyCode: 'EUR' },
      { departmentId: pr.requisitionId },
      { createdByUserId: u.dewi },
      { approvalReasons: [] },
      { foo: 'bar' },
      { paymentTerms: 'x'.repeat(501) },
      { deliveryAddress: 'x'.repeat(501) },
      { expectedDeliveryDate: '2030-02-30' },
      { expectedDeliveryDate: '15/05/2030' },
      { lines: [] },
      { lines: [line, line] },
      ...['description', 'uom', 'lineSubtotal', 'lineTax', 'lineTotal', 'receivedQty', 'maxReceivableQty'].map((field) => ({ lines: [{ ...line, [field]: '1' }] })),
      { lines: [{ ...line, unitPrice: 175 }] },
      { lines: [{ ...line, quantity: 2 }] },
      { lines: [{ ...line, quantity: '0' }] },
      { lines: [{ ...line, quantity: '1,5' }] },
      { lines: [{ ...line, taxRatePct: '100.0001' }] },
      { lines: [{ ...line, taxRatePct: 11 }] },
      { lines: [{ ...line, taxRatePct: '' }] },
      { lines: [{ requisitionLineId: line.requisitionLineId, quantity: '1', unitPrice: '1' }] },
      { lines: Array.from({ length: 201 }, () => line) },
    ];
    for (const change of bad) {
      expect({ change, result: rule(await run(u.dewi, createPurchaseOrder, { ...base, ...change })) }).toEqual({ change, result: 'VALIDATION_FAILED' });
    }
    expect(await poCount()).toBe(before);
    expect(await ordered(pr.lineIds[0] as string)).toBe('0.000');
  });

  it('names the field for a line of another requisition, a missing price, and a quotation line without a quotation', async () => {
    const pr = await approvedRequisition();
    const other = await approvedRequisition();
    const failure = async (lines: Record<string, unknown>[]) => {
      const result = await run(u.dewi, createPurchaseOrder, { ...poInput(pr), lines });
      return result.ok ? 'ok' : result.error.fieldErrors;
    };
    expect(await failure([{ requisitionLineId: other.lineIds[0], quantity: '1', unitPrice: '1', taxRatePct: '0' }])).toEqual({
      'lines.0.requisitionLineId': [`This line is not on requisition ${pr.number}.`],
    });
    expect(await failure([{ requisitionLineId: pr.lineIds[0], quantity: '1', taxRatePct: '0' }])).toEqual({ 'lines.0.unitPrice': ['Enter a unit price'] });
    expect(await failure([{ requisitionLineId: pr.lineIds[0], quotationLineId: pr.lineIds[1], quantity: '1', unitPrice: '1', taxRatePct: '0' }])).toEqual({
      'lines.0.quotationLineId': ['This purchase order is not from a quotation.'],
    });
  });

  it('orders only from an approved requisition and an active supplier', async () => {
    const lineOf = async (requisitionId: string) =>
      (await t.pool.query('SELECT id FROM requisition_lines WHERE requisition_id = $1 ORDER BY line_no', [requisitionId])).rows.map((r) => r.id as string);
    const draft = data(await run(u.rina, createRequisition, { title: 'Draft', justification: null, neededBy: '2030-06-30', lines: LINES }));
    const pending = data(await run(u.rina, createRequisition, { title: 'Pending', justification: null, neededBy: '2030-06-30', lines: LINES }));
    data(await run(u.rina, submitRequisition, { requisitionId: pending.requisitionId, expectedVersion: 1 }));
    const closed = await approvedRequisition();
    data(await run(u.dewi, closeRequisition, { requisitionId: closed.requisitionId, expectedVersion: 3, reason: 'Bought elsewhere' }));
    const cancelled = await approvedRequisition();
    data(await run(u.rina, cancelRequisition, { requisitionId: cancelled.requisitionId, expectedVersion: 3, reason: 'Not needed' }));
    for (const pr of [
      { requisitionId: draft.requisitionId, number: draft.number, lineIds: await lineOf(draft.requisitionId) },
      { requisitionId: pending.requisitionId, number: pending.number, lineIds: await lineOf(pending.requisitionId) },
      closed,
      cancelled,
    ]) {
      expect(rule(await run(u.dewi, createPurchaseOrder, poInput(pr)))).toBe('REQUISITION_NOT_APPROVED');
    }
    expect(rule(await run(u.dewi, createPurchaseOrder, poInput({ ...closed, requisitionId: '01900000-0000-7000-8000-000000000000' })))).toBe('NOT_FOUND');
    const pr = await approvedRequisition();
    expect(rule(await run(u.dewi, createPurchaseOrder, poInput(pr, { supplierId: s.pending })))).toBe('SUPPLIER_NOT_ACTIVE');
    expect(rule(await run(u.dewi, createPurchaseOrder, poInput(pr, { supplierId: '01900000-0000-7000-8000-000000000000' })))).toBe('SUPPLIER_NOT_ACTIVE');
    const blocked = await newSupplier('Blocked Before Ordering Ltd');
    await block(blocked);
    expect(rule(await run(u.dewi, createPurchaseOrder, poInput(pr, { supplierId: blocked })))).toBe('SUPPLIER_NOT_ACTIVE');
    for (const as of [u.rina, u.bayu, u.sari, u.lena, u.ada, u.agus]) expect(rule(await run(as, createPurchaseOrder, poInput(pr)))).toBe('FORBIDDEN');
    expect(await ordered(pr.lineIds[0] as string)).toBe('0.000');
  });

  it('OVER_ORDER: never more than the requisition line asks for, across orders, with fractional quantities', async () => {
    const pr = await approvedRequisition();
    await created(pr, {}, [{ quantity: '2.5', unitPrice: '175' }, null]);
    await created(pr, {}, [{ quantity: '1.5', unitPrice: '175' }, { quantity: '4', unitPrice: '30' }]);
    expect(await ordered(pr.lineIds[0] as string)).toBe('4.000');
    const result = await run(u.dewi, createPurchaseOrder, poInput(pr, {}, [{ quantity: '0.001', unitPrice: '175' }, { quantity: '0.5', unitPrice: '30' }]));
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'BUSINESS_RULE',
        rule: 'OVER_ORDER',
        message: 'Requisition line 1 has only 0 pcs left to order.',
        details: [
          { lineNo: 1, remaining: '0' },
          { lineNo: 2, remaining: '0' },
        ],
      },
    });
    expect(await ordered(pr.lineIds[1] as string)).toBe('4.000');
  });

  it('RFQ_REQUIRED from the RFQ threshold (estimate at it: required; one cent above it: direct orders allowed)', async () => {
    const pr = await approvedRequisition(); // estimated 860.00
    await setRules({ rfqRequiredAbove: '860' });
    expect(await run(u.dewi, createPurchaseOrder, poInput(pr))).toMatchObject({
      ok: false,
      error: { rule: 'RFQ_REQUIRED', message: `Requisition ${pr.number} is estimated at 860.00 USD, at or above 860.00 USD: order it from an awarded quotation.` },
    });
    await setRules({ rfqRequiredAbove: '860.01' });
    expect(rule(await run(u.dewi, createPurchaseOrder, poInput(pr)))).toBe('ok');
    await setRules(DEFAULT_RULES);
  });

  it('from an awarded quotation: its supplier, its lines, and its prices (client prices ignored), never more than quoted', async () => {
    const pr = await approvedRequisition();
    const rfq = await awardedRfq(pr);
    await setRules({ rfqRequiredAbove: '500' });
    const chairs = (spec: Partial<LineSpec> = {}): LineSpec => ({ quantity: '4', unitPrice: '1', taxRatePct: '11', quotationLineId: rfq.awardedLines[0] as string, ...spec });
    const fromQuote = (lines: (LineSpec | null)[], overrides: Record<string, unknown> = {}, clock?: Clock) =>
      run(u.fajar, createPurchaseOrder, poInput(pr, { supplierId: s.parts, quotationId: rfq.quotations.parts, ...overrides }, lines), clock);

    const result = data(await fromQuote([chairs()]));
    const po = await get(u.fajar, result.purchaseOrderId);
    // 4 × 168 (quoted), not 4 × 1 (sent): 672.00 + 11 % = 73.92.
    expect(po).toMatchObject({ total: '745.92', quotation: { id: rfq.quotations.parts, rfqNumber: rfq.rfqNumber, supplierReference: 'PARTS-Q1', validUntil: '2030-03-31' } });
    expect(po.lines).toEqual([expect.objectContaining({ unitPrice: '168', quotationLineId: rfq.awardedLines[0], lineSubtotal: '672.00' })]);
    expect((await auditOf(result.purchaseOrderId)).at(-1).changes.quotation).toEqual([null, rfq.rfqNumber]);

    const mats = (spec: Partial<LineSpec> = {}): LineSpec => ({ quantity: '1', taxRatePct: '0', quotationLineId: rfq.awardedLines[1] as string, ...spec });
    expect(await fromQuote([null, mats()], { supplierId: s.office })).toMatchObject({ ok: false, error: { fieldErrors: { supplierId: ['The quotation is from another supplier.'] } } });
    expect(await fromQuote([null, mats({ quotationLineId: null })])).toMatchObject({ ok: false, error: { fieldErrors: { 'lines.0.quotationLineId': ['Requisition line 2 is not on this quotation.'] } } });
    // The other supplier's line, and the chair line for the mats.
    expect(await fromQuote([null, mats({ quotationLineId: rfq.otherLines[1] as string })])).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    expect(await fromQuote([null, mats({ quotationLineId: rfq.awardedLines[0] as string })])).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    expect(await fromQuote([null, mats({ quantity: '4.001' })])).toMatchObject({ ok: false, error: { rule: 'QUANTITY_EXCEEDS_QUOTED', details: [{ lineNo: 2, quoted: '4' }] } });
    // The chairs are fully ordered now: another order of them is OVER_ORDER, also from the quotation.
    expect(rule(await fromQuote([chairs({ quantity: '1' })]))).toBe('OVER_ORDER');
    // The quotation that was not awarded, an expired one (valid through its last day), and one of another requisition.
    expect(rule(await fromQuote([null, mats({ quotationLineId: rfq.otherLines[1] as string })], { supplierId: s.office, quotationId: rfq.quotations.office }))).toBe('QUOTATION_NOT_AWARDED');
    expect(rule(await fromQuote([null, mats()], {}, fixedClock('2030-04-01T00:00:00Z')))).toBe('QUOTATION_EXPIRED');
    expect(rule(await fromQuote([null, mats()], {}, fixedClock('2030-03-31T23:59:59Z')))).toBe('ok');
    const other = await approvedRequisition();
    expect(await run(u.fajar, createPurchaseOrder, poInput(other, { supplierId: s.parts, quotationId: rfq.quotations.parts }, [{ quantity: '1', taxRatePct: '0' }]))).toMatchObject({
      ok: false,
      error: { fieldErrors: { quotationId: [`This quotation is not for requisition ${other.number}.`] } },
    });
    await setRules(DEFAULT_RULES);
  });

  it('is idempotent per user and key; the same key with another input is refused', async () => {
    const pr = await approvedRequisition();
    const input = { ...poInput(pr, {}, [{ quantity: '1', unitPrice: '175' }, null]), idempotencyKey: 'po-create-key-1' };
    const first = data(await run(u.dewi, createPurchaseOrder, input));
    expect(data(await run(u.dewi, createPurchaseOrder, input))).toEqual(first);
    expect(rule(await run(u.dewi, createPurchaseOrder, { ...input, paymentTerms: 'Net 60' }))).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await t.pool.query('SELECT count(*)::int AS n FROM purchase_orders WHERE requisition_id = $1', [pr.requisitionId])).rows[0].n).toBe(1);
    expect(await ordered(pr.lineIds[0] as string)).toBe('1.000');
  });
});

describe('P7-AC4: editing a draft (PO-T02)', () => {
  it('only the creator edits; quantity changes are re-reserved (more, less, a line added or removed), audited field by field', async () => {
    const pr = await approvedRequisition();
    const { purchaseOrderId } = await created(pr, {}, [{ quantity: '2', unitPrice: '175', taxRatePct: '11' }, null]);
    const edit = (as: string, version: number, overrides: Record<string, unknown>, lines?: (LineSpec | null)[]) => run(as, updatePurchaseOrderDraft, editInput(pr, purchaseOrderId, version, overrides, lines));

    expect(rule(await edit(u.fajar, 1, {}, [{ quantity: '3', unitPrice: '175' }, null]))).toBe('FORBIDDEN');
    expect(rule(await edit(u.dewi, 2, {}, [{ quantity: '3', unitPrice: '175' }, null]))).toBe('CONFLICT');
    // More chairs, and the mats added.
    expect(data(await edit(u.dewi, 1, { paymentTerms: 'Net 45' }, [{ quantity: '3', unitPrice: '175', taxRatePct: '11' }, { quantity: '1', unitPrice: '35' }]))).toEqual({ version: 2, total: '617.75' });
    expect([await ordered(pr.lineIds[0] as string), await ordered(pr.lineIds[1] as string)]).toEqual(['3.000', '1.000']);
    expect((await auditOf(purchaseOrderId)).at(-1)).toMatchObject({
      action: 'po.updated',
      actor: u.dewi,
      changes: {
        paymentTerms: ['Net 30', 'Net 45'],
        lines: [
          ['1. 2 pcs Ergonomic office chair @ 175, tax 11% = 388.50 (requisition line 1)'],
          ['1. 3 pcs Ergonomic office chair @ 175, tax 11% = 582.75 (requisition line 1)', '2. 1 pcs Chair mat @ 35, tax 0% = 35.00 (requisition line 2)'],
        ],
        subtotal: ['350.00', '560.00'],
        taxTotal: ['38.50', '57.75'],
        total: ['388.50', '617.75'],
      },
    });
    // Beyond what is left (another order holds 1 chair): nothing changes.
    await created(pr, {}, [{ quantity: '1', unitPrice: '175' }, null], u.fajar);
    expect(await edit(u.dewi, 2, {}, [{ quantity: '3.001', unitPrice: '175', taxRatePct: '11' }, { quantity: '1', unitPrice: '35' }])).toMatchObject({
      ok: false,
      error: { rule: 'OVER_ORDER', details: [{ lineNo: 1, remaining: '0' }] },
    });
    expect(await ordered(pr.lineIds[0] as string)).toBe('4.000');
    expect(await versionOf(purchaseOrderId)).toBe(2);
    // Fewer chairs and the mats removed: both are given back.
    expect(data(await edit(u.dewi, 2, { paymentTerms: 'Net 45' }, [{ quantity: '0.5', unitPrice: '175', taxRatePct: '11' }, null])).version).toBe(3);
    expect([await ordered(pr.lineIds[0] as string), await ordered(pr.lineIds[1] as string)]).toEqual(['1.500', '0.000']);
    // Unchanged: nothing written.
    const events = (await auditOf(purchaseOrderId)).length;
    expect(data(await edit(u.dewi, 3, { paymentTerms: 'Net 45' }, [{ quantity: '0.500', unitPrice: '175.0000', taxRatePct: '11.0' }, null]))).toEqual({ version: 3, total: '97.13' });
    expect((await auditOf(purchaseOrderId)).length).toBe(events);
    // Not after submitting, and not once the requisition is closed.
    data(await submit(purchaseOrderId));
    expect(rule(await edit(u.dewi, 4, {}, [{ quantity: '1', unitPrice: '175' }, null]))).toBe('INVALID_TRANSITION');
    const other = await approvedRequisition();
    const draft = await created(other, {}, [{ quantity: '1', unitPrice: '175' }, null]);
    data(await run(u.dewi, closeRequisition, { requisitionId: other.requisitionId, expectedVersion: 3, reason: 'Bought elsewhere' }));
    expect(rule(await run(u.dewi, updatePurchaseOrderDraft, editInput(other, draft.purchaseOrderId, 1, {}, [{ quantity: '2', unitPrice: '175' }, null])))).toBe('REQUISITION_NOT_APPROVED');
  });

  it('with a quotation, edits keep the quoted prices whatever the client sends', async () => {
    const pr = await approvedRequisition();
    const rfq = await awardedRfq(pr);
    const { purchaseOrderId } = await created(pr, { supplierId: s.parts, quotationId: rfq.quotations.parts }, [{ quantity: '1', taxRatePct: '0', quotationLineId: rfq.awardedLines[0] as string }]);
    data(
      await run(
        u.dewi,
        updatePurchaseOrderDraft,
        editInput(pr, purchaseOrderId, 1, {}, [
          { quantity: '2', unitPrice: '0.01', taxRatePct: '0', quotationLineId: rfq.awardedLines[0] as string },
          { quantity: '1', unitPrice: '0.01', taxRatePct: '0', quotationLineId: rfq.awardedLines[1] as string },
        ]),
      ),
    );
    expect((await get(u.dewi, purchaseOrderId)).lines.map((l) => [l.unitPrice, l.lineTotal])).toEqual([
      ['168', '336.00'],
      ['36', '36.00'],
    ]);
  });
});

describe('P7-AC5: submitting (PO-T03), the approval requirement at its edges', () => {
  /** A one-line order of chairs (estimate 180, 10 requested) at `unitPrice`, `quantity`, with `taxRatePct`. */
  async function draftOf(unitPrice: string, quantity = '1', taxRatePct = '0'): Promise<string> {
    const pr = await approvedRequisition([{ ...LINES[0], quantity: '10' } as (typeof LINES)[number], LINES[1] as (typeof LINES)[number]]);
    return (await created(pr, {}, [{ quantity, unitPrice, taxRatePct }, null])).purchaseOrderId;
  }

  it('below the threshold and within the tolerance: approved at once, audited as BELOW_THRESHOLD, with the rule stored', async () => {
    // 5 × 189 (the estimate 180 + 5 %) = 945.00, + 5.8 % tax = 54.81: 999.81, under the threshold of 1000.
    const below = await draftOf('189', '5', '5.8');
    expect(data(await submit(below))).toEqual({ version: 2, status: 'approved', approvalReasons: [], approvalRequestId: null, round: null });
    const po = await get(u.dewi, below);
    expect(po).toMatchObject({ status: 'approved', total: '999.81', approvalReasons: [], approvalThreshold: '1000', priceTolerancePct: '5', submittedBy: 'Dewi Procurement', approvedAt: expect.any(String), approvalHistory: [] });
    expect((await auditOf(below)).at(-1)).toEqual({
      action: 'po.submitted',
      actor: u.dewi,
      reason: 'BELOW_THRESHOLD',
      changes: { status: ['draft', 'approved'], approvalReasons: [null, []], approvalThreshold: [null, '1000'], priceTolerancePct: [null, '5'] },
    });
    expect((await t.pool.query("SELECT count(*)::int AS n FROM approval_requests WHERE document_id = $1", [below])).rows[0].n).toBe(0);
  });

  it('AMOUNT_THRESHOLD from the threshold itself (tax included); PRICE_VARIANCE above estimate × (1 + tolerance), not at it', async () => {
    // 5 × 189 = 945.00 + 55 = 1000.00 exactly.
    const atThreshold = await draftOf('189', '5', '5.8201');
    expect((await get(u.dewi, atThreshold)).total).toBe('1000.00');
    expect(data(await submit(atThreshold))).toMatchObject({ status: 'pending_approval', approvalReasons: ['AMOUNT_THRESHOLD'], round: 1 });
    // 180 × 1.05 = 189: at the limit no variance, 0.0001 above it a variance.
    expect(data(await submit(await draftOf('189')))).toMatchObject({ status: 'approved', approvalReasons: [] });
    // The subtotal rounds to 189.00, which is not above 189: a price variance only.
    expect(data(await submit(await draftOf('189.0001')))).toMatchObject({ status: 'pending_approval', approvalReasons: ['PRICE_VARIANCE'] });
    // Both at once, in a fixed order.
    expect(data(await submit(await draftOf('250', '4')))).toMatchObject({ approvalReasons: ['AMOUNT_THRESHOLD', 'PRICE_VARIANCE', 'TOTAL_VARIANCE'] });
    // Tolerance 0: any price above the estimate.
    await setRules({ tolerance: '0' });
    expect(data(await submit(await draftOf('180.0001')))).toMatchObject({ approvalReasons: ['PRICE_VARIANCE'] });
    expect(data(await submit(await draftOf('180.01')))).toMatchObject({ approvalReasons: ['PRICE_VARIANCE', 'TOTAL_VARIANCE'] });
    expect(data(await submit(await draftOf('180')))).toMatchObject({ status: 'approved' });
  });

  it('TOTAL_VARIANCE alone, from rounding: every price within the tolerance, the subtotal above the rounded estimate', async () => {
    // A washer estimated at 0.004 rounds to an estimate of 0.00; 0.005 is within 25 % but rounds to 0.01.
    const pr = await approvedRequisition([
      { description: 'Washer', quantity: '1', uom: 'pcs', estimatedUnitPrice: '0.004' },
      { description: 'Bolt box', quantity: '1', uom: 'box', estimatedUnitPrice: '10' },
    ]);
    await setRules({ tolerance: '25' });
    const { purchaseOrderId } = await created(pr, {}, [{ quantity: '1', unitPrice: '0.005' }, null]);
    expect(data(await submit(purchaseOrderId))).toMatchObject({ status: 'pending_approval', approvalReasons: ['TOTAL_VARIANCE'] });
    expect(await get(u.dewi, purchaseOrderId)).toMatchObject({ subtotal: '0.01', approvalReasons: ['TOTAL_VARIANCE'], priceTolerancePct: '25' });
  });

  it('NO_THRESHOLD: without a threshold every purchase order needs approval, even one of 0.01', async () => {
    await setRules({ threshold: null });
    const purchaseOrderId = await draftOf('0.01');
    expect(data(await submit(purchaseOrderId))).toMatchObject({ status: 'pending_approval', approvalReasons: ['NO_THRESHOLD'] });
    expect(await get(u.dewi, purchaseOrderId)).toMatchObject({ approvalThreshold: null, approvalReasons: ['NO_THRESHOLD'] });
  });

  it('opens an approval round with the route, the amount, and the reasons, audited', async () => {
    const purchaseOrderId = await draftOf('250', '4', '11'); // 1110.00
    const result = data(await submit(purchaseOrderId));
    expect(result).toMatchObject({ status: 'pending_approval', approvalRequestId: expect.any(String), round: 1 });
    const request = (await t.pool.query('SELECT * FROM approval_requests WHERE id = $1', [result.approvalRequestId])).rows[0];
    expect(request).toMatchObject({ document_type: 'purchase_order', document_id: purchaseOrderId, status: 'pending', submitted_by_user_id: u.dewi, awarded_by_user_id: null, document_title: 'Office chairs' });
    expect(request.amount_snapshot).toBe('1110.0000');
    expect((await auditOf(purchaseOrderId)).at(-1)).toEqual({
      action: 'po.submitted',
      actor: u.dewi,
      reason: null,
      changes: {
        status: ['draft', 'pending_approval'],
        approvalReasons: [null, ['AMOUNT_THRESHOLD', 'PRICE_VARIANCE', 'TOTAL_VARIANCE']],
        approvalThreshold: [null, '1000'],
        priceTolerancePct: [null, '5'],
        round: [null, 1],
        approvalRoute: [null, ['1. Finance']],
      },
    });
    expect((await auditOf(result.approvalRequestId as string)).at(-1)).toMatchObject({ action: 'approval.requested' });
    expect((await get(u.dewi, purchaseOrderId)).approvalHistory).toEqual([expect.objectContaining({ round: 1, status: 'pending', amount: '1110.00', submittedBy: 'Dewi Procurement' })]);
  });

  it('refuses: another buyer, a stale version, twice, a blocked supplier, a past delivery date, and no RFQ above the threshold', async () => {
    const purchaseOrderId = await draftOf('100');
    expect(rule(await submit(purchaseOrderId, u.fajar))).toBe('FORBIDDEN');
    expect(rule(await run(u.dewi, submitPurchaseOrder, { purchaseOrderId, expectedVersion: 2 }))).toBe('CONFLICT');
    data(await submit(purchaseOrderId));
    expect(rule(await submit(purchaseOrderId))).toBe('INVALID_TRANSITION');

    const supplier = await newSupplier('Blocked After Ordering Ltd');
    const pr = await approvedRequisition();
    const blocked = await created(pr, { supplierId: supplier }, [{ quantity: '1', unitPrice: '100' }, null]);
    await block(supplier);
    expect(rule(await submit(blocked.purchaseOrderId))).toBe('SUPPLIER_NOT_ACTIVE');

    const dated = await created(pr, { expectedDeliveryDate: '2030-01-10' }, [{ quantity: '1', unitPrice: '100' }, null]);
    expect(await submit(dated.purchaseOrderId, u.dewi, fixedClock('2030-01-11T00:00:00Z'))).toMatchObject({
      ok: false,
      error: { rule: 'DELIVERY_DATE_IN_PAST', message: 'The expected delivery date (2030-01-10) has passed. Set a later one before submitting.' },
    });
    expect(data(await submit(dated.purchaseOrderId, u.dewi, fixedClock('2030-01-10T23:59:59Z'))).status).toBe('approved');

    // Created as a direct order while no RFQ was needed; the threshold was lowered before submitting.
    const direct = await created(pr, {}, [null, { quantity: '1', unitPrice: '30' }]);
    await setRules({ rfqRequiredAbove: '860' });
    expect(rule(await submit(direct.purchaseOrderId))).toBe('RFQ_REQUIRED');
    expect(await statusOf(direct.purchaseOrderId)).toBe('draft');
  });

  it('the database recomputes the approval rule: a PO that needs approval cannot be approved on submit, and wrong reasons are refused', async () => {
    const needsApproval = await draftOf('250', '4');
    const attempt = (sql: string) => sqlStateOf(() => t.appPool.query(sql, [needsApproval, u.dewi]));
    const submitted = "submitted_at = now(), submitted_by_user_id = $2, approval_threshold = 1000, price_tolerance_pct = 5";
    expect(await attempt(`UPDATE purchase_orders SET status = 'approved', approved_at = now(), approval_reasons = '{}', ${submitted} WHERE id = $1`)).toBe('PFC01');
    expect(await attempt(`UPDATE purchase_orders SET status = 'approved', approved_at = now(), approval_reasons = '{}', submitted_at = now(), submitted_by_user_id = $2, approval_threshold = 2000, price_tolerance_pct = 100 WHERE id = $1`)).toBe('PFC01');
    const fine = await draftOf('100');
    expect(await sqlStateOf(() => t.appPool.query(`UPDATE purchase_orders SET status = 'approved', approved_at = now(), approval_reasons = '{AMOUNT_THRESHOLD}', ${submitted} WHERE id = $1`, [fine, u.dewi]))).toBe('PFC01');
    // Submitted by someone other than the creator.
    expect(await sqlStateOf(() => t.appPool.query(`UPDATE purchase_orders SET status = 'approved', approved_at = now(), approval_reasons = '{}', ${submitted} WHERE id = $1`, [fine, u.fajar]))).toBe('PFC01');
    // The same values the command would write are accepted.
    expect(await sqlStateOf(() => t.appPool.query(`UPDATE purchase_orders SET status = 'approved', approved_at = now(), approval_reasons = '{}', ${submitted} WHERE id = $1`, [fine, u.dewi]))).toBe('none');
  });
});

/** A PO of 4 chairs at 250 (1110.00 with tax): it needs approval (amount and price). */
async function pendingOrder(as = u.dewi, pr?: Requisition): Promise<{ pr: Requisition; purchaseOrderId: string }> {
  const requisition = pr ?? (await approvedRequisition());
  const { purchaseOrderId } = await created(requisition, {}, [{ quantity: '4', unitPrice: '250', taxRatePct: '11' }, null], as);
  expect(data(await submit(purchaseOrderId, as)).status).toBe('pending_approval');
  return { pr: requisition, purchaseOrderId };
}

describe('P7-AC6: approval outcomes (PO-T04)', () => {
  it('finance approves from the inbox: the order is approved, with its history', async () => {
    const { purchaseOrderId } = await pendingOrder();
    const inbox = data(await run(u.sari, approvalInbox, {})).items.filter((i) => i.documentId === purchaseOrderId);
    expect(inbox).toEqual([expect.objectContaining({ documentType: 'purchase_order', documentTitle: 'Office chairs', departmentCode: 'OPS', amount: '1110.00', label: 'Finance', submittedBy: 'Dewi Procurement' })]);
    expect((await get(u.sari, purchaseOrderId)).openDecision).toMatchObject({ stepNo: 1, stepCount: 1, label: 'Finance' });
    expect(data(await decide(purchaseOrderId, u.sari, 'approve', 'Prices checked'))).toMatchObject({ requestStatus: 'approved', documentType: 'purchase_order', documentId: purchaseOrderId, documentStatus: 'approved' });
    const po = await get(u.dewi, purchaseOrderId);
    expect(po).toMatchObject({ status: 'approved', approvedAt: expect.any(String), openDecision: null, callerActions: ['issue', 'cancel'] });
    expect(po.approvalHistory).toEqual([expect.objectContaining({ round: 1, status: 'approved', steps: [expect.objectContaining({ status: 'approved', decidedBy: 'Sari Finance', comment: 'Prices checked' })] })]);
    expect((await auditOf(purchaseOrderId)).at(-1)).toMatchObject({ action: 'po.approved', actor: u.sari, changes: { status: ['pending_approval', 'approved'] }, reason: 'Prices checked' });
  });

  it('return: back to a draft the creator can edit; resubmitting opens round 2 with a new snapshot', async () => {
    const { pr, purchaseOrderId } = await pendingOrder();
    expect(rule(await decide(purchaseOrderId, u.sari, 'return'))).toBe('VALIDATION_FAILED');
    expect(data(await decide(purchaseOrderId, u.sari, 'return', 'Ask for a better price')).documentStatus).toBe('draft');
    expect((await auditOf(purchaseOrderId)).at(-1)).toMatchObject({ action: 'po.returned', changes: { status: ['pending_approval', 'draft'] }, reason: 'Ask for a better price' });
    expect((await get(u.dewi, purchaseOrderId)).callerActions).toEqual(['edit', 'submit', 'cancel']);
    expect(await ordered(pr.lineIds[0] as string)).toBe('4.000'); // still reserved
    data(await run(u.dewi, updatePurchaseOrderDraft, editInput(pr, purchaseOrderId, await versionOf(purchaseOrderId), {}, [{ quantity: '4', unitPrice: '240', taxRatePct: '11' }, null])));
    expect(data(await submit(purchaseOrderId))).toMatchObject({ status: 'pending_approval', round: 2 });
    const history = (await get(u.dewi, purchaseOrderId)).approvalHistory;
    expect(history.map((r) => [r.round, r.status, r.amount])).toEqual([
      [1, 'returned', '1110.00'],
      [2, 'pending', '1065.60'],
    ]);
  });

  it('reject: terminal, and every reserved quantity goes back to the requisition', async () => {
    const pr = await approvedRequisition();
    const { purchaseOrderId } = await created(pr, {}, [{ quantity: '4', unitPrice: '250', taxRatePct: '11' }, { quantity: '2', unitPrice: '35' }]);
    data(await submit(purchaseOrderId));
    expect([await ordered(pr.lineIds[0] as string), await ordered(pr.lineIds[1] as string)]).toEqual(['4.000', '2.000']);
    expect(data(await decide(purchaseOrderId, u.sari, 'reject', 'Too expensive')).documentStatus).toBe('rejected');
    expect([await ordered(pr.lineIds[0] as string), await ordered(pr.lineIds[1] as string)]).toEqual(['0.000', '0.000']);
    expect((await auditOf(purchaseOrderId)).at(-1)).toMatchObject({
      action: 'po.rejected',
      changes: { status: ['pending_approval', 'rejected'], released: [null, ['2 pcs (requisition line 2)', '4 pcs (requisition line 1)']] },
      reason: 'Too expensive',
    });
    expect((await get(u.dewi, purchaseOrderId)).callerActions).toEqual([]);
    for (const attempt of [cancel(purchaseOrderId), issue(purchaseOrderId), close(purchaseOrderId), submit(purchaseOrderId)]) expect(rule(await attempt)).toBe('INVALID_TRANSITION');
    // The quantity is free for a new order.
    await created(pr, {}, [{ quantity: '4', unitPrice: '175' }, null]);
  });

  it('a department approver step: Bayu (OPS) can open and decide an OPS order, Nina (FIN) cannot see it', async () => {
    const pr = await approvedRequisition();
    const { purchaseOrderId } = await created(pr, {}, [{ quantity: '4', unitPrice: '1250', taxRatePct: '0' }, null]); // 5000.00: approver, then finance
    data(await submit(purchaseOrderId));
    expect((await get(u.bayu, purchaseOrderId)).openDecision).toMatchObject({ stepNo: 1, stepCount: 2, label: 'Approver for OPS' });
    expect(rule(await run(u.nina, getPurchaseOrder, { purchaseOrderId }))).toBe('NOT_FOUND');
    expect(rule(await decide(purchaseOrderId, u.nina, 'approve'))).toBe('NOT_FOUND');
    expect(rule(await decide(purchaseOrderId, u.sari, 'approve'))).toBe('NOT_ELIGIBLE_APPROVER');
    expect(data(await decide(purchaseOrderId, u.bayu, 'approve')).documentStatus).toBe('pending_approval');
    expect(data(await decide(purchaseOrderId, u.sari, 'approve')).documentStatus).toBe('approved');
  });
});

describe('P7-AC7: separation of duties on PO approval (SOD-01, SOD-06)', () => {
  it('SOD-01: the creator (also holding finance) cannot approve their own order, in the app, the inbox, and the database', async () => {
    const { purchaseOrderId } = await pendingOrder(u.paul);
    expect(data(await run(u.paul, approvalInbox, {})).items.some((i) => i.documentId === purchaseOrderId)).toBe(false);
    expect((await get(u.paul, purchaseOrderId)).openDecision).toBeNull();
    expect(rule(await decide(purchaseOrderId, u.paul, 'approve'))).toBe('SELF_APPROVAL');
    const step = (await t.pool.query('SELECT s.id FROM approval_steps s JOIN purchase_orders po ON po.current_approval_request_id = s.approval_request_id WHERE po.id = $1', [purchaseOrderId])).rows[0].id;
    const direct = "UPDATE approval_steps SET status = 'approved', decided_by_user_id = $2, decided_at = now() WHERE id = $1";
    expect(await sqlStateOf(() => t.appPool.query(direct, [step, u.paul]))).toBe('PFD01');
    expect(await sqlStateOf(() => t.pool.query(direct, [step, u.paul]))).toBe('PFD01');
    expect(data(await decide(purchaseOrderId, u.sari, 'approve')).documentStatus).toBe('approved');
  });

  it('SOD-06: the buyer who awarded the quotation (also holding finance) cannot approve the order made from it', async () => {
    const pr = await approvedRequisition();
    const rfq = await awardedRfq(pr, 'parts', u.olga);
    await setRules({ threshold: '0' });
    const { purchaseOrderId } = await created(pr, { supplierId: s.parts, quotationId: rfq.quotations.parts }, [{ quantity: '4', taxRatePct: '0', quotationLineId: rfq.awardedLines[0] as string }], u.fajar);
    const submitted = data(await submit(purchaseOrderId, u.fajar));
    expect(submitted.approvalReasons).toEqual(['AMOUNT_THRESHOLD']);
    expect((await t.pool.query('SELECT submitted_by_user_id, awarded_by_user_id FROM approval_requests WHERE id = $1', [submitted.approvalRequestId])).rows[0]).toEqual({
      submitted_by_user_id: u.fajar,
      awarded_by_user_id: u.olga,
    });
    expect(data(await run(u.olga, approvalInbox, {})).items.some((i) => i.documentId === purchaseOrderId)).toBe(false);
    expect(rule(await decide(purchaseOrderId, u.olga, 'approve'))).toBe('SELF_APPROVAL');
    const step = (await t.pool.query('SELECT id FROM approval_steps WHERE approval_request_id = $1', [submitted.approvalRequestId])).rows[0].id;
    expect(await sqlStateOf(() => t.appPool.query("UPDATE approval_steps SET status = 'approved', decided_by_user_id = $2, decided_at = now() WHERE id = $1", [step, u.olga]))).toBe('PFD01');
    expect(data(await decide(purchaseOrderId, u.paul, 'approve')).documentStatus).toBe('approved');
  });

  it('the database refuses a round that leaves out the awarding buyer, or one not submitted by the creator', async () => {
    const pr = await approvedRequisition();
    const rfq = await awardedRfq(pr, 'parts', u.olga);
    const { purchaseOrderId } = await created(pr, { supplierId: s.parts, quotationId: rfq.quotations.parts }, [{ quantity: '4', taxRatePct: '0', quotationLineId: rfq.awardedLines[0] as string }], u.fajar);
    const policy = (await t.pool.query("SELECT id, version_no FROM approval_policies WHERE document_type = 'purchase_order' AND is_active")).rows[0];
    const ops = (await t.pool.query("SELECT id FROM departments WHERE code = 'OPS'")).rows[0].id;
    const roundOf = async (client: typeof t.appPool, submittedBy: string, awardedBy: string | null) => {
      const { rows } = await client.query(
        `INSERT INTO approval_requests (document_type, document_id, round, document_number, document_title, amount_snapshot, currency_code, currency_scale, department_id, policy_id, policy_version_no, submitted_by_user_id, awarded_by_user_id)
         SELECT 'purchase_order', id, 1, number, 'Office chairs', total, currency_code, currency_scale, $2, $3, $4, $5, $6 FROM purchase_orders WHERE id = $1 RETURNING id`,
        [purchaseOrderId, ops, policy.id, policy.version_no, submittedBy, awardedBy],
      );
      return rows[0].id as string;
    };
    for (const [submittedBy, awardedBy] of [
      [u.fajar, null],
      [u.dewi, u.olga],
    ] as const) {
      const client = await t.appPool.connect();
      try {
        await client.query('BEGIN');
        const requestId = await roundOf(client as unknown as typeof t.appPool, submittedBy, awardedBy);
        await client.query("INSERT INTO approval_steps (approval_request_id, step_no, required_role, scope_department_id, status, activated_at) VALUES ($1, 1, 'finance', NULL, 'pending', now())", [requestId]);
        const state = await sqlStateOf(() =>
          client.query(
            "UPDATE purchase_orders SET status = 'pending_approval', current_approval_request_id = $2, approval_reasons = '{AMOUNT_THRESHOLD}', approval_threshold = 1000, price_tolerance_pct = 5, submitted_at = now(), submitted_by_user_id = $3 WHERE id = $1",
            [purchaseOrderId, requestId, u.fajar],
          ),
        );
        expect({ submittedBy, awardedBy, state }).toEqual({ submittedBy, awardedBy, state: 'PFC01' });
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    }
  });
});

describe('P7-AC8: issuing (PO-T05)', () => {
  it('fixes each line receivable quantity as floor3(quantity × (1 + tolerance)), stores the tolerance, and audits it', async () => {
    const pr = await approvedRequisition([
      { description: 'Ergonomic office chair', quantity: '4', uom: 'pcs', estimatedUnitPrice: '180' },
      { description: 'Cable', quantity: '3.333', uom: 'm', estimatedUnitPrice: '2' },
    ]);
    const { purchaseOrderId } = await created(pr, {}, [{ quantity: '4', unitPrice: '175' }, { quantity: '3.333', unitPrice: '2' }]);
    data(await submit(purchaseOrderId));
    await setRules({ receipt: '2.5' });
    expect(data(await issue(purchaseOrderId))).toEqual({ version: 3, status: 'issued' });
    // 4 × 1.025 = 4.1; 3.333 × 1.025 = 3.416325 → 3.416 (down, never up).
    const po = await get(u.dewi, purchaseOrderId);
    expect(po).toMatchObject({ status: 'issued', issuedBy: 'Dewi Procurement', issuedAt: expect.any(String), receiptTolerancePct: '2.5', callerActions: ['cancel', 'close'] });
    expect(po.lines.map((l) => l.maxReceivableQty)).toEqual(['4.1', '3.416']);
    expect((await auditOf(purchaseOrderId)).at(-1)).toMatchObject({
      action: 'po.issued',
      changes: { status: ['approved', 'issued'], receiptTolerancePct: [null, '2.5'], maxReceivable: [null, ['1. 4 pcs, up to 4.1', '2. 3.333 m, up to 3.416']] },
    });
    // A later settings change does not touch an issued order.
    await setRules({ receipt: '10' });
    expect((await get(u.dewi, purchaseOrderId)).lines.map((l) => l.maxReceivableQty)).toEqual(['4.1', '3.416']);
  });

  it('with no tolerance the receivable quantity is the ordered quantity', async () => {
    const { purchaseOrderId } = await approvedOrder();
    data(await issue(purchaseOrderId));
    expect((await get(u.dewi, purchaseOrderId)).lines.map((l) => [l.quantity, l.maxReceivableQty])).toEqual([['1', '1']]);
  });

  it('only an approved order of an active supplier; not twice; stale versions refused', async () => {
    const pr = await approvedRequisition();
    const draft = await created(pr, {}, [{ quantity: '1', unitPrice: '100' }, null]);
    expect(rule(await issue(draft.purchaseOrderId))).toBe('INVALID_TRANSITION');
    const { purchaseOrderId: pending } = await pendingOrder();
    expect(rule(await issue(pending))).toBe('INVALID_TRANSITION');
    const supplier = await newSupplier('Blocked Before Issue Ltd');
    const { purchaseOrderId } = await created(await approvedRequisition(), { supplierId: supplier }, [{ quantity: '1', unitPrice: '100' }, null]);
    data(await submit(purchaseOrderId));
    expect(rule(await run(u.dewi, issuePurchaseOrder, { purchaseOrderId, expectedVersion: 1 }))).toBe('CONFLICT');
    await block(supplier);
    expect(rule(await issue(purchaseOrderId))).toBe('SUPPLIER_NOT_ACTIVE');
    const ok = await approvedOrder();
    data(await issue(ok.purchaseOrderId, u.fajar)); // any buyer issues
    expect(rule(await issue(ok.purchaseOrderId))).toBe('INVALID_TRANSITION');
    for (const as of [u.sari, u.lena, u.agus]) expect(rule(await issue(ok.purchaseOrderId, as))).toBe('FORBIDDEN');
  });

  it('an issued order and its lines cannot change, for the runtime role and the owner', async () => {
    const { purchaseOrderId } = await approvedOrder();
    data(await issue(purchaseOrderId));
    const line = (await t.pool.query('SELECT id FROM purchase_order_lines WHERE purchase_order_id = $1', [purchaseOrderId])).rows[0].id;
    for (const pool of [t.appPool, t.pool]) {
      for (const [statement, id] of [
        ['UPDATE purchase_order_lines SET unit_price = 1, line_subtotal = 1, line_total = 1 WHERE id = $1', line],
        ['UPDATE purchase_order_lines SET quantity = 2 WHERE id = $1', line],
        ['UPDATE purchase_order_lines SET tax_rate_pct = 11 WHERE id = $1', line],
        ['UPDATE purchase_order_lines SET max_receivable_qty = 5 WHERE id = $1', line],
        ['UPDATE purchase_order_lines SET received_qty = 1 WHERE id = $1', line],
        ['DELETE FROM purchase_order_lines WHERE id = $1', line],
        ["UPDATE purchase_orders SET payment_terms = 'Net 90' WHERE id = $1", purchaseOrderId],
        ['UPDATE purchase_orders SET total = 1, subtotal = 1, tax_total = 0 WHERE id = $1', purchaseOrderId],
        ['UPDATE purchase_orders SET supplier_id = supplier_id, number = $1::text WHERE id = $1', purchaseOrderId],
        ['UPDATE purchase_orders SET receipt_tolerance_pct = 50 WHERE id = $1', purchaseOrderId],
        ["UPDATE purchase_orders SET status = 'received' WHERE id = $1", purchaseOrderId],
        ["UPDATE purchase_orders SET status = 'draft' WHERE id = $1", purchaseOrderId],
      ] as const) {
        expect({ statement, state: await sqlStateOf(() => pool.query(statement, [id])) }).toEqual({ statement, state: 'PFC01' });
      }
    }
    expect(await sqlStateOf(() => t.appPool.query('DELETE FROM purchase_orders WHERE id = $1', [purchaseOrderId]))).toBe('42501');
    expect(await sqlStateOf(() => t.pool.query('DELETE FROM purchase_orders WHERE id = $1', [purchaseOrderId]))).toBe('PFC01');
  });
});

/** Goods arrive (Phase 8): Agus records and posts a receipt for the order's first line. */
async function receiveGoods(purchaseOrderId: string, quantity: string): Promise<void> {
  const line = (await t.pool.query('SELECT id FROM purchase_order_lines WHERE purchase_order_id = $1 ORDER BY line_no LIMIT 1', [purchaseOrderId])).rows[0].id;
  const receipt = data(
    await run(u.agus, createGoodsReceipt, {
      purchaseOrderId,
      receivedOn: new Date().toISOString().slice(0, 10),
      deliveryNoteRef: null,
      notes: null,
      lines: [{ purchaseOrderLineId: line, quantity, note: null }],
    }),
  );
  data(await run(u.agus, postGoodsReceipt, { goodsReceiptId: receipt.goodsReceiptId, expectedVersion: receipt.version }));
}

describe('P7-AC9: cancelling and closing (PO-T07 to T09)', () => {
  it('cancels a draft, an approved, and an issued order, releasing everything; a reason is required', async () => {
    for (const stage of ['draft', 'approved', 'issued'] as const) {
      const pr = await approvedRequisition();
      const { purchaseOrderId } = await created(pr, {}, [{ quantity: '1.5', unitPrice: '175' }, { quantity: '2', unitPrice: '30' }]);
      if (stage !== 'draft') data(await submit(purchaseOrderId));
      if (stage === 'issued') data(await issue(purchaseOrderId));
      for (const reason of ['', '   ', 'x'.repeat(501), null]) expect(rule(await cancel(purchaseOrderId, reason))).toBe('VALIDATION_FAILED');
      expect(rule(await run(u.dewi, cancelPurchaseOrder, { purchaseOrderId, expectedVersion: (await versionOf(purchaseOrderId)) + 1, reason: 'Stale' }))).toBe('CONFLICT');
      expect(data(await cancel(purchaseOrderId, 'Supplier withdrew', u.fajar))).toMatchObject({ status: 'cancelled' });
      expect([await ordered(pr.lineIds[0] as string), await ordered(pr.lineIds[1] as string)]).toEqual(['0.000', '0.000']);
      expect((await auditOf(purchaseOrderId)).at(-1)).toMatchObject({
        action: 'po.cancelled',
        actor: u.fajar,
        changes: { status: [stage, 'cancelled'], released: [null, ['1.5 pcs (requisition line 1)', '2 pcs (requisition line 2)']] },
        reason: 'Supplier withdrew',
      });
      expect(await get(u.dewi, purchaseOrderId)).toMatchObject({ status: 'cancelled', cancelledBy: 'Fajar Procurement', cancelReason: 'Supplier withdrew', callerActions: [] });
      expect(rule(await cancel(purchaseOrderId))).toBe('INVALID_TRANSITION');
    }
  });

  it('cancelling an order waiting for approval withdraws its round', async () => {
    const { pr, purchaseOrderId } = await pendingOrder();
    const requestId = (await t.pool.query('SELECT current_approval_request_id AS id FROM purchase_orders WHERE id = $1', [purchaseOrderId])).rows[0].id;
    data(await cancel(purchaseOrderId, 'Ordered by mistake'));
    expect((await t.pool.query('SELECT status FROM approval_requests WHERE id = $1', [requestId])).rows[0].status).toBe('cancelled');
    expect((await t.pool.query('SELECT status FROM approval_steps WHERE approval_request_id = $1', [requestId])).rows.map((r) => r.status)).toEqual(['cancelled']);
    expect((await auditOf(requestId)).at(-1)).toMatchObject({ action: 'approval.cancelled', reason: 'Ordered by mistake' });
    expect(await ordered(pr.lineIds[0] as string)).toBe('0.000');
    expect(data(await run(u.sari, approvalInbox, {})).items.some((i) => i.documentId === purchaseOrderId)).toBe(false);
  });

  it('RECEIPTS_EXIST: an issued order with anything received cannot be cancelled, in the app and in the database', async () => {
    const { purchaseOrderId } = await approvedOrder();
    data(await issue(purchaseOrderId));
    await receiveGoods(purchaseOrderId, '0.5');
    expect(await statusOf(purchaseOrderId)).toBe('partially_received');
    expect(rule(await cancel(purchaseOrderId))).toBe('RECEIPTS_EXIST');
    expect((await get(u.dewi, purchaseOrderId)).callerActions).toEqual(['close']);
    expect(
      await sqlStateOf(() =>
        t.appPool.query("UPDATE purchase_orders SET status = 'cancelled', cancelled_at = now(), cancelled_by_user_id = $2, cancel_reason = 'x' WHERE id = $1", [purchaseOrderId, u.dewi]),
      ),
    ).toBe('PFC01');
    // Closing gives back what was not received (1 − 0.5).
    data(await close(purchaseOrderId));
  });

  it('closes an issued order with a reason and releases what was not received; a received one needs no reason', async () => {
    const issued = await approvedOrder();
    data(await issue(issued.purchaseOrderId));
    expect(rule(await close(issued.purchaseOrderId, ''))).toBe('VALIDATION_FAILED');
    expect(data(await close(issued.purchaseOrderId))).toMatchObject({ status: 'closed' });
    expect(await ordered(issued.pr.lineIds[0] as string)).toBe('0.000');
    expect(await get(u.dewi, issued.purchaseOrderId)).toMatchObject({ status: 'closed', closedBy: 'Dewi Procurement', closeReason: 'Supplier cannot deliver the rest' });
    expect((await auditOf(issued.purchaseOrderId)).at(-1)).toMatchObject({ action: 'po.closed', changes: { status: ['issued', 'closed'], released: [null, ['1 pcs (requisition line 1)']] } });

    // Short-closing a partially received order keeps the received part ordered (PO-I1).
    const pr = await approvedRequisition();
    const partial = await created(pr, {}, [{ quantity: '4', unitPrice: '175' }, null]);
    data(await submit(partial.purchaseOrderId));
    data(await issue(partial.purchaseOrderId));
    await receiveGoods(partial.purchaseOrderId, '1.25');
    expect(rule(await close(partial.purchaseOrderId, null))).toBe('VALIDATION_FAILED');
    data(await close(partial.purchaseOrderId, 'Rest is back-ordered for months'));
    expect(await ordered(pr.lineIds[0] as string)).toBe('1.250');
    expect((await auditOf(partial.purchaseOrderId)).at(-1)).toMatchObject({ changes: { released: [null, ['2.75 pcs (requisition line 1)']] } });

    const full = await approvedOrder();
    data(await issue(full.purchaseOrderId));
    await receiveGoods(full.purchaseOrderId, '1');
    expect((await get(u.dewi, full.purchaseOrderId)).callerActions).toEqual(['close']);
    expect(data(await close(full.purchaseOrderId, null))).toMatchObject({ status: 'closed' });
    expect(await ordered(full.pr.lineIds[0] as string)).toBe('1.000');
    expect((await auditOf(full.purchaseOrderId)).at(-1)).toEqual({ action: 'po.closed', actor: u.dewi, reason: null, changes: { status: ['received', 'closed'] } });
  });

  it('closing is only for issued orders', async () => {
    const pr = await approvedRequisition();
    const draft = await created(pr, {}, [{ quantity: '1', unitPrice: '175' }, null]);
    expect(rule(await close(draft.purchaseOrderId))).toBe('INVALID_TRANSITION');
    data(await submit(draft.purchaseOrderId));
    expect(rule(await close(draft.purchaseOrderId))).toBe('INVALID_TRANSITION');
    for (const as of [u.sari, u.lena, u.agus, u.rina]) expect(rule(await close(draft.purchaseOrderId, 'x', as))).toBe('FORBIDDEN');
  });
});

describe('P7-AC10 / P7-AC9: database backstops on drafts, totals, and PO-I1', () => {
  it('lines are checked against the requisition, the quotation, and ADR 0007 arithmetic', async () => {
    const pr = await approvedRequisition();
    const other = await approvedRequisition();
    const { purchaseOrderId } = await created(pr, {}, [{ quantity: '1', unitPrice: '175', taxRatePct: '11' }, null]);
    const line = (await t.pool.query('SELECT * FROM purchase_order_lines WHERE purchase_order_id = $1', [purchaseOrderId])).rows[0];
    for (const [statement, params] of [
      ['UPDATE purchase_order_lines SET line_subtotal = 175.01, line_total = 194.26 WHERE id = $1', [line.id]],
      ['UPDATE purchase_order_lines SET line_tax = 19.26, line_total = 194.26 WHERE id = $1', [line.id]],
      ["UPDATE purchase_order_lines SET description = 'Gold chair' WHERE id = $1", [line.id]],
      ["UPDATE purchase_order_lines SET uom = 'box' WHERE id = $1", [line.id]],
      ['UPDATE purchase_order_lines SET requisition_line_id = $2 WHERE id = $1', [line.id, other.lineIds[0]]],
      ['UPDATE purchase_order_lines SET max_receivable_qty = 1 WHERE id = $1', [line.id]],
      ['UPDATE purchase_order_lines SET quotation_line_id = (SELECT id FROM quotation_lines LIMIT 1) WHERE id = $1', [line.id]],
    ] as const) {
      expect({ statement, state: await sqlStateOf(() => t.appPool.query(statement, [...params])) }).toEqual({ statement, state: 'PFC01' });
    }
    // The CHECK: total = subtotal + tax. (A rate of 101 % is refused by the guard first: the tax would not match.)
    expect(await sqlStateOf(() => t.appPool.query('UPDATE purchase_order_lines SET line_total = 1 WHERE id = $1', [line.id]))).toBe('23514');
    expect(await sqlStateOf(() => t.appPool.query('UPDATE purchase_order_lines SET tax_rate_pct = 101 WHERE id = $1', [line.id]))).toBe('PFC01');
    // Header totals out of step with the lines are refused at commit; in step they are accepted.
    expect(await sqlStateOf(() => t.appPool.query('UPDATE purchase_orders SET subtotal = 1, tax_total = 0, total = 1 WHERE id = $1', [purchaseOrderId]))).toBe('PFC01');
    expect(await sqlStateOf(() => t.appPool.query('UPDATE purchase_orders SET payment_terms = $2 WHERE id = $1', [purchaseOrderId, 'Net 15']))).toBe('none');
    // A draft cannot lose its last line.
    expect(await sqlStateOf(() => t.appPool.query('DELETE FROM purchase_order_lines WHERE purchase_order_id = $1', [purchaseOrderId]))).toBe('PFC01');
  });

  it('lines of a submitted order cannot change, even when every amount stays the same', async () => {
    const approved = await approvedOrder(); // 1 chair at 175, no tax
    const { purchaseOrderId: pending } = await pendingOrder();
    for (const purchaseOrderId of [approved.purchaseOrderId, pending]) {
      const line = (await t.pool.query('SELECT * FROM purchase_order_lines WHERE purchase_order_id = $1', [purchaseOrderId])).rows[0];
      // 0.0001 % more tax rounds to the same tax amount (on 175 and on 1000), so the totals would still match.
      expect(await sqlStateOf(() => t.appPool.query('UPDATE purchase_order_lines SET tax_rate_pct = tax_rate_pct + 0.0001 WHERE id = $1', [line.id]))).toBe('PFC01');
      // Deleting a line and inserting it again in one transaction.
      const client = await t.appPool.connect();
      try {
        await client.query('BEGIN');
        const state = await sqlStateOf(async () => {
          await client.query('DELETE FROM purchase_order_lines WHERE id = $1', [line.id]);
          await client.query(
            `INSERT INTO purchase_order_lines (purchase_order_id, line_no, requisition_line_id, description, uom, quantity, unit_price, tax_rate_pct, line_subtotal, line_tax, line_total)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [purchaseOrderId, line.line_no, line.requisition_line_id, line.description, line.uom, line.quantity, line.unit_price, line.tax_rate_pct, line.line_subtotal, line.line_tax, line.line_total],
          );
        });
        expect(state).toBe('PFC01');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    }
  });

  it('with a quotation: the quoted price and no more than the quoted quantity', async () => {
    const pr = await approvedRequisition();
    const rfq = await awardedRfq(pr);
    const { purchaseOrderId } = await created(pr, { supplierId: s.parts, quotationId: rfq.quotations.parts }, [{ quantity: '2', taxRatePct: '0', quotationLineId: rfq.awardedLines[0] as string }]);
    const line = (await t.pool.query('SELECT id FROM purchase_order_lines WHERE purchase_order_id = $1', [purchaseOrderId])).rows[0].id;
    expect(await sqlStateOf(() => t.appPool.query('UPDATE purchase_order_lines SET unit_price = 1, line_subtotal = 2, line_total = 2 WHERE id = $1', [line]))).toBe('PFC01');
    expect(await sqlStateOf(() => t.appPool.query('UPDATE purchase_order_lines SET quantity = 4.001, line_subtotal = 672.17, line_total = 672.17 WHERE id = $1', [line]))).toBe('PFC01');
    expect(await sqlStateOf(() => t.appPool.query('UPDATE purchase_order_lines SET quotation_line_id = $2 WHERE id = $1', [line, rfq.otherLines[0]]))).toBe('PFC01');
    expect(await sqlStateOf(() => t.appPool.query('UPDATE purchase_order_lines SET quotation_line_id = NULL WHERE id = $1', [line]))).toBe('PFC01');
  });

  it('a purchase order is inserted only as a draft of an approved requisition, active supplier, its department and currency, an awarded quotation above the RFQ threshold', async () => {
    const pr = await approvedRequisition();
    const ops = (await t.pool.query('SELECT department_id FROM purchase_requisitions WHERE id = $1', [pr.requisitionId])).rows[0].department_id;
    const insert = (overrides: Record<string, unknown>) => {
      const values: Record<string, unknown> = {
        number: `PO-2030-9${String(Math.floor(Math.random() * 99999)).padStart(5, '0')}`,
        requisition_id: pr.requisitionId,
        department_id: ops,
        supplier_id: s.office,
        currency_code: 'USD',
        currency_scale: 2,
        subtotal: 0,
        tax_total: 0,
        total: 0,
        created_by_user_id: u.dewi,
        ...overrides,
      };
      const columns = Object.keys(values);
      return sqlStateOf(() => t.appPool.query(`INSERT INTO purchase_orders (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(values)));
    };
    expect(await insert({ status: 'approved', approved_at: new Date(), submitted_at: new Date(), submitted_by_user_id: u.dewi, price_tolerance_pct: 5 })).toBe('PFC01');
    expect(await insert({ supplier_id: s.pending })).toBe('PFC01');
    expect(await insert({ department_id: finDepartment })).toBe('PFC01');
    expect(await insert({ currency_code: 'EUR' })).toBe('PFC01');
    expect(await insert({ approval_reasons: '{AMOUNT_THRESHOLD}' })).toBe('PFC01');
    const draft = data(await run(u.rina, createRequisition, { title: 'Draft', justification: null, neededBy: '2030-06-30', lines: LINES }));
    expect(await insert({ requisition_id: draft.requisitionId })).toBe('PFC01');
    await setRules({ rfqRequiredAbove: '500' });
    expect(await insert({})).toBe('PFC01');
    await setRules({ rfqRequiredAbove: null });
    // Otherwise the header is accepted, and refused at commit for having no line.
    expect(await insert({})).toBe('PFC01');
  });

  it('PO-I1 at commit: the ordered quantity cannot drift from the orders, nor an order be cancelled without releasing', async () => {
    const pr = await approvedRequisition();
    const { purchaseOrderId } = await created(pr, {}, [{ quantity: '2', unitPrice: '175' }, null]);
    expect(await sqlStateOf(() => t.appPool.query('UPDATE requisition_lines SET ordered_qty = 1 WHERE id = $1', [pr.lineIds[0]]))).toBe('PFC01');
    expect(await sqlStateOf(() => t.appPool.query('UPDATE requisition_lines SET ordered_qty = 3 WHERE id = $1', [pr.lineIds[0]]))).toBe('PFC01');
    expect(
      await sqlStateOf(() =>
        t.appPool.query("UPDATE purchase_orders SET status = 'cancelled', cancelled_at = now(), cancelled_by_user_id = $2, cancel_reason = 'x' WHERE id = $1", [purchaseOrderId, u.dewi]),
      ),
    ).toBe('PFC01');
    // The CHECK on the requisition line is the over-order backstop (ADR 0008 C3).
    expect(await sqlStateOf(() => t.appPool.query('UPDATE requisition_lines SET ordered_qty = 4.001 WHERE id = $1', [pr.lineIds[0]]))).toBe('23514');
    expect(await ordered(pr.lineIds[0] as string)).toBe('2.000');
  });
});

describe('P7-AC11: who sees which purchase order', () => {
  it('lists and reads by role: buyers, finance, and the auditor all; approvers their departments; receivers issued orders only; others nothing', async () => {
    const pr = await approvedRequisition();
    const draft = await created(pr, {}, [{ quantity: '1', unitPrice: '175' }, null]);
    const issued = await approvedOrder();
    data(await issue(issued.purchaseOrderId));
    const visible = async (as: string, id: string) => (await run(as, getPurchaseOrder, { purchaseOrderId: id })).ok;
    const listed = async (as: string) => new Set(data(await run(as, listPurchaseOrders, { limit: 100 })).items.map((i) => i.id));
    for (const as of [u.dewi, u.fajar, u.sari, u.lena, u.bayu]) {
      expect({ as, draft: await visible(as, draft.purchaseOrderId), issued: await visible(as, issued.purchaseOrderId) }).toEqual({ as, draft: true, issued: true });
      const items = await listed(as);
      expect([items.has(draft.purchaseOrderId), items.has(issued.purchaseOrderId)]).toEqual([true, true]);
    }
    // Nina approves for FIN only; Agus receives issued orders.
    expect([await visible(u.nina, draft.purchaseOrderId), await visible(u.nina, issued.purchaseOrderId)]).toEqual([false, false]);
    expect((await listed(u.nina)).size).toBe(0);
    expect([await visible(u.agus, draft.purchaseOrderId), await visible(u.agus, issued.purchaseOrderId)]).toEqual([false, true]);
    expect([...(await listed(u.agus))].every((id) => id !== draft.purchaseOrderId)).toBe(true);
    expect(rule(await run(u.agus, getPurchaseOrder, { purchaseOrderId: draft.purchaseOrderId }))).toBe('NOT_FOUND');
    for (const as of [u.rina, u.ada]) {
      expect(rule(await run(as, getPurchaseOrder, { purchaseOrderId: issued.purchaseOrderId }))).toBe('FORBIDDEN');
      expect(rule(await run(as, listPurchaseOrders, {}))).toBe('FORBIDDEN');
    }
    expect(rule(await run(u.dewi, getPurchaseOrder, { purchaseOrderId: '01900000-0000-7000-8000-000000000000' }))).toBe('NOT_FOUND');
    // Readers who are not buyers get no buyer actions; a receiver may receive an issued order (Phase 8).
    for (const as of [u.sari, u.lena, u.bayu]) expect((await get(as, issued.purchaseOrderId)).callerActions).toEqual([]);
    expect((await get(u.agus, issued.purchaseOrderId)).callerActions).toEqual(['receive']);
  });

  it('returns only allowlisted fields, with names instead of user ids', async () => {
    const pr = await approvedRequisition();
    const rfq = await awardedRfq(pr);
    const { purchaseOrderId } = await created(pr, { supplierId: s.parts, quotationId: rfq.quotations.parts }, [{ quantity: '1', taxRatePct: '0', quotationLineId: rfq.awardedLines[0] as string }]);
    const po = await get(u.lena, purchaseOrderId);
    expect(Object.keys(po).sort()).toEqual([...PO_DETAIL_KEYS].sort());
    expect(Object.keys(po.supplier).sort()).toEqual([...PO_SUPPLIER_KEYS].sort());
    expect(Object.keys(po.quotation ?? {}).sort()).toEqual([...PO_QUOTATION_KEYS].sort());
    for (const line of po.lines) expect(Object.keys(line).sort()).toEqual([...PO_LINE_KEYS].sort());
    const item = data(await run(u.lena, listPurchaseOrders, { requisitionId: pr.requisitionId })).items[0];
    expect(Object.keys(item ?? {}).sort()).toEqual([...PO_SUMMARY_KEYS].sort());
    expect(JSON.stringify(po)).not.toContain(u.dewi);
  });

  it('filters lists by status, requisition, supplier, and number (literally), newest first, with a cursor', async () => {
    const pr = await approvedRequisition();
    const a = await created(pr, {}, [{ quantity: '1', unitPrice: '175' }, null]);
    const b = await created(pr, { supplierId: s.parts }, [{ quantity: '1', unitPrice: '175' }, null]);
    data(await submit(b.purchaseOrderId));
    const ids = async (input: Record<string, unknown>) => data(await run(u.dewi, listPurchaseOrders, input)).items.map((i) => i.id);
    expect(await ids({ requisitionId: pr.requisitionId })).toEqual([b.purchaseOrderId, a.purchaseOrderId]);
    expect(await ids({ requisitionId: pr.requisitionId, status: 'approved' })).toEqual([b.purchaseOrderId]);
    expect(await ids({ requisitionId: pr.requisitionId, supplierId: s.office })).toEqual([a.purchaseOrderId]);
    expect(await ids({ q: a.number })).toEqual([a.purchaseOrderId]);
    expect(await ids({ q: '%' })).toEqual([]);
    const first = data(await run(u.dewi, listPurchaseOrders, { requisitionId: pr.requisitionId, limit: 1 }));
    expect(first.nextCursor).toBe(b.number);
    expect(await ids({ requisitionId: pr.requisitionId, cursor: first.nextCursor })).toEqual([a.purchaseOrderId]);
    for (const bad of [{ status: 'lost' }, { cursor: "PO-2030-000001' OR 1=1" }, { limit: 101 }, { foo: 1 }]) expect(rule(await run(u.dewi, listPurchaseOrders, bad))).toBe('VALIDATION_FAILED');
  });

  it('form options: the requisition lines with what may still be ordered (plus what an edited order holds), active suppliers, and awarded quotations', async () => {
    const pr = await approvedRequisition();
    const rfq = await awardedRfq(pr);
    const { purchaseOrderId } = await created(pr, {}, [{ quantity: '1.5', unitPrice: '175' }, null]);
    const options = data(await run(u.dewi, purchaseOrderFormOptions, { requisitionId: pr.requisitionId }));
    expect(Object.keys(options).sort()).toEqual([...PO_FORM_OPTIONS_KEYS].sort());
    for (const line of options.lines) expect(Object.keys(line).sort()).toEqual([...PO_FORM_LINE_KEYS].sort());
    expect(options.lines.map((l) => [l.lineNo, l.availableQty, l.estimatedUnitPrice])).toEqual([
      [1, '2.5', '180'],
      [2, '4', '35'],
    ]);
    expect(options.rfqRequired).toBe(false);
    expect(options.suppliers.map((x) => x.legalName)).toContain('Sample Industrial Parts Co');
    expect(options.suppliers.map((x) => x.legalName)).not.toContain('Pending Review Trading');
    expect(options.quotations).toEqual([expect.objectContaining({ id: rfq.quotations.parts, rfqNumber: rfq.rfqNumber, supplierName: 'Sample Industrial Parts Co', expired: false })]);
    const editing = data(await run(u.dewi, purchaseOrderFormOptions, { requisitionId: pr.requisitionId, purchaseOrderId }));
    expect(editing.lines.map((l) => l.availableQty)).toEqual(['4', '4']);
    await setRules({ rfqRequiredAbove: '860' });
    expect(data(await run(u.dewi, purchaseOrderFormOptions, { requisitionId: pr.requisitionId })).rfqRequired).toBe(true);
    expect(data(await run(u.dewi, purchaseOrderFormOptions, { requisitionId: pr.requisitionId }, fixedClock('2030-04-01T00:00:00Z'))).quotations[0]?.expired).toBe(true);
    const other = await approvedRequisition();
    expect(rule(await run(u.dewi, purchaseOrderFormOptions, { requisitionId: other.requisitionId, purchaseOrderId }))).toBe('NOT_FOUND');
    for (const as of [u.sari, u.lena, u.bayu, u.agus]) expect(rule(await run(as, purchaseOrderFormOptions, { requisitionId: pr.requisitionId }))).toBe('FORBIDDEN');
  });
});
