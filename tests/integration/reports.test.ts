import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HISTORY_ENTRY_KEYS } from '@/modules/audit';
import { publishApprovalPolicy } from '@/modules/organization';
import { cancelPurchaseOrder, closePurchaseOrder, createPurchaseOrder, getPurchaseOrder, issuePurchaseOrder, submitPurchaseOrder } from '@/modules/purchasing';
import { cancelGoodsReceipt, createGoodsReceipt, getGoodsReceipt, postGoodsReceipt, reverseGoodsReceipt } from '@/modules/receiving';
import {
  AGING_REPORT_KEYS,
  AGING_ROW_KEYS,
  AUDIT_EVENT_KEYS,
  CSV_BOM,
  CYCLE_REPORT_KEYS,
  CYCLE_ROW_KEYS,
  OPEN_ORDERS_REPORT_KEYS,
  OPEN_ORDER_KEYS,
  SPEND_REPORT_KEYS,
  SPEND_ROW_KEYS,
  SPLIT_GROUP_KEYS,
  SPLIT_REPORT_KEYS,
  approvalAging,
  auditFilterOptions,
  exportReport,
  openPurchaseOrders,
  potentialSplitPurchases,
  requisitionCycleTime,
  searchAudit,
  spendByDepartment,
  spendBySupplier,
} from '@/modules/reporting';
import { createRequisition, getRequisition, submitRequisition } from '@/modules/requisitions';
import { createSupplier, getSupplier, reviewSupplier } from '@/modules/suppliers';
import { decideApproval } from '@/server/approvals';
import { createRequestContext } from '@/shared/application/context';
import { runCommand, runQuery, type Operation } from '@/shared/application/runner';
import { fixedClock, type Clock } from '@/shared/clock';
import type { Result } from '@/shared/result';
import { contextOf, provisionActor } from '../support/actors';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/*
 * Phase 9: audit search, document history, and reports, as the runtime role through the runner.
 *
 * The fixture below is built with real commands, then moved back in time (as the owner, with the
 * guard triggers off for that one transaction) so dates and durations are exact. The org time zone
 * is Asia/Jakarta (UTC+7): order C is issued at 18:30 UTC on 31 March, which is 1 April there.
 * Every expected figure was worked out by hand from the inputs; see the comments next to them.
 */

let t: TestDatabase;
type Persona = 'rina' | 'tia' | 'bayu' | 'dewi' | 'agus' | 'sari' | 'lena' | 'ada';
const u = {} as Record<Persona, string>;
const NOW = '2025-04-10T12:00:00.000Z';
const clock: Clock = fixedClock(NOW);
let currency = '';

async function run<I, O>(as: string, op: Operation<I, O>, input: unknown, options: { clock?: Clock; ip?: string; userAgent?: string } = {}): Promise<Result<O>> {
  const base = await contextOf(t.appDb, as);
  const context = options.ip || options.userAgent ? createRequestContext({ actor: base.actor, ip: options.ip ?? null, userAgent: options.userAgent ?? null }) : base;
  const runner = { db: t.appDb, ...(options.clock ? { clock: options.clock } : {}) };
  return op.kind === 'command' ? runCommand(context, op, input, runner) : runQuery(context, op, input, runner);
}

/** Reports always run at NOW. */
const report = <I, O>(as: string, op: Operation<I, O>, input: unknown) => run(as, op, input, { clock });

function data<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.data;
}

const code = (result: Result<unknown>) => (result.ok ? 'ok' : (result.error.rule ?? result.error.code));

let supplierCount = 0;
async function newSupplier(legalName: string): Promise<{ id: string; code: string }> {
  supplierCount++;
  const created = data(
    await run(u.dewi, createSupplier, {
      legalName,
      taxId: `EX-9000-${String(supplierCount).padStart(4, '0')}`,
      email: `reports${supplierCount}@example.com`,
      phone: '+1 555 0190',
      addressLine1: '900 Example Way',
      addressLine2: null,
      city: 'Springfield',
      region: null,
      postalCode: '00090',
      countryCode: 'US',
    }),
  );
  data(await run(u.sari, reviewSupplier, { supplierId: created.supplierId, expectedVersion: 1, decision: 'approve', note: null }));
  const row = await t.pool.query('SELECT code FROM suppliers WHERE id = $1', [created.supplierId]);
  return { id: created.supplierId, code: row.rows[0].code as string };
}

type Line = { description: string; quantity: string; unitPrice: string; taxRatePct: string };
type Fixture = { requisitionId: string; requisitionNumber: string; purchaseOrderId: string; number: string; lines: string[] };

async function approvedRequisition(requester: string, title: string, lines: Omit<Line, 'taxRatePct'>[]) {
  const pr = data(
    await run(requester, createRequisition, {
      title,
      justification: null,
      neededBy: '2030-06-30',
      lines: lines.map((l) => ({ description: l.description, quantity: l.quantity, uom: 'pcs', estimatedUnitPrice: l.unitPrice })),
    }),
  );
  const submitted = data(await run(requester, submitRequisition, { requisitionId: pr.requisitionId, expectedVersion: 1 }));
  data(await run(u.bayu, decideApproval, { approvalRequestId: submitted.approvalRequestId, stepNo: 1, expectedVersion: 1, decision: 'approve' }));
  return pr;
}

