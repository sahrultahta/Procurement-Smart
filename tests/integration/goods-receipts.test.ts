import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { publishApprovalPolicy } from '@/modules/organization';
import {
  PO_RECEIVABLE_KEYS,
  cancelPurchaseOrder,
  closePurchaseOrder,
  createPurchaseOrder,
  getPurchaseOrder,
  issuePurchaseOrder,
  listReceivableOrders,
  submitPurchaseOrder,
} from '@/modules/purchasing';
import {
  GR_DETAIL_KEYS,
  GR_FORM_LINE_KEYS,
  GR_FORM_OPTIONS_KEYS,
  GR_LINE_KEYS,
  GR_ORDER_KEYS,
  GR_SUMMARY_KEYS,
  cancelGoodsReceipt,
  createGoodsReceipt,
  getGoodsReceipt,
  goodsReceiptFormOptions,
  listGoodsReceipts,
  postGoodsReceipt,
  reverseGoodsReceipt,
} from '@/modules/receiving';
import { createRequisition, submitRequisition } from '@/modules/requisitions';
import { blockSupplier, createSupplier, reviewSupplier } from '@/modules/suppliers';
import { decideApproval } from '@/server/approvals';
import { runCommand, runQuery, type Operation } from '@/shared/application/runner';
import type { Result } from '@/shared/result';
import { contextOf, provisionActor } from '../support/actors';
import { createTestDatabase, sqlStateOf, type TestDatabase } from '../support/test-db';

/* Phase 8: goods receipts, as the runtime role through the command runner. */

let t: TestDatabase;
type Persona = 'rina' | 'bayu' | 'dewi' | 'fajar' | 'pia' | 'agus' | 'rudi' | 'sari' | 'lena' | 'ada';
const u = {} as Record<Persona, string>;
let supplierCount = 0;
let office = '';

async function run<I, O>(as: string, op: Operation<I, O>, input: unknown): Promise<Result<O>> {
  const context = await contextOf(t.appDb, as);
  return op.kind === 'command' ? runCommand(context, op, input, { db: t.appDb }) : runQuery(context, op, input, { db: t.appDb });
}

function data<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.data;
}

const rule = (result: Result<unknown>) => (result.ok ? 'ok' : (result.error.rule ?? result.error.code));
const fieldErrors = (result: Result<unknown>) => (result.ok ? 'ok' : result.error.fieldErrors);

async function newSupplier(legalName: string): Promise<string> {
  supplierCount++;
  const created = data(
    await run(u.dewi, createSupplier, {
      legalName,
      taxId: `EX-8000-${String(supplierCount).padStart(4, '0')}`,
      email: `goods${supplierCount}@example.com`,
      phone: '+1 555 0180',
      addressLine1: '800 Example Way',
      addressLine2: null,
      city: 'Springfield',
      region: null,
      postalCode: '00080',
      countryCode: 'US',
    }),
  );
  data(await run(u.sari, reviewSupplier, { supplierId: created.supplierId, expectedVersion: 1, decision: 'approve', note: null }));
  return created.supplierId;
}

/** Below the PO approval threshold, no RFQ needed; 10 % over-receipt tolerance. */
const RULES = "UPDATE org_settings SET rfq_required_above = NULL, po_approval_threshold = 1000, po_price_tolerance_pct = 5, over_receipt_tolerance_pct = 10";

beforeAll(async () => {
  t = await createTestDatabase();
  await t.pool.query("INSERT INTO departments (code, name) VALUES ('OPS', 'Operations')");
  u.rina = await provisionActor(t.appDb, 'rina@example.com', 'Rina Requester', ['requester'], { departmentCode: 'OPS' });
  u.bayu = await provisionActor(t.appDb, 'bayu@example.com', 'Bayu Approver', [{ role: 'approver', departmentCode: 'OPS' }], { departmentCode: 'OPS' });
  u.dewi = await provisionActor(t.appDb, 'dewi@example.com', 'Dewi Procurement', ['procurement']);
  u.fajar = await provisionActor(t.appDb, 'fajar@example.com', 'Fajar Procurement', ['procurement']);
  // A buyer who also receives: SOD-04 applies to the orders she created.
  u.pia = await provisionActor(t.appDb, 'pia@example.com', 'Pia Buyer-Receiver', ['procurement', 'receiver']);
  u.agus = await provisionActor(t.appDb, 'agus@example.com', 'Agus Receiver', ['receiver']);
  u.rudi = await provisionActor(t.appDb, 'rudi@example.com', 'Rudi Receiver', ['receiver']);
  u.sari = await provisionActor(t.appDb, 'sari@example.com', 'Sari Finance', ['finance']);
  u.lena = await provisionActor(t.appDb, 'lena@example.com', 'Lena Auditor', ['auditor']);
  u.ada = await provisionActor(t.appDb, 'ada@example.com', 'Ada Admin', ['admin']);
  office = await newSupplier('Example Office Supplies Ltd');
  data(
    await run(u.ada, publishApprovalPolicy, {
      documentType: 'requisition',
      name: 'One step',
      rules: [{ departmentCode: null, minAmount: '0', maxAmount: null, steps: [{ role: 'approver', scopeMode: 'document_department' }] }],
    }),
  );
  await t.pool.query(RULES);
});

afterAll(async () => {
  await t?.drop();
});

/**
 * After every test: GR-I1 (each order line's received quantity is its posted receipts less their
 * reversals), PO-T06 (an issued order's status is what its lines say), and PO-I1.
 */
afterEach(async () => {
  const received = await t.pool.query(`
    SELECT pl.id, pl.received_qty::text AS received FROM purchase_order_lines pl
    LEFT JOIN goods_receipt_lines l ON l.purchase_order_line_id = pl.id
    LEFT JOIN goods_receipts g ON g.id = l.goods_receipt_id
    GROUP BY pl.id, pl.received_qty
    HAVING pl.received_qty <> coalesce(sum(CASE g.kind WHEN 'receipt' THEN l.quantity ELSE -l.quantity END) FILTER (WHERE g.status = 'posted'), 0)`);
  expect(received.rows).toEqual([]);
  const statuses = await t.pool.query(`
    SELECT po.id, po.status FROM purchase_orders po JOIN purchase_order_lines l ON l.purchase_order_id = po.id
    WHERE po.status IN ('issued', 'partially_received', 'received')
    GROUP BY po.id, po.status
    HAVING po.status <> CASE WHEN bool_and(l.received_qty >= l.quantity) THEN 'received' WHEN bool_or(l.received_qty > 0) THEN 'partially_received' ELSE 'issued' END`);
  expect(statuses.rows).toEqual([]);
  const ordered = await t.pool.query(`
    SELECT r.id FROM requisition_lines r
    LEFT JOIN purchase_order_lines l ON l.requisition_line_id = r.id
    LEFT JOIN purchase_orders po ON po.id = l.purchase_order_id
    GROUP BY r.id, r.ordered_qty
    HAVING r.ordered_qty <> coalesce(sum(CASE WHEN po.status = 'closed' THEN least(l.quantity, l.received_qty) ELSE l.quantity END)
      FILTER (WHERE po.status NOT IN ('cancelled', 'rejected')), 0)`);
  expect(ordered.rows).toEqual([]);
  await t.pool.query(RULES);
});

/** The org date (the tests run with the default UTC time zone). */
const today = () => new Date().toISOString().slice(0, 10);
const daysFromToday = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

type Order = { purchaseOrderId: string; number: string; chair: string; mat: string; requisitionLines: string[] };

/** 10 chairs at 50 and 4 mats at 20 (580.00, approved at once), issued by `as`: receivable up to 11 and 4.4. */
async function issuedOrder(as = u.dewi, issue = true, supplierId = office): Promise<Order> {
  const requisition = data(
    await run(u.rina, createRequisition, {
      title: 'Meeting room furniture',
      justification: null,
      neededBy: '2030-06-30',
      lines: [
        { description: 'Ergonomic office chair', quantity: '10', uom: 'pcs', estimatedUnitPrice: '50' },
        { description: 'Chair mat', quantity: '4', uom: 'pcs', estimatedUnitPrice: '20' },
      ],
    }),
  );
  const submitted = data(await run(u.rina, submitRequisition, { requisitionId: requisition.requisitionId, expectedVersion: 1 }));
  data(await run(u.bayu, decideApproval, { approvalRequestId: submitted.approvalRequestId, stepNo: 1, expectedVersion: 1, decision: 'approve' }));
  const requisitionLines = (await t.pool.query('SELECT id FROM requisition_lines WHERE requisition_id = $1 ORDER BY line_no', [requisition.requisitionId])).rows.map((r) => r.id as string);
  const created = data(
    await run(as, createPurchaseOrder, {
      requisitionId: requisition.requisitionId,
      supplierId,
      paymentTerms: 'Net 30',
      deliveryAddress: null,
      expectedDeliveryDate: null,
      lines: [
        { requisitionLineId: requisitionLines[0], quantity: '10', unitPrice: '50', taxRatePct: '0' },
        { requisitionLineId: requisitionLines[1], quantity: '4', unitPrice: '20', taxRatePct: '0' },
      ],
    }),
  );
  expect(data(await run(as, submitPurchaseOrder, { purchaseOrderId: created.purchaseOrderId, expectedVersion: 1 })).status).toBe('approved');
  if (issue) data(await run(as, issuePurchaseOrder, { purchaseOrderId: created.purchaseOrderId, expectedVersion: 2 }));
  const [chair, mat] = (await t.pool.query('SELECT id FROM purchase_order_lines WHERE purchase_order_id = $1 ORDER BY line_no', [created.purchaseOrderId])).rows.map(
    (r) => r.id as string,
  );
  if (!chair || !mat) throw new Error('order lines missing');
  return { purchaseOrderId: created.purchaseOrderId, number: created.number, chair, mat, requisitionLines };
}

type Qty = string | null;

function receiptInput(order: Order, quantities: [Qty, Qty], overrides: Record<string, unknown> = {}) {
  return {
    purchaseOrderId: order.purchaseOrderId,
    receivedOn: today(),
    deliveryNoteRef: 'DN-1001',
    notes: null,
    lines: [order.chair, order.mat].flatMap((purchaseOrderLineId, i) => {
      const quantity = quantities[i];
      return quantity ? [{ purchaseOrderLineId, quantity, note: null }] : [];
    }),
    ...overrides,
  };
}

const draft = async (order: Order, quantities: [Qty, Qty], as = u.agus) => data(await run(as, createGoodsReceipt, receiptInput(order, quantities)));
const receiptVersion = async (id: string) => (await t.pool.query('SELECT version FROM goods_receipts WHERE id = $1', [id])).rows[0].version as number;
const post = async (goodsReceiptId: string, as = u.agus) => run(as, postGoodsReceipt, { goodsReceiptId, expectedVersion: await receiptVersion(goodsReceiptId) });
const reverse = async (goodsReceiptId: string, reason: unknown = 'Delivered to the wrong site', as = u.agus) =>
  run(as, reverseGoodsReceipt, { goodsReceiptId, expectedVersion: await receiptVersion(goodsReceiptId), reason });
const cancelDraft = async (goodsReceiptId: string, reason: unknown = null, as = u.agus) =>
  run(as, cancelGoodsReceipt, { goodsReceiptId, expectedVersion: await receiptVersion(goodsReceiptId), reason });

/** Recorded and posted: what a receiver does when goods arrive. */
async function receive(order: Order, quantities: [Qty, Qty], as = u.agus): Promise<{ goodsReceiptId: string; number: string }> {
  const created = await draft(order, quantities, as);
  data(await post(created.goodsReceiptId, as));
  return created;
}

const receivedQty = async (lineId: string) => (await t.pool.query('SELECT received_qty::text AS q FROM purchase_order_lines WHERE id = $1', [lineId])).rows[0].q as string;
const orderStatus = async (id: string) => (await t.pool.query('SELECT status FROM purchase_orders WHERE id = $1', [id])).rows[0].status as string;
const orderVersion = async (id: string) => (await t.pool.query('SELECT version FROM purchase_orders WHERE id = $1', [id])).rows[0].version as number;
const orderedQty = async (lineId: string) => (await t.pool.query('SELECT ordered_qty::text AS q FROM requisition_lines WHERE id = $1', [lineId])).rows[0].q as string;
const auditOf = async (entityId: string) =>
  (await t.pool.query('SELECT action, actor_user_id AS actor, changes, reason FROM audit_events WHERE entity_id = $1 ORDER BY id', [entityId])).rows;
const getReceipt = async (as: string, goodsReceiptId: string) => data(await run(as, getGoodsReceipt, { goodsReceiptId }));
const closeOrder = async (id: string, reason: unknown = 'Supplier cannot deliver the rest', as = u.dewi) =>
  run(as, closePurchaseOrder, { purchaseOrderId: id, expectedVersion: await orderVersion(id), reason });
const cancelOrder = async (id: string, as = u.dewi) => run(as, cancelPurchaseOrder, { purchaseOrderId: id, expectedVersion: await orderVersion(id), reason: 'No longer needed' });