/** A requisition, approved, ordered from `supplierId`, approved on submit (below 1000), and issued if asked. */
async function order(requester: string, supplierId: string, title: string, lines: Line[], issue: boolean): Promise<Fixture> {
  const pr = await approvedRequisition(requester, title, lines);
  const requisitionLines = (await t.pool.query('SELECT id FROM requisition_lines WHERE requisition_id = $1 ORDER BY line_no', [pr.requisitionId])).rows.map(
    (r) => r.id as string,
  );
  const created = data(
    await run(u.dewi, createPurchaseOrder, {
      requisitionId: pr.requisitionId,
      supplierId,
      paymentTerms: 'Net 30',
      deliveryAddress: null,
      expectedDeliveryDate: null,
      lines: lines.map((l, i) => ({ requisitionLineId: requisitionLines[i], quantity: l.quantity, unitPrice: l.unitPrice, taxRatePct: l.taxRatePct })),
    }),
  );
  expect(data(await run(u.dewi, submitPurchaseOrder, { purchaseOrderId: created.purchaseOrderId, expectedVersion: 1 })).status).toBe('approved');
  // Dewi issues B from a known client address, for audit search.
  if (issue) data(await run(u.dewi, issuePurchaseOrder, { purchaseOrderId: created.purchaseOrderId, expectedVersion: 2 }, { ip: '203.0.113.7', userAgent: 'ReportTest/1.0' }));
  const poLines = (await t.pool.query('SELECT id FROM purchase_order_lines WHERE purchase_order_id = $1 ORDER BY line_no', [created.purchaseOrderId])).rows.map(
    (r) => r.id as string,
  );
  return { requisitionId: pr.requisitionId, requisitionNumber: pr.number, purchaseOrderId: created.purchaseOrderId, number: created.number, lines: poLines };
}

const today = () => new Date().toISOString().slice(0, 10);
const version = async (table: string, id: string) => (await t.pool.query(`SELECT version FROM ${table} WHERE id = $1`, [id])).rows[0].version as number;

async function receive(o: Fixture, quantities: (string | null)[]): Promise<string> {
  const created = data(
    await run(u.agus, createGoodsReceipt, {
      purchaseOrderId: o.purchaseOrderId,
      receivedOn: today(),
      deliveryNoteRef: null,
      notes: null,
      lines: o.lines.flatMap((purchaseOrderLineId, i) => (quantities[i] ? [{ purchaseOrderLineId, quantity: quantities[i], note: null }] : [])),
    }),
  );
  data(await run(u.agus, postGoodsReceipt, { goodsReceiptId: created.goodsReceiptId, expectedVersion: 1 }));
  return created.goodsReceiptId;
}

const s = {} as Record<'office' | 'parts', { id: string; code: string }>;
const f = {} as Record<'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'J', Fixture>;
const pr = {} as Record<'G' | 'H' | 'I', { requisitionId: string; number: string }>;
const gr = {} as Record<'A1' | 'A2' | 'A2R' | 'A3' | 'C1' | 'F1' | 'Bdraft' | 'Acancelled', string>;