/** Runs statements in one transaction on `pool` and returns the SQLSTATE it failed with, or 'none' after COMMIT. */
async function inTransaction(pool: TestDatabase['pool'], statements: [string, unknown[]][]): Promise<string> {
  const client = await pool.connect();
  try {
    return await sqlStateOf(async () => {
      try {
        await client.query('BEGIN');
        for (const [statement, params] of statements) await client.query(statement, params);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  } finally {
    client.release();
  }
}

let directNumber = 0;
/** A goods-receipt number no command allocates (year 2099). */
const directGrNumber = () => `GR-2099-${String(++directNumber).padStart(6, '0')}`;

describe('P8-AC2: recording a receipt (GR-T01)', () => {
  it('records a draft against an issued order, numbered and audited; nothing is received until it is posted', async () => {
    const order = await issuedOrder();
    const before = await orderVersion(order.purchaseOrderId);
    const result = data(
      await run(u.agus, createGoodsReceipt, {
        ...receiptInput(order, ['4', null]),
        deliveryNoteRef: '  DN-2030-77 ',
        notes: '',
        lines: [{ purchaseOrderLineId: order.chair, quantity: '4', note: 'Two boxes dented' }],
      }),
    );
    expect(result).toEqual({ goodsReceiptId: expect.any(String), number: expect.stringMatching(/^GR-\d{4}-\d{6}$/), version: 1 });
    expect(await receivedQty(order.chair)).toBe('0.000');
    expect([await orderStatus(order.purchaseOrderId), await orderVersion(order.purchaseOrderId)]).toEqual(['issued', before]);
    const receipt = await getReceipt(u.agus, result.goodsReceiptId);
    expect(receipt).toMatchObject({
      number: result.number,
      kind: 'receipt',
      status: 'draft',
      purchaseOrder: { id: order.purchaseOrderId, number: order.number, status: 'issued', supplierName: 'Example Office Supplies Ltd' },
      receivedOn: today(),
      deliveryNoteRef: 'DN-2030-77',
      notes: null,
      reason: null,
      reverses: null,
      reversedBy: null,
      createdBy: 'Agus Receiver',
      postedBy: null,
      version: 1,
      callerActions: ['post', 'cancel'],
    });
    expect(receipt.lines).toEqual([
      expect.objectContaining({ lineNo: 1, description: 'Ergonomic office chair', uom: 'pcs', quantity: '4', note: 'Two boxes dented', orderedQty: '10', receivedQty: '0', maxReceivableQty: '11' }),
    ]);
    expect(await auditOf(result.goodsReceiptId)).toEqual([
      {
        action: 'receipt.created',
        actor: u.agus,
        reason: null,
        changes: {
          number: [null, result.number],
          purchaseOrder: [null, order.number],
          kind: [null, 'receipt'],
          receivedOn: [null, today()],
          deliveryNoteRef: [null, 'DN-2030-77'],
          lines: [null, ['1. 4 pcs Ergonomic office chair (Two boxes dented)']],
          status: [null, 'draft'],
        },
      },
    ]);
  });

  it('only issued or partially received orders: NOT_FOUND before issue or after cancelling, PO_NOT_RECEIVABLE once received or closed', async () => {
    const approved = await issuedOrder(u.dewi, false);
    expect(rule(await run(u.agus, createGoodsReceipt, receiptInput(approved, ['1', null])))).toBe('NOT_FOUND');
    data(await cancelOrder(approved.purchaseOrderId));
    expect(rule(await run(u.agus, createGoodsReceipt, receiptInput(approved, ['1', null])))).toBe('NOT_FOUND');

    const closed = await issuedOrder();
    data(await closeOrder(closed.purchaseOrderId));
    expect(rule(await run(u.agus, createGoodsReceipt, receiptInput(closed, ['1', null])))).toBe('PO_NOT_RECEIVABLE');

    const full = await issuedOrder();
    await receive(full, ['10', '4']);
    expect(await orderStatus(full.purchaseOrderId)).toBe('received');
    const refused = await run(u.agus, createGoodsReceipt, receiptInput(full, ['1', null]));
    expect(refused).toMatchObject({ ok: false, error: { code: 'BUSINESS_RULE', rule: 'PO_NOT_RECEIVABLE', message: `Purchase order ${full.number} is received, so it takes no more goods receipts.` } });

    const partial = await issuedOrder();
    await receive(partial, ['5', null]);
    expect(rule(await run(u.agus, createGoodsReceipt, receiptInput(partial, ['1', null])))).toBe('ok');
    expect(rule(await run(u.agus, createGoodsReceipt, receiptInput(partial, ['1', null], { purchaseOrderId: '00000000-0000-7000-8000-000000000000' })))).toBe('NOT_FOUND');
  });

  it('SOD-04: whoever created the order cannot receive against it (ORDER_RECEIVE_CONFLICT), in the app and in the database', async () => {
    const order = await issuedOrder(u.pia);
    const refused = await run(u.pia, createGoodsReceipt, receiptInput(order, ['1', null]));
    expect(refused).toMatchObject({ ok: false, error: { rule: 'ORDER_RECEIVE_CONFLICT', message: `You created purchase order ${order.number}, so someone else must receive its goods.` } });
    expect(
      await sqlStateOf(() =>
        t.appPool.query("INSERT INTO goods_receipts (number, purchase_order_id, received_on, created_by_user_id) VALUES ($1, $2, current_date, $3)", [
          directGrNumber(),
          order.purchaseOrderId,
          u.pia,
        ]),
      ),
    ).toBe('PFG01');
    // Another receiver can; a buyer who did not create it but cannot receive, cannot.
    expect(rule(await run(u.agus, createGoodsReceipt, receiptInput(order, ['1', null])))).toBe('ok');
    expect((await getReceipt(u.pia, (await draft(order, ['1', null], u.rudi)).goodsReceiptId)).callerActions).toEqual([]);
  });

  it('validates lines, dates, and lengths; refuses fields the client may not send', async () => {
    const order = await issuedOrder();
    const other = await issuedOrder();
    const attempt = (overrides: Record<string, unknown>) => run(u.agus, createGoodsReceipt, { ...receiptInput(order, ['1', null]), ...overrides });
    expect(fieldErrors(await attempt({ lines: [{ purchaseOrderLineId: other.chair, quantity: '1', note: null }] }))).toEqual({
      'lines.0.purchaseOrderLineId': [`This line is not on purchase order ${order.number}.`],
    });
    expect(
      fieldErrors(
        await attempt({
          lines: [
            { purchaseOrderLineId: order.chair, quantity: '1', note: null },
            { purchaseOrderLineId: order.chair, quantity: '2', note: null },
          ],
        }),
      ),
    ).toEqual({ 'lines.1.purchaseOrderLineId': ['This line is received twice'] });
    expect(fieldErrors(await attempt({ receivedOn: daysFromToday(1) }))).toEqual({ receivedOn: ['Goods cannot be received in the future'] });
    expect(fieldErrors(await attempt({ receivedOn: daysFromToday(-1) }))).toEqual({
      receivedOn: [`Purchase order ${order.number} was issued on ${today()}: goods are received on or after that day`],
    });
    for (const overrides of [
      { lines: [] },
      { lines: [{ purchaseOrderLineId: order.chair, quantity: '0', note: null }] },
      { lines: [{ purchaseOrderLineId: order.chair, quantity: '-1', note: null }] },
      { lines: [{ purchaseOrderLineId: order.chair, quantity: '1.2345', note: null }] },
      { lines: [{ purchaseOrderLineId: order.chair, quantity: 1, note: null }] },
      { lines: [{ purchaseOrderLineId: order.chair, quantity: '1', note: 'x'.repeat(501) }] },
      { lines: [{ purchaseOrderLineId: order.chair, quantity: '1', note: null, receivedQty: '0' }] },
      { receivedOn: '26/10/2030' },
      { deliveryNoteRef: 'x'.repeat(101) },
      { notes: 'x'.repeat(1001) },
      { status: 'posted' },
      { number: 'GR-2030-000001' },
      { kind: 'reversal' },
      { createdByUserId: u.rudi },
      { purchaseOrderId: 'not-a-uuid' },
    ]) {
      expect({ overrides, result: rule(await attempt(overrides)) }).toEqual({ overrides, result: 'VALIDATION_FAILED' });
    }
    expect((await t.pool.query('SELECT count(*)::int AS n FROM goods_receipts WHERE purchase_order_id = $1', [order.purchaseOrderId])).rows[0].n).toBe(0);
  });

  it('OVER_RECEIPT at create names every line that is over, with what it can still take; exactly the rest is fine', async () => {
    const order = await issuedOrder();
    const refused = await run(u.agus, createGoodsReceipt, receiptInput(order, ['11.001', '4.401']));
    expect(refused).toMatchObject({
      ok: false,
      error: {
        code: 'BUSINESS_RULE',
        rule: 'OVER_RECEIPT',
        message: 'Line 1 can take only 11 pcs more, so nothing on this receipt was received.',
        details: [
          { lineNo: 1, remaining: '11' },
          { lineNo: 2, remaining: '4.4' },
        ],
      },
    });
    expect(rule(await run(u.agus, createGoodsReceipt, receiptInput(order, ['11', '4.4'])))).toBe('ok');
  });

  it('a blocked supplier’s issued order still takes receipts (SUP-R1)', async () => {
    const supplierId = await newSupplier('Blocked After Issue Ltd');
    const order = await issuedOrder(u.dewi, true, supplierId);
    const version = (await t.pool.query('SELECT version FROM suppliers WHERE id = $1', [supplierId])).rows[0].version as number;
    data(await run(u.sari, blockSupplier, { supplierId, expectedVersion: version, reason: 'Late deliveries' }));
    await receive(order, ['2', null]);
    expect(await orderStatus(order.purchaseOrderId)).toBe('partially_received');
    expect(rule(await reverse((await receive(order, ['1', null])).goodsReceiptId))).toBe('ok');
  });

  it('idempotent: the same key returns the same draft; the key with another input is refused', async () => {
    const order = await issuedOrder();
    const input = { ...receiptInput(order, ['1', null]), idempotencyKey: 'gr-key-0001' };
    const first = data(await run(u.agus, createGoodsReceipt, input));
    expect(data(await run(u.agus, createGoodsReceipt, input))).toEqual(first);
    expect(rule(await run(u.agus, createGoodsReceipt, { ...input, deliveryNoteRef: 'DN-other' }))).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await t.pool.query('SELECT count(*)::int AS n FROM goods_receipts WHERE purchase_order_id = $1', [order.purchaseOrderId])).rows[0].n).toBe(1);
  });

  it('only receivers record receipts', async () => {
    const order = await issuedOrder();
    for (const as of [u.rina, u.bayu, u.dewi, u.sari, u.lena, u.ada]) expect(rule(await run(as, createGoodsReceipt, receiptInput(order, ['1', null])))).toBe('FORBIDDEN');
  });
});

describe('P8-AC3: posting (GR-T02)', () => {
  it('adds every line, derives the order’s status and changes its version, and audits the receipt and the order', async () => {
    const order = await issuedOrder();
    const first = await draft(order, ['6', '1.5']);
    const version = await orderVersion(order.purchaseOrderId);
    expect(data(await post(first.goodsReceiptId))).toEqual({ version: 2, status: 'posted', purchaseOrderStatus: 'partially_received' });
    expect([await receivedQty(order.chair), await receivedQty(order.mat)]).toEqual(['6.000', '1.500']);
    expect([await orderStatus(order.purchaseOrderId), await orderVersion(order.purchaseOrderId)]).toEqual(['partially_received', version + 1]);
    expect(await getReceipt(u.agus, first.goodsReceiptId)).toMatchObject({ status: 'posted', postedBy: 'Agus Receiver', postedAt: expect.any(String), callerActions: ['reverse'] });
    expect((await auditOf(first.goodsReceiptId)).at(-1)).toEqual({
      action: 'receipt.posted',
      actor: u.agus,
      reason: null,
      changes: { status: ['draft', 'posted'], purchaseOrderStatus: ['issued', 'partially_received'] },
    });
    expect((await auditOf(order.purchaseOrderId)).at(-1)).toEqual({
      action: 'po.receiptStatusChanged',
      actor: u.agus,
      reason: null,
      changes: { status: ['issued', 'partially_received'], goodsReceipt: [null, first.number] },
    });

    // Any receiver posts the rest; the order is received.
    const rest = await draft(order, ['4', '2.5']);
    expect(data(await post(rest.goodsReceiptId, u.rudi))).toMatchObject({ purchaseOrderStatus: 'received' });
    expect(await orderStatus(order.purchaseOrderId)).toBe('received');
    expect((await getReceipt(u.agus, rest.goodsReceiptId)).postedBy).toBe('Rudi Receiver');
  });

  it('a posting that keeps the status still changes the order’s version: a buyer acting on an older page gets CONFLICT', async () => {
    const order = await issuedOrder();
    await receive(order, ['1', null]);
    const seen = await orderVersion(order.purchaseOrderId);
    await receive(order, ['1', null]);
    expect(await orderStatus(order.purchaseOrderId)).toBe('partially_received');
    expect(await orderVersion(order.purchaseOrderId)).toBe(seen + 1);
    expect((await auditOf(order.purchaseOrderId)).filter((e) => e.action === 'po.receiptStatusChanged')).toHaveLength(1);
    expect(rule(await run(u.dewi, closePurchaseOrder, { purchaseOrderId: order.purchaseOrderId, expectedVersion: seen, reason: 'Short-close' }))).toBe('CONFLICT');
  });

  it('OVER_RECEIPT at posting refuses the whole receipt and names its lines; exactly the receivable quantity is fine, 0.001 more is not', async () => {
    const order = await issuedOrder();
    const a = await draft(order, ['8', '2']);
    const b = await draft(order, ['3', '3']);
    const both = await draft(order, ['4', '3']);
    data(await post(a.goodsReceiptId));
    const refused = await post(b.goodsReceiptId);
    expect(refused).toMatchObject({ ok: false, error: { rule: 'OVER_RECEIPT', message: 'Line 2 can take only 2.4 pcs more, so nothing on this receipt was received.', details: [{ lineNo: 2, remaining: '2.4' }] } });
    expect(await post(both.goodsReceiptId)).toMatchObject({
      ok: false,
      error: {
        rule: 'OVER_RECEIPT',
        message: 'Line 1 can take only 3 pcs more, so nothing on this receipt was received.',
        details: [
          { lineNo: 1, remaining: '3' },
          { lineNo: 2, remaining: '2.4' },
        ],
      },
    });
    expect([await receivedQty(order.chair), await receivedQty(order.mat)]).toEqual(['8.000', '2.000']);
    expect((await getReceipt(u.agus, b.goodsReceiptId)).status).toBe('draft');

    // The chair line: 8 received, 11 receivable.
    const over = await draft(order, ['2', null]);
    const exact = await draft(order, ['3', null]);
    data(await post(over.goodsReceiptId));
    expect(await post(exact.goodsReceiptId)).toMatchObject({ ok: false, error: { rule: 'OVER_RECEIPT', details: [{ lineNo: 1, remaining: '1' }] } });
    const last = await draft(order, ['1', '2.4']);
    expect(rule(await run(u.agus, createGoodsReceipt, receiptInput(order, ['1.001', null])))).toBe('OVER_RECEIPT');
    expect(data(await post(last.goodsReceiptId)).purchaseOrderStatus).toBe('received');
    expect([await receivedQty(order.chair), await receivedQty(order.mat)]).toEqual(['11.000', '4.400']);
  });

  it('only drafts; stale versions; SOD-04; an order closed in between takes no receipts; only receivers post', async () => {
    const order = await issuedOrder();
    const once = await draft(order, ['1', null]);
    expect(rule(await run(u.agus, postGoodsReceipt, { goodsReceiptId: once.goodsReceiptId, expectedVersion: 2 }))).toBe('CONFLICT');
    data(await post(once.goodsReceiptId));
    expect(await post(once.goodsReceiptId)).toMatchObject({ ok: false, error: { code: 'INVALID_TRANSITION', message: 'A goods receipt that is posted cannot be posted.' } });
    const cancelled = await draft(order, ['1', null]);
    data(await cancelDraft(cancelled.goodsReceiptId));
    expect(rule(await post(cancelled.goodsReceiptId))).toBe('INVALID_TRANSITION');
    for (const as of [u.dewi, u.sari, u.lena, u.rina]) expect(rule(await post((await draft(order, ['1', null])).goodsReceiptId, as))).toBe('FORBIDDEN');
    expect(rule(await run(u.agus, postGoodsReceipt, { goodsReceiptId: '00000000-0000-7000-8000-000000000000', expectedVersion: 1 }))).toBe('NOT_FOUND');

    const own = await issuedOrder(u.pia);
    expect(rule(await post((await draft(own, ['1', null])).goodsReceiptId, u.pia))).toBe('ORDER_RECEIVE_CONFLICT');

    const waiting = await draft(order, ['1', null]);
    data(await closeOrder(order.purchaseOrderId));
    expect(await post(waiting.goodsReceiptId)).toMatchObject({ ok: false, error: { rule: 'PO_NOT_RECEIVABLE', message: `Purchase order ${order.number} is closed, so it takes no more goods receipts.` } });
    // Decision 4: the draft stays a draft, and its creator can cancel it.
    expect((await getReceipt(u.agus, waiting.goodsReceiptId)).callerActions).toEqual(['cancel']);
    expect(rule(await cancelDraft(waiting.goodsReceiptId))).toBe('ok');
  });
});

describe('P8-AC4: cancelling a draft (GR-T03)', () => {
  it('its creator cancels a draft with or without a reason; nothing was received; audited', async () => {
    const order = await issuedOrder();
    const withReason = await draft(order, ['2', null]);
    for (const reason of ['x'.repeat(501)]) expect(rule(await cancelDraft(withReason.goodsReceiptId, reason))).toBe('VALIDATION_FAILED');
    expect(rule(await cancelDraft(withReason.goodsReceiptId, 'Counted twice', u.rudi))).toBe('FORBIDDEN');
    expect(rule(await cancelDraft(withReason.goodsReceiptId, 'Counted twice', u.dewi))).toBe('FORBIDDEN');
    expect(rule(await run(u.agus, cancelGoodsReceipt, { goodsReceiptId: withReason.goodsReceiptId, expectedVersion: 2, reason: null }))).toBe('CONFLICT');
    expect(data(await cancelDraft(withReason.goodsReceiptId, ' Counted twice '))).toEqual({ version: 2, status: 'cancelled' });
    expect(await getReceipt(u.agus, withReason.goodsReceiptId)).toMatchObject({ status: 'cancelled', cancelledBy: 'Agus Receiver', cancelReason: 'Counted twice', callerActions: [] });
    expect((await auditOf(withReason.goodsReceiptId)).at(-1)).toEqual({ action: 'receipt.cancelled', actor: u.agus, reason: 'Counted twice', changes: { status: ['draft', 'cancelled'] } });
    expect(rule(await cancelDraft(withReason.goodsReceiptId))).toBe('INVALID_TRANSITION');

    const without = await draft(order, ['2', null]);
    data(await cancelDraft(without.goodsReceiptId, ''));
    expect((await auditOf(without.goodsReceiptId)).at(-1)).toEqual({ action: 'receipt.cancelled', actor: u.agus, reason: null, changes: { status: ['draft', 'cancelled'] } });
    expect(await receivedQty(order.chair)).toBe('0.000');

    const posted = await receive(order, ['1', null]);
    expect(rule(await cancelDraft(posted.goodsReceiptId))).toBe('INVALID_TRANSITION');
  });
});

describe('P8-AC5: reversing a receipt (GR-T04)', () => {
  it('posts a reversal with the same lines, takes the quantities back, re-derives the order, and leaves the receipt as it was', async () => {
    const order = await issuedOrder();
    const first = await receive(order, ['6', null]);
    const second = await receive(order, ['4', '4']);
    expect(await orderStatus(order.purchaseOrderId)).toBe('received');
    const before = (await t.pool.query('SELECT * FROM goods_receipts WHERE id = $1', [second.goodsReceiptId])).rows[0];

    const reversal = data(await reverse(second.goodsReceiptId, '  Wrong items delivered '));
    expect(reversal).toEqual({ goodsReceiptId: expect.any(String), number: expect.stringMatching(/^GR-\d{4}-\d{6}$/), version: 2, purchaseOrderStatus: 'partially_received' });
    expect([await receivedQty(order.chair), await receivedQty(order.mat)]).toEqual(['6.000', '0.000']);
    expect((await t.pool.query('SELECT * FROM goods_receipts WHERE id = $1', [second.goodsReceiptId])).rows[0]).toEqual(before);
    expect(await getReceipt(u.lena, reversal.goodsReceiptId)).toMatchObject({
      kind: 'reversal',
      status: 'posted',
      receivedOn: today(),
      reason: 'Wrong items delivered',
      deliveryNoteRef: null,
      reverses: { id: second.goodsReceiptId, number: second.number },
      reversedBy: null,
      createdBy: 'Agus Receiver',
      postedBy: 'Agus Receiver',
      callerActions: [],
    });
    expect((await getReceipt(u.agus, reversal.goodsReceiptId)).lines.map((l) => [l.lineNo, l.quantity])).toEqual([
      [1, '4'],
      [2, '4'],
    ]);
    expect(await getReceipt(u.agus, second.goodsReceiptId)).toMatchObject({ status: 'posted', reversedBy: { id: reversal.goodsReceiptId, number: reversal.number }, callerActions: [] });
    expect(await auditOf(reversal.goodsReceiptId)).toEqual([
      {
        action: 'receipt.reversalPosted',
        actor: u.agus,
        reason: 'Wrong items delivered',
        changes: {
          number: [null, reversal.number],
          purchaseOrder: [null, order.number],
          kind: [null, 'reversal'],
          reverses: [null, second.number],
          receivedOn: [null, today()],
          lines: [null, ['1. 4 pcs Ergonomic office chair', '2. 4 pcs Chair mat']],
          status: [null, 'posted'],
          purchaseOrderStatus: [null, 'partially_received'],
        },
      },
    ]);
    expect((await auditOf(second.goodsReceiptId)).at(-1)).toEqual({
      action: 'receipt.reversed',
      actor: u.agus,
      reason: 'Wrong items delivered',
      changes: { reversedBy: [null, reversal.number], purchaseOrderStatus: ['received', 'partially_received'] },
    });
    expect((await auditOf(order.purchaseOrderId)).at(-1)).toMatchObject({ action: 'po.receiptStatusChanged', changes: { status: ['received', 'partially_received'], goodsReceipt: [null, reversal.number] } });

    // Reversing the first one too: nothing is received any more.
    expect(data(await reverse(first.goodsReceiptId, 'Wrong items delivered', u.rudi)).purchaseOrderStatus).toBe('issued');
    expect(await receivedQty(order.chair)).toBe('0.000');
  });

  it('once only (ALREADY_REVERSED); posted receipts only; a reason; SOD-04; stale versions; only receivers', async () => {
    const order = await issuedOrder();
    const posted = await receive(order, ['2', null]);
    for (const reason of ['', '  ', null, 'x'.repeat(501)]) expect(rule(await reverse(posted.goodsReceiptId, reason))).toBe('VALIDATION_FAILED');
    for (const as of [u.dewi, u.sari, u.lena, u.ada]) expect(rule(await reverse(posted.goodsReceiptId, 'x', as))).toBe('FORBIDDEN');
    expect(rule(await run(u.agus, reverseGoodsReceipt, { goodsReceiptId: posted.goodsReceiptId, expectedVersion: 1, reason: 'Stale' }))).toBe('CONFLICT');
    const reversal = data(await reverse(posted.goodsReceiptId));
    expect(await reverse(posted.goodsReceiptId)).toMatchObject({ ok: false, error: { rule: 'ALREADY_REVERSED', message: `${posted.number} was already reversed by ${reversal.number}.` } });
    expect(await reverse(reversal.goodsReceiptId)).toMatchObject({ ok: false, error: { code: 'INVALID_TRANSITION', message: 'A reversal that is posted cannot be reversed.' } });
    const pending = await draft(order, ['1', null]);
    expect(rule(await reverse(pending.goodsReceiptId))).toBe('INVALID_TRANSITION');
    data(await cancelDraft(pending.goodsReceiptId));
    expect(rule(await reverse(pending.goodsReceiptId))).toBe('INVALID_TRANSITION');

    const own = await issuedOrder(u.pia);
    const received = await receive(own, ['1', null]);
    expect(rule(await reverse(received.goodsReceiptId, 'Mine', u.pia))).toBe('ORDER_RECEIVE_CONFLICT');
    expect(rule(await reverse(received.goodsReceiptId, 'Not mine', u.rudi))).toBe('ok');
  });

  it('PO_CLOSED: not once the order is closed; a fully reversed order can be cancelled again', async () => {
    const order = await issuedOrder();
    const posted = await receive(order, ['3', null]);
    data(await closeOrder(order.purchaseOrderId));
    expect(await reverse(posted.goodsReceiptId)).toMatchObject({ ok: false, error: { rule: 'PO_CLOSED', message: `Purchase order ${order.number} is closed, so its goods receipts can no longer be reversed.` } });
    expect((await getReceipt(u.agus, posted.goodsReceiptId)).callerActions).toEqual([]);

    const other = await issuedOrder();
    const undone = await receive(other, ['3', '1']);
    expect(rule(await cancelOrder(other.purchaseOrderId))).toBe('RECEIPTS_EXIST');
    data(await reverse(undone.goodsReceiptId));
    expect(await orderStatus(other.purchaseOrderId)).toBe('issued');
    expect(data(await run(u.dewi, getPurchaseOrder, { purchaseOrderId: other.purchaseOrderId })).callerActions).toEqual(['cancel', 'close']);
    expect(data(await cancelOrder(other.purchaseOrderId)).status).toBe('cancelled');
    expect([await orderedQty(other.requisitionLines[0] as string), await orderedQty(other.requisitionLines[1] as string)]).toEqual(['0.000', '0.000']);
  });
});

describe('P8-AC6: the order follows its receipts', () => {
  it('closing a partially received order releases what was not received; a received one (over-received too) releases nothing', async () => {
    const order = await issuedOrder();
    await receive(order, ['2.5', '4']);
    expect(rule(await closeOrder(order.purchaseOrderId, null))).toBe('VALIDATION_FAILED');
    data(await closeOrder(order.purchaseOrderId, 'Rest back-ordered for months'));
    expect([await orderedQty(order.requisitionLines[0] as string), await orderedQty(order.requisitionLines[1] as string)]).toEqual(['2.500', '4.000']);
    expect((await auditOf(order.purchaseOrderId)).at(-1)).toMatchObject({ action: 'po.closed', changes: { status: ['partially_received', 'closed'], released: [null, ['7.5 pcs (requisition line 1)']] } });

    const over = await issuedOrder();
    await receive(over, ['11', '4.4']);
    expect(data(await run(u.dewi, getPurchaseOrder, { purchaseOrderId: over.purchaseOrderId })).callerActions).toEqual(['close']);
    data(await closeOrder(over.purchaseOrderId, null));
    expect([await orderedQty(over.requisitionLines[0] as string), await orderedQty(over.requisitionLines[1] as string)]).toEqual(['10.000', '4.000']);
    expect((await auditOf(over.purchaseOrderId)).at(-1)).toEqual({ action: 'po.closed', actor: u.dewi, reason: null, changes: { status: ['received', 'closed'] } });
  });

  it('po.get offers `receive` to receivers who did not create the order, while it takes receipts', async () => {
    const order = await issuedOrder(u.pia);
    const actions = async (as: string) => data(await run(as, getPurchaseOrder, { purchaseOrderId: order.purchaseOrderId })).callerActions;
    expect(await actions(u.agus)).toEqual(['receive']);
    expect(await actions(u.pia)).toEqual(['cancel', 'close']);
    expect(await actions(u.dewi)).toEqual(['cancel', 'close']);
    await receive(order, ['10', null]);
    expect(await actions(u.agus)).toEqual(['receive']);
    expect(await actions(u.dewi)).toEqual(['close']);
    await receive(order, [null, '4']);
    expect(await actions(u.agus)).toEqual([]);
    expect(await actions(u.lena)).toEqual([]);
  });
});

describe('P8-AC7: reading goods receipts, and access', () => {
  it('receipt.list: every receipt for procurement, receivers, finance, and auditors, with filters; nobody else', async () => {
    const order = await issuedOrder();
    const posted = await receive(order, ['1', null]);
    const reversal = data(await reverse(posted.goodsReceiptId));
    const open = await draft(order, ['2', null], u.rudi);
    for (const as of [u.dewi, u.agus, u.sari, u.lena]) {
      const items = data(await run(as, listGoodsReceipts, { purchaseOrderId: order.purchaseOrderId })).items;
      expect(items.map((i) => i.number)).toEqual([open.number, reversal.number, posted.number]);
    }
    const [draftItem, reversalItem, postedItem] = data(await run(u.agus, listGoodsReceipts, { purchaseOrderId: order.purchaseOrderId })).items;
    expect(Object.keys(draftItem ?? {}).sort()).toEqual([...GR_SUMMARY_KEYS].sort());
    expect(draftItem).toMatchObject({ kind: 'receipt', status: 'draft', createdBy: 'Rudi Receiver', purchaseOrderNumber: order.number, supplierName: 'Example Office Supplies Ltd' });
    expect(reversalItem).toMatchObject({ kind: 'reversal', status: 'posted', reversesNumber: posted.number, reversedByNumber: null });
    expect(postedItem).toMatchObject({ kind: 'receipt', reversesNumber: null, reversedByNumber: reversal.number });
    expect(data(await run(u.agus, listGoodsReceipts, { purchaseOrderId: order.purchaseOrderId, kind: 'reversal' })).items.map((i) => i.id)).toEqual([reversal.goodsReceiptId]);
    expect(data(await run(u.agus, listGoodsReceipts, { purchaseOrderId: order.purchaseOrderId, status: 'draft' })).items.map((i) => i.id)).toEqual([open.goodsReceiptId]);
    expect(data(await run(u.agus, listGoodsReceipts, { q: posted.number })).items.map((i) => i.id)).toEqual([posted.goodsReceiptId]);
    const page = data(await run(u.agus, listGoodsReceipts, { purchaseOrderId: order.purchaseOrderId, limit: 2 }));
    expect(page.nextCursor).toBe(reversal.number);
    expect(data(await run(u.agus, listGoodsReceipts, { purchaseOrderId: order.purchaseOrderId, cursor: page.nextCursor })).items.map((i) => i.id)).toEqual([posted.goodsReceiptId]);
    for (const input of [{ status: 'void' }, { cursor: 'PO-2030-000001' }, { limit: 101 }, { extra: true }]) expect(rule(await run(u.agus, listGoodsReceipts, input))).toBe('VALIDATION_FAILED');
    for (const as of [u.rina, u.bayu, u.ada]) {
      expect(rule(await run(as, listGoodsReceipts, {}))).toBe('FORBIDDEN');
      expect(rule(await run(as, getGoodsReceipt, { goodsReceiptId: posted.goodsReceiptId }))).toBe('FORBIDDEN');
    }
  });

  it('receipt.get: allowlisted fields, the caller’s actions, NOT_FOUND for an unknown id', async () => {
    const order = await issuedOrder();
    const created = await draft(order, ['1', '1']);
    const receipt = await getReceipt(u.sari, created.goodsReceiptId);
    expect(Object.keys(receipt).sort()).toEqual([...GR_DETAIL_KEYS].sort());
    expect(Object.keys(receipt.purchaseOrder).sort()).toEqual([...GR_ORDER_KEYS].sort());
    for (const line of receipt.lines) expect(Object.keys(line).sort()).toEqual([...GR_LINE_KEYS].sort());
    expect(receipt.callerActions).toEqual([]);
    expect((await getReceipt(u.rudi, created.goodsReceiptId)).callerActions).toEqual(['post']);
    expect((await getReceipt(u.agus, created.goodsReceiptId)).callerActions).toEqual(['post', 'cancel']);
    expect(rule(await run(u.agus, getGoodsReceipt, { goodsReceiptId: '00000000-0000-7000-8000-000000000000' }))).toBe('NOT_FOUND');
  });

  it('po.receivable: issued and partially received orders for receivers, with open lines and SOD-04 marked', async () => {
    const issued = await issuedOrder();
    const partial = await issuedOrder(u.pia);
    await receive(partial, ['10', null]);
    const done = await issuedOrder();
    await receive(done, ['10', '4']);
    const notIssued = await issuedOrder(u.dewi, false);
    const items = data(await run(u.pia, listReceivableOrders, {})).items;
    const ids = items.map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining([issued.purchaseOrderId, partial.purchaseOrderId]));
    expect(ids).not.toContain(done.purchaseOrderId);
    expect(ids).not.toContain(notIssued.purchaseOrderId);
    const mine = items.find((i) => i.id === partial.purchaseOrderId);
    expect(Object.keys(mine ?? {}).sort()).toEqual([...PO_RECEIVABLE_KEYS].sort());
    expect(mine).toMatchObject({ number: partial.number, status: 'partially_received', supplierName: 'Example Office Supplies Ltd', openLines: 1, lineCount: 2, ownOrder: true });
    expect(items.find((i) => i.id === issued.purchaseOrderId)).toMatchObject({ openLines: 2, ownOrder: false });
    expect(data(await run(u.agus, listReceivableOrders, { q: issued.number })).items.map((i) => i.id)).toEqual([issued.purchaseOrderId]);
    for (const as of [u.dewi, u.sari, u.lena, u.rina, u.ada]) expect(rule(await run(as, listReceivableOrders, {}))).toBe('FORBIDDEN');
  });

  it('receipt.formOptions: what each line can still take; NOT_FOUND for orders receivers cannot read', async () => {
    const order = await issuedOrder(u.pia);
    await receive(order, ['3.5', null]);
    const options = data(await run(u.agus, goodsReceiptFormOptions, { purchaseOrderId: order.purchaseOrderId }));
    expect(Object.keys(options).sort()).toEqual([...GR_FORM_OPTIONS_KEYS].sort());
    for (const line of options.lines) expect(Object.keys(line).sort()).toEqual([...GR_FORM_LINE_KEYS].sort());
    expect(options).toMatchObject({
      purchaseOrder: { number: order.number, status: 'partially_received', issuedOn: today() },
      today: today(),
      receivable: true,
      orderReceiveConflict: false,
      lines: [
        { lineNo: 1, quantity: '10', receivedQty: '3.5', maxReceivableQty: '11', remainingQty: '7.5' },
        { lineNo: 2, quantity: '4', receivedQty: '0', maxReceivableQty: '4.4', remainingQty: '4.4' },
      ],
    });
    expect(data(await run(u.pia, goodsReceiptFormOptions, { purchaseOrderId: order.purchaseOrderId })).orderReceiveConflict).toBe(true);
    data(await closeOrder(order.purchaseOrderId, 'Done', u.pia));
    expect(data(await run(u.agus, goodsReceiptFormOptions, { purchaseOrderId: order.purchaseOrderId })).receivable).toBe(false);
    const approved = await issuedOrder(u.dewi, false);
    expect(rule(await run(u.agus, goodsReceiptFormOptions, { purchaseOrderId: approved.purchaseOrderId }))).toBe('NOT_FOUND');
    for (const as of [u.dewi, u.sari]) expect(rule(await run(as, goodsReceiptFormOptions, { purchaseOrderId: order.purchaseOrderId }))).toBe('FORBIDDEN');
  });
});