beforeAll(async () => {
  t = await createTestDatabase();
  await t.pool.query("INSERT INTO departments (code, name) VALUES ('OPS', 'Operations'), ('ADM', 'Administration')");
  u.rina = await provisionActor(t.appDb, 'rina@example.com', 'Rina Requester', ['requester'], { departmentCode: 'OPS' });
  u.tia = await provisionActor(t.appDb, 'tia@example.com', 'Tia Requester', ['requester'], { departmentCode: 'ADM' });
  u.bayu = await provisionActor(
    t.appDb,
    'bayu@example.com',
    'Bayu Approver',
    [
      { role: 'approver', departmentCode: 'OPS' },
      { role: 'approver', departmentCode: 'ADM' },
    ],
    { departmentCode: 'OPS' },
  );
  u.dewi = await provisionActor(t.appDb, 'dewi@example.com', 'Dewi Procurement', ['procurement']);
  u.agus = await provisionActor(t.appDb, 'agus@example.com', 'Agus Receiver', ['receiver']);
  u.sari = await provisionActor(t.appDb, 'sari@example.com', 'Sari Finance', ['finance']);
  u.lena = await provisionActor(t.appDb, 'lena@example.com', 'Lena Auditor', ['auditor']);
  u.ada = await provisionActor(t.appDb, 'ada@example.com', 'Ada Admin', ['admin']);
  data(
    await run(u.ada, publishApprovalPolicy, {
      documentType: 'requisition',
      name: 'One step',
      rules: [{ departmentCode: null, minAmount: '0', maxAmount: null, steps: [{ role: 'approver', scopeMode: 'document_department' }] }],
    }),
  );
  // No RFQ needed while the fixture is built; the split report reads the thresholds set after it.
  await t.pool.query("UPDATE org_settings SET timezone = 'Asia/Jakarta', rfq_required_above = NULL, po_approval_threshold = 1000, over_receipt_tolerance_pct = 10");
  currency = (await t.pool.query('SELECT currency_code FROM org_settings')).rows[0].currency_code as string;
  s.office = await newSupplier('Example Office Supplies Ltd');
  s.parts = await newSupplier('Sample Industrial Parts Co.');

  // A: 455.00 + 50.05 tax; 100.00 (3 × 33.3333 = 99.9999) + 11.00 tax. Total 616.05.
  f.A = await order(u.rina, s.office.id, 'Chairs and cables', [
    { description: 'Office chair', quantity: '10', unitPrice: '45.50', taxRatePct: '11' },
    { description: 'Cable set', quantity: '3', unitPrice: '33.3333', taxRatePct: '11' },
  ], true);
  // B: 2 × 120.00, no tax. Total 240.00. The description starts with '=' (CSV formula injection).
  f.B = await order(u.rina, s.office.id, 'Desk lamps', [{ description: '=2+3 desk lamps', quantity: '2', unitPrice: '120.00', taxRatePct: '0' }], true);
  // C: 99.95 + 10.99 tax (10.9945). Total 110.94. Received in full.
  f.C = await order(u.tia, s.parts.id, 'Filing boxes', [{ description: 'Filing box', quantity: '5', unitPrice: '19.99', taxRatePct: '11' }], true);
  // D: 450.00, issued then cancelled: counts nowhere. With C (99.95, same requester and supplier,
  // 16 days apart) it would reach the RFQ threshold if cancelled orders counted.
  f.D = await order(u.tia, s.parts.id, 'Shelving', [{ description: 'Steel shelf', quantity: '1', unitPrice: '450.00', taxRatePct: '0' }], true);
  // E: 100.00, approved, never issued.
  f.E = await order(u.tia, s.office.id, 'Notebooks', [{ description: 'Notebook pack', quantity: '4', unitPrice: '25.00', taxRatePct: '0' }], false);
  // F: 200.00 + 20.00 tax. Total 220.00. One of four received, then closed short.
  f.F = await order(u.rina, s.parts.id, 'Toolkits', [{ description: 'Toolkit', quantity: '4', unitPrice: '50.00', taxRatePct: '10' }], true);
  // J: 300.00 + 33.00 tax. Total 333.00, approved, never issued.
  f.J = await order(u.rina, s.office.id, 'Whiteboards', [{ description: 'Whiteboard', quantity: '6', unitPrice: '50.00', taxRatePct: '11' }], false);

  gr.A1 = await receive(f.A, ['4', '1']); // 182.00 + 20.02 = 202.02; 33.33 + 3.67 = 37.00. 239.02
  gr.A2 = await receive(f.A, ['6', null]); // 273.00 + 30.03 = 303.03
  data(await run(u.agus, reverseGoodsReceipt, { goodsReceiptId: gr.A2, expectedVersion: await version('goods_receipts', gr.A2), reason: 'Wrong delivery' }));
  gr.A2R = (await t.pool.query('SELECT id FROM goods_receipts WHERE reverses_goods_receipt_id = $1', [gr.A2])).rows[0].id as string;
  gr.A3 = await receive(f.A, ['7', null]); // 318.50 + 35.04 (35.035) = 353.54; line 1 now 11 of 10
  gr.C1 = await receive(f.C, ['5']); // 110.94
  gr.F1 = await receive(f.F, ['1']); // 50.00 + 5.00 = 55.00
  // Neither counts anywhere: a draft left as it is, and a cancelled one.
  const draftOf = async (o: Fixture, quantities: (string | null)[]) =>
    data(
      await run(u.agus, createGoodsReceipt, {
        purchaseOrderId: o.purchaseOrderId,
        receivedOn: today(),
        deliveryNoteRef: null,
        notes: null,
        lines: o.lines.flatMap((purchaseOrderLineId, i) => (quantities[i] ? [{ purchaseOrderLineId, quantity: quantities[i], note: null }] : [])),
      }),
    ).goodsReceiptId;
  gr.Bdraft = await draftOf(f.B, ['1']);
  gr.Acancelled = await draftOf(f.A, [null, '2']);
  data(await run(u.agus, cancelGoodsReceipt, { goodsReceiptId: gr.Acancelled, expectedVersion: 1, reason: 'Counted twice' }));
  data(await run(u.dewi, cancelPurchaseOrder, { purchaseOrderId: f.D.purchaseOrderId, expectedVersion: await version('purchase_orders', f.D.purchaseOrderId), reason: 'Bought elsewhere' }));
  data(await run(u.dewi, closePurchaseOrder, { purchaseOrderId: f.F.purchaseOrderId, expectedVersion: await version('purchase_orders', f.F.purchaseOrderId), reason: 'Rest not needed' }));

  // G: returned once, then approved in round 2. H and I: waiting for a decision.
  const g = data(await run(u.rina, createRequisition, { title: 'Printer', justification: null, neededBy: '2030-06-30', lines: [{ description: 'Printer', quantity: '1', uom: 'pcs', estimatedUnitPrice: '150' }] }));
  const g1 = data(await run(u.rina, submitRequisition, { requisitionId: g.requisitionId, expectedVersion: 1 }));
  data(await run(u.bayu, decideApproval, { approvalRequestId: g1.approvalRequestId, stepNo: 1, expectedVersion: 1, decision: 'return', comment: 'Add the model' }));
  const g2 = data(await run(u.rina, submitRequisition, { requisitionId: g.requisitionId, expectedVersion: await version('purchase_requisitions', g.requisitionId) }));
  data(await run(u.bayu, decideApproval, { approvalRequestId: g2.approvalRequestId, stepNo: 1, expectedVersion: 1, decision: 'approve' }));
  pr.G = { requisitionId: g.requisitionId, number: g.number };
  for (const [key, as, title, price] of [['H', u.rina, 'Projector', '80.00'], ['I', u.tia, 'Staplers', '15.50']] as const) {
    const created = data(await run(as, createRequisition, { title, justification: null, neededBy: '2030-06-30', lines: [{ description: title, quantity: key === 'I' ? '2' : '1', uom: 'pcs', estimatedUnitPrice: price }] }));
    data(await run(as, submitRequisition, { requisitionId: created.requisitionId, expectedVersion: 1 }));
    pr[key] = { requisitionId: created.requisitionId, number: created.number };
  }

  // Back in time. Requisitions: [first submission, approval]; orders: [approved, issued].
  const cycles: [string, string, string][] = [
    [f.A.requisitionId, '2025-03-03T01:00:00Z', '2025-03-03T13:00:00Z'], // 12 h
    [f.B.requisitionId, '2025-03-04T00:00:00Z', '2025-03-05T06:00:00Z'], // 30 h
    [f.C.requisitionId, '2025-03-10T00:00:00Z', '2025-03-10T03:00:00Z'], // 3 h
    [f.D.requisitionId, '2025-03-11T00:00:00Z', '2025-03-13T00:00:00Z'], // 48 h
    [f.E.requisitionId, '2025-03-12T00:00:00Z', '2025-03-12T05:20:00Z'], // 5 h 20 min
    [f.F.requisitionId, '2025-02-01T00:00:00Z', '2025-02-02T00:00:00Z'], // 24 h, February
    [f.J.requisitionId, '2025-02-10T00:00:00Z', '2025-02-10T01:00:00Z'], // 1 h, February
  ];
  const orders: [string, string, string | null][] = [
    [f.A.purchaseOrderId, '2025-03-09T03:00:00Z', '2025-03-10T03:00:00Z'],
    [f.B.purchaseOrderId, '2025-03-19T03:00:00Z', '2025-03-20T03:00:00Z'],
    [f.C.purchaseOrderId, '2025-03-30T03:00:00Z', '2025-03-31T18:30:00Z'], // 1 April in Jakarta
    [f.D.purchaseOrderId, '2025-03-14T03:00:00Z', '2025-03-15T03:00:00Z'],
    [f.E.purchaseOrderId, '2025-03-18T03:00:00Z', null],
    [f.F.purchaseOrderId, '2025-02-24T03:00:00Z', '2025-02-25T03:00:00Z'],
    [f.J.purchaseOrderId, '2025-03-25T03:00:00Z', null],
  ];
  const received: [string, string][] = [
    [gr.F1, '2025-03-01'],
    [gr.A1, '2025-03-12'],
    [gr.A2, '2025-04-02'],
    [gr.A2R, '2025-04-05'],
    [gr.A3, '2025-04-06'],
    [gr.C1, '2025-04-03'],
    [gr.Bdraft, '2025-03-21'],
    [gr.Acancelled, '2025-04-03'],
  ];
  const tables = ['purchase_requisitions', 'approval_requests', 'approval_steps', 'purchase_orders', 'goods_receipts'];
  const client = await t.pool.connect();
  try {
    await client.query('BEGIN');
    for (const table of tables) await client.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
    for (const [id, submitted, approved] of cycles) {
      await client.query("UPDATE approval_requests SET created_at = $2 WHERE document_type = 'requisition' AND document_id = $1", [id, submitted]);
      await client.query('UPDATE purchase_requisitions SET submitted_at = $2, approved_at = $3 WHERE id = $1', [id, submitted, approved]);
    }
    // G: round 1 on 20 March, round 2 a day later, approved 34 h after the first submission.
    await client.query("UPDATE approval_requests SET created_at = $2 WHERE document_type = 'requisition' AND document_id = $1 AND round = 1", [pr.G.requisitionId, '2025-03-20T00:00:00Z']);
    await client.query("UPDATE approval_requests SET created_at = $2 WHERE document_type = 'requisition' AND document_id = $1 AND round = 2", [pr.G.requisitionId, '2025-03-21T00:00:00Z']);
    await client.query('UPDATE purchase_requisitions SET approved_at = $2 WHERE id = $1', [pr.G.requisitionId, '2025-03-21T10:00:00Z']);
    for (const [id, activated] of [[pr.H.requisitionId, '2025-04-01T00:00:00Z'], [pr.I.requisitionId, '2025-04-08T00:00:00Z']]) {
      await client.query(
        "UPDATE approval_steps SET activated_at = $2 WHERE status = 'pending' AND approval_request_id IN (SELECT id FROM approval_requests WHERE document_id = $1)",
        [id, activated],
      );
    }
    for (const [id, approved, issued] of orders) {
      await client.query('UPDATE purchase_orders SET approved_at = $2, issued_at = coalesce($3, issued_at) WHERE id = $1', [id, approved, issued]);
    }
    for (const [id, on] of received) await client.query('UPDATE goods_receipts SET received_on = $2 WHERE id = $1', [id, on]);
    for (const table of tables) await client.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await t.pool.query('UPDATE org_settings SET rfq_required_above = 500');
});

afterAll(async () => {
  await t?.drop();
});

const ALL = { from: '2025-02-01', to: '2025-04-30' };
const MARCH = { from: '2025-03-01', to: '2025-03-31' };

describe('P9-AC3: spend reports match the hand-computed figures', () => {
  it('issued basis by supplier: full totals on the issue date (org time zone), short-closed included, cancelled left out', async () => {
    const r = data(await report(u.sari, spendBySupplier, { ...ALL, basis: 'issued' }));
    expect(Object.keys(r).sort()).toEqual([...SPEND_REPORT_KEYS].sort());
    expect(r.asOf).toBe(NOW);
    expect(r.rows).toEqual([
      // A 616.05 + B 240.00
      { id: s.office.id, code: s.office.code, name: 'Example Office Supplies Ltd', currencyCode: currency, currencyScale: 2, poCount: 2, total: '856.05' },
      // F 220.00 (closed short) + C 110.94; D (cancelled) does not count
      { id: s.parts.id, code: s.parts.code, name: 'Sample Industrial Parts Co.', currencyCode: currency, currencyScale: 2, poCount: 2, total: '330.94' },
    ]);
    for (const row of r.rows) expect(Object.keys(row).sort()).toEqual([...SPEND_ROW_KEYS].sort());
    expect(r.totals).toEqual([{ currencyCode: currency, currencyScale: 2, total: '1186.99' }]);

    // C was issued at 18:30 UTC on 31 March: 1 April in Jakarta, so not in March.
    const march = data(await report(u.sari, spendBySupplier, { ...MARCH, basis: 'issued' }));
    expect(march.rows.map((row) => [row.name, row.poCount, row.total])).toEqual([['Example Office Supplies Ltd', 2, '856.05']]);
    expect(data(await report(u.sari, spendBySupplier, { from: '2025-04-01', to: '2025-04-01' })).rows.map((row) => row.total)).toEqual(['110.94']);
  });

  it('issued basis by department', async () => {
    const r = data(await report(u.dewi, spendByDepartment, ALL));
    expect(r.basis).toBe('issued');
    expect(r.rows.map((row) => [row.code, row.name, row.poCount, row.total])).toEqual([
      ['OPS', 'Operations', 3, '1076.05'], // A 616.05 + B 240.00 + F 220.00
      ['ADM', 'Administration', 1, '110.94'], // C
    ]);
    expect(r.totals.map((x) => x.total)).toEqual(['1186.99']);
  });

  it('received basis: each receipt line at the order price plus tax on its date, a reversal negative on its own date', async () => {
    const bySupplier = data(await report(u.lena, spendBySupplier, { ...ALL, basis: 'received' }));
    expect(bySupplier.rows.map((row) => [row.name, row.poCount, row.total])).toEqual([
      // 239.02 + 303.03 − 303.03 + 353.54 (over-received line 1 counts)
      ['Example Office Supplies Ltd', 1, '592.56'],
      // F 55.00 + C 110.94
      ['Sample Industrial Parts Co.', 2, '165.94'],
    ]);
    expect(bySupplier.totals.map((x) => x.total)).toEqual(['758.50']);
    // The view itself: one row per posted receipt line, each rounded as the order rounds it.
    const viewRows = await t.pool.query(
      'SELECT spend_on::text AS on, amount::text AS value FROM report_spend_received WHERE purchase_order_id = $1 ORDER BY spend_on, amount',
      [f.A.purchaseOrderId],
    );
    expect(viewRows.rows.map((r) => [r.on, r.value])).toEqual([
      ['2025-03-12', '37.00'], // 33.3333 → 33.33, tax 3.6663 → 3.67
      ['2025-03-12', '202.02'],
      ['2025-04-02', '303.03'],
      ['2025-04-05', '-303.03'],
      ['2025-04-06', '353.54'], // 318.50, tax 35.035 → 35.04
    ]);
    const byDepartment = data(await report(u.lena, spendByDepartment, { ...ALL, basis: 'received' }));
    expect(byDepartment.rows.map((row) => [row.code, row.poCount, row.total])).toEqual([
      ['OPS', 2, '647.56'],
      ['ADM', 1, '110.94'],
    ]);
    // Only the reversal falls on 5 April.
    expect(data(await report(u.lena, spendBySupplier, { from: '2025-04-05', to: '2025-04-05', basis: 'received' })).rows.map((row) => [row.name, row.total])).toEqual([
      ['Example Office Supplies Ltd', '-303.03'],
    ]);
    expect(data(await report(u.lena, spendBySupplier, { from: '2025-04-01', to: '2025-04-04', basis: 'received' })).rows.map((row) => row.total)).toEqual([
      '303.03',
      '110.94',
    ]);
  });
});

describe('P9-AC4: cycle time, approval aging, and open orders match the hand-computed figures', () => {
  it('cycle time: first submission to final approval, median and p90 with interpolation', async () => {
    const r = data(await report(u.sari, requisitionCycleTime, MARCH));
    expect(Object.keys(r).sort()).toEqual([...CYCLE_REPORT_KEYS].sort());
    // 3, 5.333…, 12, 30, 34 (G: from round 1), 48 hours.
    expect({ count: r.count, median: r.medianHours, p90: r.p90Hours }).toEqual({ count: 6, median: '21.00', p90: '41.00' });
    expect(r.rows.map((row) => [row.number, row.hours])).toEqual([
      [f.A.requisitionNumber, '12.00'],
      [f.B.requisitionNumber, '30.00'],
      [f.C.requisitionNumber, '3.00'],
      [f.E.requisitionNumber, '5.33'],
      [f.D.requisitionNumber, '48.00'],
      [pr.G.number, '34.00'],
    ]);
    for (const row of r.rows) expect(Object.keys(row).sort()).toEqual([...CYCLE_ROW_KEYS].sort());
    expect(r.rows[0]?.submittedAt).toBe('2025-03-03T01:00:00.000Z');

    const departments = new Map(r.departments.map((d) => [d.code, d.id]));
    const ops = data(await report(u.sari, requisitionCycleTime, { ...MARCH, departmentId: departments.get('OPS') }));
    expect([ops.count, ops.medianHours, ops.p90Hours]).toEqual([3, '30.00', '33.20']);
    const adm = data(await report(u.sari, requisitionCycleTime, { ...MARCH, departmentId: departments.get('ADM') }));
    expect([adm.count, adm.medianHours, adm.p90Hours]).toEqual([3, '5.33', '39.47']);
    const february = data(await report(u.sari, requisitionCycleTime, { from: '2025-02-01', to: '2025-02-28' }));
    expect([february.count, february.medianHours, february.p90Hours]).toEqual([2, '12.50', '21.70']);
  });

  it('approval aging: pending steps with whole days waited at asOf', async () => {
    const all = data(await report(u.lena, approvalAging, {}));
    expect(Object.keys(all).sort()).toEqual([...AGING_REPORT_KEYS].sort());
    expect(all.olderThanDays).toBe(0);
    expect(all.rows.map((row) => [row.documentNumber, row.ageDays, row.amount, row.departmentName, row.stepNo, row.requiredRole])).toEqual([
      [pr.H.number, 9, '80.00', 'Operations', 1, 'approver'],
      [pr.I.number, 2, '31.00', 'Administration', 1, 'approver'],
    ]);
    for (const row of all.rows) expect(Object.keys(row).sort()).toEqual([...AGING_ROW_KEYS].sort());
    expect(all.rows[0]?.pendingSince).toBe('2025-04-01T00:00:00.000Z');
    expect(data(await report(u.lena, approvalAging, { olderThanDays: 3 })).rows.map((row) => row.documentNumber)).toEqual([pr.H.number]);
    expect(data(await report(u.lena, approvalAging, { olderThanDays: 10 })).rows).toEqual([]);
  });

  it('open purchase orders: outstanding quantity and value per line, never negative', async () => {
    const r = data(await report(u.dewi, openPurchaseOrders, {}));
    expect(Object.keys(r).sort()).toEqual([...OPEN_ORDERS_REPORT_KEYS].sort());
    expect(r.rows).toEqual([
      {
        purchaseOrderId: f.A.purchaseOrderId,
        number: f.A.number,
        status: 'partially_received',
        supplierCode: s.office.code,
        supplierName: 'Example Office Supplies Ltd',
        departmentName: 'Operations',
        currencyCode: currency,
        currencyScale: 2,
        issuedOn: '2025-03-10',
        expectedDeliveryDate: null,
        openLines: 1,
        lineCount: 2,
        outstandingAmount: '74.00',
        lines: [
          { lineNo: 1, description: 'Office chair', uom: 'pcs', quantity: '10', receivedQty: '11', outstandingQty: '0', outstandingAmount: '0.00' },
          // 2 × 33.3333 = 66.6666 → 66.67; tax 7.3337 → 7.33
          { lineNo: 2, description: 'Cable set', uom: 'pcs', quantity: '3', receivedQty: '1', outstandingQty: '2', outstandingAmount: '74.00' },
        ],
      },
      {
        purchaseOrderId: f.B.purchaseOrderId,
        number: f.B.number,
        status: 'issued',
        supplierCode: s.office.code,
        supplierName: 'Example Office Supplies Ltd',
        departmentName: 'Operations',
        currencyCode: currency,
        currencyScale: 2,
        issuedOn: '2025-03-20',
        expectedDeliveryDate: null,
        openLines: 1,
        lineCount: 1,
        outstandingAmount: '240.00',
        lines: [{ lineNo: 1, description: '=2+3 desk lamps', uom: 'pcs', quantity: '2', receivedQty: '0', outstandingQty: '2', outstandingAmount: '240.00' }],
      },
    ]);
    for (const row of r.rows) expect(Object.keys(row).sort()).toEqual([...OPEN_ORDER_KEYS].sort());
    expect(r.totals.map((x) => x.total)).toEqual(['314.00']);
    expect(r.suppliers).toEqual([{ id: s.office.id, code: s.office.code, name: 'Example Office Supplies Ltd' }]);
    const parts = data(await report(u.dewi, openPurchaseOrders, { supplierId: s.parts.id }));
    expect([parts.rows, parts.totals, parts.supplierId]).toEqual([[], [], s.parts.id]);
  });
});

describe('P9-AC5: potential split purchases', () => {
  it('finds the split against both thresholds, and nothing in the control cases', async () => {
    const r = data(await report(u.lena, potentialSplitPurchases, ALL));
    expect(Object.keys(r).sort()).toEqual([...SPLIT_REPORT_KEYS].sort());
    expect(r.windowDays).toBe(30);
    expect(r.thresholds).toEqual({ poApproval: '1000.00', rfq: '500.00' });
    expect(r.groups).toEqual([
      {
        // Totals with tax: A 616.05 + B 240.00 + J 333.00, each below 1000, approved 9 to 25 March.
        threshold: 'po_approval',
        thresholdAmount: '1000.00',
        requesterName: 'Rina Requester',
        supplierCode: s.office.code,
        supplierName: 'Example Office Supplies Ltd',
        currencyCode: currency,
        currencyScale: 2,
        firstOn: '2025-03-09',
        lastOn: '2025-03-25',
        combinedAmount: '1189.05',
        orders: [
          { purchaseOrderId: f.A.purchaseOrderId, number: f.A.number, requisitionNumber: f.A.requisitionNumber, approvedOn: '2025-03-09', amount: '616.05' },
          { purchaseOrderId: f.B.purchaseOrderId, number: f.B.number, requisitionNumber: f.B.requisitionNumber, approvedOn: '2025-03-19', amount: '240.00' },
          { purchaseOrderId: f.J.purchaseOrderId, number: f.J.number, requisitionNumber: f.J.requisitionNumber, approvedOn: '2025-03-25', amount: '333.00' },
        ],
      },
      {
        // Subtotals without tax: A (555.00) is not below 500; B 240.00 + J 300.00.
        threshold: 'rfq',
        thresholdAmount: '500.00',
        requesterName: 'Rina Requester',
        supplierCode: s.office.code,
        supplierName: 'Example Office Supplies Ltd',
        currencyCode: currency,
        currencyScale: 2,
        firstOn: '2025-03-19',
        lastOn: '2025-03-25',
        combinedAmount: '540.00',
        orders: [
          { purchaseOrderId: f.B.purchaseOrderId, number: f.B.number, requisitionNumber: f.B.requisitionNumber, approvedOn: '2025-03-19', amount: '240.00' },
          { purchaseOrderId: f.J.purchaseOrderId, number: f.J.number, requisitionNumber: f.J.requisitionNumber, approvedOn: '2025-03-25', amount: '300.00' },
        ],
      },
    ]);
    for (const group of r.groups) expect(Object.keys(group).sort()).toEqual([...SPLIT_GROUP_KEYS].sort());
    // Controls: Tia's orders (C, E, and the cancelled D) and Rina's order from the other supplier (F)
    // never group; with a 5-day window B and J (6 days apart) do not either.
    const numbers = r.groups.flatMap((g) => g.orders.map((o) => o.number));
    for (const control of [f.C, f.D, f.E, f.F]) expect(numbers).not.toContain(control.number);
    expect(data(await report(u.lena, potentialSplitPurchases, { ...ALL, windowDays: 5 })).groups).toEqual([]);
    // A 10-day window: A+B (856.05) and B+J (573.00) stay below 1000; B+J still reach 500.
    expect(data(await report(u.lena, potentialSplitPurchases, { ...ALL, windowDays: 10 })).groups.map((g) => [g.threshold, g.combinedAmount])).toEqual([['rfq', '540.00']]);
  });

  it('a threshold that is not set is not checked', async () => {
    await t.pool.query('UPDATE org_settings SET rfq_required_above = NULL');
    try {
      const r = data(await report(u.lena, potentialSplitPurchases, ALL));
      expect(r.thresholds.rfq).toBeNull();
      expect(r.groups.map((g) => g.threshold)).toEqual(['po_approval']);
    } finally {
      await t.pool.query('UPDATE org_settings SET rfq_required_above = 500');
    }
  });
});

describe('P9-AC6: empty ranges and asOf', () => {
  it('a range with no data gives empty results, still with asOf', async () => {
    const empty = { from: '2020-01-01', to: '2020-01-31' };
    for (const op of [spendBySupplier, spendByDepartment]) {
      for (const basis of ['issued', 'received']) {
        const r = data(await report(u.sari, op, { ...empty, basis }));
        expect([r.rows, r.totals, r.asOf]).toEqual([[], [], NOW]);
      }
    }
    const cycle = data(await report(u.sari, requisitionCycleTime, empty));
    expect([cycle.count, cycle.medianHours, cycle.p90Hours, cycle.rows, cycle.asOf]).toEqual([0, null, null, [], NOW]);
    const split = data(await report(u.sari, potentialSplitPurchases, empty));
    expect([split.groups, split.asOf]).toEqual([[], NOW]);
  });

  it('every report response carries asOf, the time the figures were read', async () => {
    const real = data(await run(u.sari, approvalAging, {}));
    expect(Math.abs(Date.parse(real.asOf) - Date.now())).toBeLessThan(60_000);
    for (const [op, input] of [
      [spendBySupplier, ALL],
      [spendByDepartment, ALL],
      [requisitionCycleTime, ALL],
      [approvalAging, {}],
      [openPurchaseOrders, {}],
      [potentialSplitPurchases, ALL],
    ] as const) {
      expect((data(await report(u.sari, op as Operation<unknown, { asOf: string }>, input)) as { asOf: string }).asOf).toBe(NOW);
    }
  });
});

describe('P9-AC7/AC8: who sees reports and the audit trail', () => {
  const reports = [
    [spendBySupplier, ALL],
    [spendByDepartment, ALL],
    [requisitionCycleTime, ALL],
    [approvalAging, {}],
    [openPurchaseOrders, {}],
    [potentialSplitPurchases, ALL],
    [exportReport, { report: 'spendBySupplier', params: ALL }],
  ] as const;

  it('reports and exports: procurement, finance, and auditors; nobody else', async () => {
    for (const [op, input] of reports) {
      for (const as of [u.dewi, u.sari, u.lena]) expect(code(await report(as, op as Operation<unknown, unknown>, input))).toBe('ok');
      for (const as of [u.rina, u.bayu, u.agus, u.ada]) expect(code(await report(as, op as Operation<unknown, unknown>, input))).toBe('FORBIDDEN');
    }
  });

  it('audit search: auditors and admins only', async () => {
    for (const op of [searchAudit, auditFilterOptions]) {
      for (const as of [u.lena, u.ada]) expect(code(await run(as, op as Operation<unknown, unknown>, {}))).toBe('ok');
      for (const as of [u.rina, u.bayu, u.dewi, u.agus, u.sari]) expect(code(await run(as, op as Operation<unknown, unknown>, {}))).toBe('FORBIDDEN');
    }
  });

  it('rejects bad or extra report parameters', async () => {
    expect(code(await report(u.sari, spendBySupplier, { ...ALL, basis: 'paid' }))).toBe('VALIDATION_FAILED');
    expect(code(await report(u.sari, spendBySupplier, { from: '2025-04-30', to: '2025-04-01' }))).toBe('VALIDATION_FAILED');
    expect(code(await report(u.sari, spendBySupplier, { from: '2010-01-01', to: '2025-04-01' }))).toBe('VALIDATION_FAILED');
    expect(code(await report(u.sari, spendBySupplier, { ...ALL, supplierId: s.office.id }))).toBe('VALIDATION_FAILED');
    expect(code(await report(u.sari, spendBySupplier, { from: '2025-02-30', to: '2025-04-01' }))).toBe('VALIDATION_FAILED');
    expect(code(await report(u.sari, approvalAging, { olderThanDays: -1 }))).toBe('VALIDATION_FAILED');
    expect(code(await report(u.sari, potentialSplitPurchases, { ...ALL, windowDays: 91 }))).toBe('VALIDATION_FAILED');
    expect(code(await report(u.sari, requisitionCycleTime, { ...ALL, departmentId: 'OPS' }))).toBe('VALIDATION_FAILED');
    expect(code(await report(u.sari, openPurchaseOrders, { supplierId: s.office.id, status: 'issued' }))).toBe('VALIDATION_FAILED');
  });
});

describe('P9-AC7: CSV export', () => {
  it('is the report on screen as CSV: BOM, header, plain decimals, ISO dates', async () => {
    const r = data(await report(u.sari, exportReport, { report: 'spendBySupplier', params: { ...ALL, basis: 'issued' } }));
    expect(r.filename).toBe('spendBySupplier-2025-04-10.csv');
    expect(r.contentType).toBe('text/csv; charset=utf-8');
    expect(r.csv).toBe(
      `${CSV_BOM}Supplier code,Supplier,Basis,Purchase orders,Currency,Total,As of\r\n` +
        `${s.office.code},Example Office Supplies Ltd,issued,2,${currency},856.05,${NOW}\r\n` +
        `${s.parts.code},Sample Industrial Parts Co.,issued,2,${currency},330.94,${NOW}\r\n`,
    );
    const received = data(await report(u.sari, exportReport, { report: 'spendBySupplier', params: { from: '2025-04-05', to: '2025-04-05', basis: 'received' } }));
    // A negative amount is a number, not a formula: no apostrophe.
    expect(received.csv.split('\r\n')[1]).toBe(`${s.office.code},Example Office Supplies Ltd,received,1,${currency},-303.03,${NOW}`);
  });

  it('neutralizes text that a spreadsheet would run as a formula', async () => {
    const r = data(await report(u.dewi, exportReport, { report: 'openPurchaseOrders', params: {} }));
    const lampLine = r.csv.split('\r\n').find((line) => line.includes('desk lamps'));
    expect(lampLine).toBe(`${f.B.number},issued,${s.office.code},Example Office Supplies Ltd,Operations,2025-03-20,,1,'=2+3 desk lamps,pcs,2,0,2,${currency},240.00,${NOW}`);
  });

  it('exports every report, and an empty one is the header only', async () => {
    for (const [name, params] of [
      ['spendByDepartment', ALL],
      ['requisitionCycleTime', MARCH],
      ['approvalAging', { olderThanDays: '3' }],
      ['openPurchaseOrders', {}],
      ['potentialSplitPurchases', { ...ALL, windowDays: '30' }],
    ] as const) {
      const r = data(await report(u.lena, exportReport, { report: name, params }));
      expect(r.csv.startsWith(CSV_BOM)).toBe(true);
      expect(r.csv.split('\r\n').length).toBeGreaterThan(2);
    }
    expect(data(await report(u.lena, exportReport, { report: 'approvalAging', params: { olderThanDays: '3' } })).csv).toContain(`,${pr.H.number},`);
    const split = data(await report(u.lena, exportReport, { report: 'potentialSplitPurchases', params: ALL })).csv.split('\r\n');
    expect(split.length).toBe(1 + 5 + 1); // header, A+B+J and B+J, the final CRLF
    const empty = data(await report(u.lena, exportReport, { report: 'requisitionCycleTime', params: { from: '2020-01-01', to: '2020-01-31' } }));
    expect(empty.csv).toBe(`${CSV_BOM}Requisition,Department,First submitted,Approved,Hours,As of\r\n`);
  });

  it('validates the report name and its parameters like the report itself', async () => {
    expect(code(await report(u.sari, exportReport, { report: 'salaries', params: {} }))).toBe('VALIDATION_FAILED');
    expect(code(await report(u.sari, exportReport, { report: 'spendBySupplier', params: { from: '2025-04-30', to: '2025-04-01' } }))).toBe('VALIDATION_FAILED');
    const unknown = await report(u.sari, exportReport, { report: 'spendBySupplier', params: { ...ALL, departmentId: s.office.id } });
    expect(code(unknown)).toBe('VALIDATION_FAILED');
    expect(unknown.ok ? null : Object.keys(unknown.error.fieldErrors ?? {})).toEqual(['params._form']);
    expect(code(await report(u.sari, exportReport, { report: 'approvalAging', params: { olderThanDays: 'many' } }))).toBe('VALIDATION_FAILED');
    expect(code(await report(u.sari, exportReport, { report: 'spendBySupplier', params: ALL, format: 'xlsx' }))).toBe('VALIDATION_FAILED');
  });
});

describe('P9-AC1: audit search', () => {
  it('filters by record, newest first, with the client details only audit search shows', async () => {
    const r = data(await run(u.lena, searchAudit, { entityType: 'purchase_order', entityId: f.B.purchaseOrderId }));
    expect(r.items.map((e) => e.action)).toEqual(['po.issued', 'po.submitted', 'po.created']);
    for (const item of r.items) expect(Object.keys(item).sort()).toEqual([...AUDIT_EVENT_KEYS].sort());
    const issued = r.items[0];
    expect(issued).toMatchObject({ actor: 'Dewi Procurement', actorRoles: ['procurement'], ip: '203.0.113.7', userAgent: 'ReportTest/1.0', entityType: 'purchase_order' });
    expect(issued?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(issued?.changes).toContainEqual({ field: 'status', before: 'approved', after: 'issued' });
    expect(Number(r.items[0]?.id)).toBeGreaterThan(Number(r.items[1]?.id));
    expect(r.nextCursor).toBeNull();
  });

  it('filters by person, action, and org dates', async () => {
    const agus = data(await run(u.lena, searchAudit, { actorUserId: u.agus, limit: 100 }));
    expect(agus.items.length).toBeGreaterThan(0);
    expect(new Set(agus.items.map((e) => e.actor))).toEqual(new Set(['Agus Receiver']));
    const reversed = data(await run(u.ada, searchAudit, { action: 'receipt.reversed' }));
    expect(reversed.items.map((e) => [e.entityId, e.reason])).toEqual([[gr.A2, 'Wrong delivery']]);
    // Events happened today (real time); none before.
    const todayInJakarta = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
    expect(data(await run(u.lena, searchAudit, { from: todayInJakarta, action: 'receipt.reversed' })).items).toHaveLength(1);
    // Both ends are inclusive org dates.
    expect(data(await run(u.lena, searchAudit, { from: todayInJakarta, to: todayInJakarta, action: 'receipt.reversed' })).items).toHaveLength(1);
    expect(data(await run(u.lena, searchAudit, { to: '2025-01-01' })).items).toEqual([]);
    expect(data(await run(u.lena, searchAudit, { entityType: 'goods_receipt', entityId: '00000000-0000-0000-0000-000000000000' })).items).toEqual([]);
  });

  it('pages with a cursor, without gaps or repeats', async () => {
    const all = data(await run(u.lena, searchAudit, { actorUserId: u.dewi, limit: 100 })).items.map((e) => e.id);
    expect(all.length).toBeGreaterThan(5);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { items: { id: string }[]; nextCursor: string | null } = data(
        await run(u.lena, searchAudit, { actorUserId: u.dewi, limit: 4, ...(cursor ? { cursor } : {}) }),
      );
      expect(page.items.length).toBeLessThanOrEqual(4);
      seen.push(...page.items.map((e) => e.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(all);
  });

  it('validates its filters', async () => {
    for (const input of [
      { action: 'DROP TABLE' },
      { cursor: 'abc' },
      { entityType: 'salary' },
      { actorUserId: 'dewi' },
      { from: '2025-04-30', to: '2025-04-01' },
      { limit: 1000 },
      { entityId: 'x', include: 'ip' },
    ]) {
      expect(code(await run(u.lena, searchAudit, input))).toBe('VALIDATION_FAILED');
    }
  });

  it('offers the people and record types to filter by', async () => {
    const options = data(await run(u.lena, auditFilterOptions, {}));
    expect(options.users.map((x) => x.name)).toContain('Agus Receiver');
    expect(options.entityTypes).toContain('purchase_order');
  });
});

describe('P9-AC2: document history', () => {
  const actionsOf = (history: { action: string }[]) => history.map((h) => h.action);

  it('each document shows its own trail, oldest first, without request id, IP, or user agent', async () => {
    const requisition = data(await run(u.rina, getRequisition, { requisitionId: pr.G.requisitionId }));
    expect(actionsOf(requisition.history)).toEqual(['requisition.created', 'requisition.submitted', 'requisition.returned', 'requisition.submitted', 'requisition.approved']);
    for (const entry of requisition.history) expect(Object.keys(entry).sort()).toEqual([...HISTORY_ENTRY_KEYS].sort());
    expect(requisition.history[0]?.actor).toBe('Rina Requester');

    const po = data(await run(u.dewi, getPurchaseOrder, { purchaseOrderId: f.B.purchaseOrderId }));
    expect(actionsOf(po.history)).toEqual(['po.created', 'po.submitted', 'po.issued']);
    expect(JSON.stringify(po.history)).not.toContain('203.0.113.7');
    expect(JSON.stringify(po.history)).not.toContain('ReportTest');

    const receipt = data(await run(u.agus, getGoodsReceipt, { goodsReceiptId: gr.A2 }));
    expect(actionsOf(receipt.history)).toEqual(['receipt.created', 'receipt.posted', 'receipt.reversed']);
    expect(receipt.history.at(-1)?.reason).toBe('Wrong delivery');

    const supplier = data(await run(u.sari, getSupplier, { supplierId: s.office.id }));
    expect(actionsOf(supplier.history)).toEqual(['supplier.created', 'supplier.reviewed']);
  });

  it('is shown only to whoever can read the document', async () => {
    // Tia (another department) cannot read Rina's requisition, so she gets no history either.
    expect(code(await run(u.tia, getRequisition, { requisitionId: pr.G.requisitionId }))).toBe('NOT_FOUND');
    expect(code(await run(u.rina, getGoodsReceipt, { goodsReceiptId: gr.A1 }))).toBe('FORBIDDEN');
  });
});