describe('P8-AC3 / P8-AC8: database backstops', () => {
  it('received quantities move only with posted receipts (GR-I1), statuses follow them (PO-T06), and the CHECK refuses over-receipt', async () => {
    const order = await issuedOrder();
    // Without a document: refused by the line guard, as the runtime role and the owner.
    for (const pool of [t.appPool, t.pool]) {
      expect(await sqlStateOf(() => pool.query('UPDATE purchase_order_lines SET received_qty = 1 WHERE id = $1', [order.chair]))).toBe('PFC01');
      expect(await sqlStateOf(() => pool.query("UPDATE purchase_orders SET status = 'received' WHERE id = $1", [order.purchaseOrderId]))).toBe('PFC01');
    }
    const insertDraft = (number: string, quantity: string): [string, unknown[]][] => [
      ['INSERT INTO goods_receipts (number, purchase_order_id, received_on, created_by_user_id) VALUES ($1, $2, current_date, $3)', [number, order.purchaseOrderId, u.agus]],
      ['INSERT INTO goods_receipt_lines (goods_receipt_id, purchase_order_line_id, quantity) SELECT id, $2, $3 FROM goods_receipts WHERE number = $1', [number, order.chair, quantity]],
      ["UPDATE goods_receipts SET status = 'posted', posted_at = now(), posted_by_user_id = $2 WHERE number = $1", [number, u.agus]],
    ];
    // A posted receipt whose quantities did not move: refused at commit (GR-I1).
    const unsettled = directGrNumber();
    expect(await inTransaction(t.appPool, insertDraft(unsettled, '2'))).toBe('PFG01');
    // Quantities moved with the receipt but the order's status left behind: refused at commit (PO-T06).
    const stale = directGrNumber();
    expect(await inTransaction(t.appPool, [...insertDraft(stale, '2'), ['UPDATE purchase_order_lines SET received_qty = 2 WHERE id = $1', [order.chair]]])).toBe('PFC01');
    // More than receivable, with a matching document: the guards pass and the CHECK refuses it (C3).
    const over = directGrNumber();
    expect(
      await inTransaction(t.appPool, [
        ...insertDraft(over, '12'),
        ['UPDATE purchase_order_lines SET received_qty = 12 WHERE id = $1', [order.chair]],
      ]),
    ).toBe('23514');
    // Everything together, as the application writes it, is accepted.
    const settled = directGrNumber();
    expect(
      await inTransaction(t.appPool, [
        ...insertDraft(settled, '2'),
        ['UPDATE purchase_order_lines SET received_qty = 2 WHERE id = $1', [order.chair]],
        ["UPDATE purchase_orders SET status = 'partially_received', version = version + 1 WHERE id = $1", [order.purchaseOrderId]],
      ]),
    ).toBe('none');
    expect(await orderStatus(order.purchaseOrderId)).toBe('partially_received');
    // Received, but not by a document: refused even where the status would not change.
    for (const pool of [t.appPool, t.pool]) {
      expect(await sqlStateOf(() => pool.query('UPDATE purchase_order_lines SET received_qty = received_qty + 1 WHERE id = $1', [order.chair]))).toBe('PFC01');
    }
  });

  it('receipts are never deleted, drafts never edited, posted and cancelled receipts never change, lines only join drafts of their order', async () => {
    const order = await issuedOrder();
    const other = await issuedOrder();
    const open = await draft(order, ['1', null]);
    const posted = await receive(order, ['1', null]);
    const cancelled = await draft(order, ['1', null]);
    data(await cancelDraft(cancelled.goodsReceiptId));
    const line = (await t.pool.query('SELECT id FROM goods_receipt_lines WHERE goods_receipt_id = $1', [posted.goodsReceiptId])).rows[0].id;
    expect(await sqlStateOf(() => t.appPool.query('DELETE FROM goods_receipts WHERE id = $1', [open.goodsReceiptId]))).toBe('42501');
    expect(await sqlStateOf(() => t.appPool.query('DELETE FROM goods_receipt_lines WHERE id = $1', [line]))).toBe('42501');
    expect(await sqlStateOf(() => t.appPool.query('UPDATE goods_receipt_lines SET quantity = 5 WHERE id = $1', [line]))).toBe('42501');
    for (const pool of [t.appPool, t.pool]) {
      for (const [statement, params] of [
        ["UPDATE goods_receipts SET delivery_note_ref = 'DN-X' WHERE id = $1", [open.goodsReceiptId]],
        ["UPDATE goods_receipts SET received_on = received_on + 1 WHERE id = $1", [open.goodsReceiptId]],
        ['UPDATE goods_receipts SET purchase_order_id = $2 WHERE id = $1', [open.goodsReceiptId, other.purchaseOrderId]],
        ['UPDATE goods_receipts SET version = version + 1 WHERE id = $1', [open.goodsReceiptId]],
        ["UPDATE goods_receipts SET status = 'cancelled', cancelled_at = now(), cancelled_by_user_id = $2 WHERE id = $1", [open.goodsReceiptId, u.rudi]],
        ["UPDATE goods_receipts SET notes = 'Changed' WHERE id = $1", [posted.goodsReceiptId]],
        ["UPDATE goods_receipts SET status = 'cancelled', posted_at = NULL, posted_by_user_id = NULL, cancelled_at = now(), cancelled_by_user_id = $2 WHERE id = $1", [posted.goodsReceiptId, u.agus]],
        ["UPDATE goods_receipts SET status = 'draft', cancelled_at = NULL, cancelled_by_user_id = NULL WHERE id = $1", [cancelled.goodsReceiptId]],
        ['INSERT INTO goods_receipt_lines (goods_receipt_id, purchase_order_line_id, quantity) VALUES ($1, $2, 1)', [posted.goodsReceiptId, order.mat]],
        ['INSERT INTO goods_receipt_lines (goods_receipt_id, purchase_order_line_id, quantity) VALUES ($1, $2, 1)', [open.goodsReceiptId, other.mat]],
      ] as const) {
        expect({ statement, state: await sqlStateOf(() => pool.query(statement, [...params])) }).toEqual({ statement, state: 'PFG01' });
      }
    }
    expect(await sqlStateOf(() => t.pool.query('DELETE FROM goods_receipts WHERE id = $1', [open.goodsReceiptId]))).toBe('PFG01');
    expect(await sqlStateOf(() => t.pool.query('DELETE FROM goods_receipt_lines WHERE id = $1', [line]))).toBe('PFG01');
  });

  it('receipts start as drafts of receivable orders, on or after the issue day, never by the order’s creator; posting checks SOD-04 and the order again', async () => {
    const order = await issuedOrder();
    const notIssued = await issuedOrder(u.dewi, false);
    const insert = (values: { number?: string; order?: string; receivedOn?: string; by?: string; status?: string }) =>
      sqlStateOf(() =>
        t.appPool.query('INSERT INTO goods_receipts (number, purchase_order_id, received_on, created_by_user_id, status) VALUES ($1, $2, $3, $4, $5)', [
          values.number ?? directGrNumber(),
          values.order ?? order.purchaseOrderId,
          values.receivedOn ?? today(),
          values.by ?? u.agus,
          values.status ?? 'draft',
        ]),
      );
    expect(await insert({ status: 'posted' })).toBe('PFG01');
    expect(await insert({ order: notIssued.purchaseOrderId })).toBe('PFG01');
    expect(await insert({ receivedOn: daysFromToday(-1) })).toBe('PFG01');
    expect(await insert({ by: u.dewi })).toBe('PFG01');
    expect(await insert({})).toBe('none');

    const open = await draft(order, ['1', null]);
    expect(
      await sqlStateOf(() =>
        t.appPool.query("UPDATE goods_receipts SET status = 'posted', posted_at = now(), posted_by_user_id = $2 WHERE id = $1", [open.goodsReceiptId, u.dewi]),
      ),
    ).toBe('PFG01');
    const empty = directGrNumber();
    expect(
      await inTransaction(t.appPool, [
        ['INSERT INTO goods_receipts (number, purchase_order_id, received_on, created_by_user_id) VALUES ($1, $2, current_date, $3)', [empty, order.purchaseOrderId, u.agus]],
        ["UPDATE goods_receipts SET status = 'posted', posted_at = now(), posted_by_user_id = $2 WHERE number = $1", [empty, u.agus]],
      ]),
    ).toBe('PFG01');
    data(await closeOrder(order.purchaseOrderId));
    expect(
      await sqlStateOf(() =>
        t.appPool.query("UPDATE goods_receipts SET status = 'posted', posted_at = now(), posted_by_user_id = $2 WHERE id = $1", [open.goodsReceiptId, u.agus]),
      ),
    ).toBe('PFG01');
    expect(await insert({})).toBe('PFG01'); // closed

    // A received order takes no more receipts, even within the tolerance (here 1 more chair):
    // not a new draft, and not an older draft posted with the quantity moved to match.
    const full = await issuedOrder();
    const early = await draft(full, ['1', null]);
    await receive(full, ['10', '4']);
    expect(await orderStatus(full.purchaseOrderId)).toBe('received');
    expect(await insert({ order: full.purchaseOrderId })).toBe('PFG01');
    expect(
      await inTransaction(t.appPool, [
        ["UPDATE goods_receipts SET status = 'posted', posted_at = now(), posted_by_user_id = $2 WHERE id = $1", [early.goodsReceiptId, u.agus]],
        ['UPDATE purchase_order_lines SET received_qty = 11 WHERE id = $1', [full.chair]],
      ]),
    ).toBe('PFG01');
  });

  it('a reversal mirrors a posted receipt of its order, is posted in the transaction that records it, and happens once (GR-I3)', async () => {
    const order = await issuedOrder();
    const posted = await receive(order, ['3', '1']);
    const open = await draft(order, ['1', null]);
    const reversalOf = (number: string, original: string, lines: [string, string][], post = true): [string, unknown[]][] => [
      [
        "INSERT INTO goods_receipts (number, purchase_order_id, kind, reverses_goods_receipt_id, received_on, reason, created_by_user_id) VALUES ($1, $2, 'reversal', $3, current_date, 'Probe', $4)",
        [number, order.purchaseOrderId, original, u.agus],
      ],
      ...lines.map(
        ([lineId, quantity]): [string, unknown[]] => [
          'INSERT INTO goods_receipt_lines (goods_receipt_id, purchase_order_line_id, quantity) SELECT id, $2, $3 FROM goods_receipts WHERE number = $1',
          [number, lineId, quantity],
        ],
      ),
      ...(post ? [["UPDATE goods_receipts SET status = 'posted', posted_at = now(), posted_by_user_id = $2 WHERE number = $1", [number, u.agus]] as [string, unknown[]]] : []),
    ];
    // Of a draft: refused when recorded.
    expect(await inTransaction(t.appPool, reversalOf(directGrNumber(), open.goodsReceiptId, [[order.chair, '1']]))).toBe('PFG01');
    // Lines that differ from the receipt's: refused when posted, also with the quantities and status moved to match.
    expect(await inTransaction(t.appPool, reversalOf(directGrNumber(), posted.goodsReceiptId, [[order.chair, '3']]))).toBe('PFG01');
    const partial = directGrNumber();
    expect(
      await inTransaction(t.appPool, [
        ...reversalOf(partial, posted.goodsReceiptId, [[order.chair, '3']], false),
        ["UPDATE goods_receipts SET status = 'posted', posted_at = now(), posted_by_user_id = $2 WHERE number = $1", [partial, u.agus]],
        ['UPDATE purchase_order_lines SET received_qty = 0 WHERE id = $1', [order.chair]],
      ]),
    ).toBe('PFG01');
    expect(await inTransaction(t.appPool, reversalOf(directGrNumber(), posted.goodsReceiptId, [[order.chair, '3'], [order.mat, '0.5']]))).toBe('PFG01');
    // Left as a draft: refused at commit.
    expect(await inTransaction(t.appPool, reversalOf(directGrNumber(), posted.goodsReceiptId, [[order.chair, '3'], [order.mat, '1']], false))).toBe('PFG01');
    // A second reversal of the same receipt: the unique index.
    data(await reverse(posted.goodsReceiptId));
    expect(await inTransaction(t.appPool, reversalOf(directGrNumber(), posted.goodsReceiptId, [[order.chair, '3'], [order.mat, '1']]))).toBe('23505');
  });
});
