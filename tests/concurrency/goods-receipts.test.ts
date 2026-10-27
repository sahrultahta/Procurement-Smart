import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publishApprovalPolicy } from '@/modules/organization';
import { cancelPurchaseOrder, closePurchaseOrder, createPurchaseOrder, issuePurchaseOrder, submitPurchaseOrder } from '@/modules/purchasing';
import { createGoodsReceipt, postGoodsReceipt, reverseGoodsReceipt } from '@/modules/receiving';
import { createRequisition, submitRequisition } from '@/modules/requisitions';
import { createSupplier, reviewSupplier } from '@/modules/suppliers';
import { decideApproval } from '@/server/approvals';
import type { RequestContext } from '@/shared/application/context';
import { runCommand } from '@/shared/application/runner';
import type { Result } from '@/shared/result';
import { contextOf, provisionActor } from '../support/actors';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/*
 * P8-AC9: goods-receipt races, each forced to overlap 20 times (a third connection holds the
 * purchase order row the commands queue on until all of them wait). Lock order (ADR 0008 C8):
 * requisition → purchase order → goods receipt → order lines.
 *   1. CC-04: 5 receivers post 5 drafts of 1 unit at once on a line that can take 2 (the order has
 *      another line, so it keeps taking receipts): two succeed, three are OVER_RECEIPT.
 *   2. Two reversals of the same receipt at once: one succeeds, one is ALREADY_REVERSED.
 *   3. A posting and a short-close of the same order at once: one wins, the other is refused.
 *   4. A posting and a cancellation of the same issued order at once: one wins, the other is refused.
 * After each iteration GR-I1 (received = posted receipts − reversals) and PO-I1 hold.
 */
let t: TestDatabase;
let rina: RequestContext;
let bayu: RequestContext;
let dewi: RequestContext;
const receivers: RequestContext[] = [];
let supplierId = '';
const ITERATIONS = 20;
const PARALLEL = 5;

beforeAll(async () => {
  t = await createTestDatabase();
  await t.pool.query("INSERT INTO departments (code, name) VALUES ('OPS', 'Operations')");
  rina = await contextOf(t.appDb, await provisionActor(t.appDb, 'rina@example.com', 'Rina', ['requester'], { departmentCode: 'OPS' }));
  bayu = await contextOf(t.appDb, await provisionActor(t.appDb, 'bayu@example.com', 'Bayu', [{ role: 'approver', departmentCode: 'OPS' }], { departmentCode: 'OPS' }));
  dewi = await contextOf(t.appDb, await provisionActor(t.appDb, 'dewi@example.com', 'Dewi', ['procurement']));
  const sari = await contextOf(t.appDb, await provisionActor(t.appDb, 'sari@example.com', 'Sari', ['finance']));
  for (let n = 0; n < PARALLEL; n++) receivers.push(await contextOf(t.appDb, await provisionActor(t.appDb, `receiver${n}@example.com`, `Receiver ${n}`, ['receiver'])));
  const ada = await contextOf(t.appDb, await provisionActor(t.appDb, 'ada@example.com', 'Ada', ['admin']));
  const created = data(
    await run(dewi, createSupplier, {
      legalName: 'Race Deliveries Ltd',
      taxId: 'RACE-8001',
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
  data(await run(sari, reviewSupplier, { supplierId: created.supplierId, expectedVersion: 1, decision: 'approve', note: null }));
  supplierId = created.supplierId;
  data(
    await run(ada, publishApprovalPolicy, {
      documentType: 'requisition',
      name: 'One step',
      rules: [{ departmentCode: null, minAmount: '0', maxAmount: null, steps: [{ role: 'approver', scopeMode: 'document_department' }] }],
    }),
  );
  // Orders below 1000 are approved on submit; nothing more than ordered can be received.
  await t.pool.query('UPDATE org_settings SET po_approval_threshold = 1000, po_price_tolerance_pct = 0, over_receipt_tolerance_pct = 0');
});

afterAll(async () => {
  await t?.drop();
});

function receiver(n: number): RequestContext {
  const found = receivers[n];
  if (!found) throw new Error(`no receiver ${n}`);
  return found;
}

function outcome(result: Result<unknown>): string {
  return result.ok ? 'ok' : `${result.error.code}${result.error.rule ? `:${result.error.rule}` : ''}`;
}

function data<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(outcome(result));
  return result.data;
}

const run = <I, O>(as: RequestContext, op: Parameters<typeof runCommand<I, O>>[1], input: unknown) => runCommand(as, op, input, { db: t.appDb });

type Issued = { requisitionLineId: string; purchaseOrderId: string; lineId: string; version: number };

/**
 * An issued order for `quantity` pallets at 10 (line 1, the one the races receive), and with
 * `withSecondLine` also 1 crate nobody receives, so the order stays partially received.
 */
async function issuedOrder(i: number, quantity: string, withSecondLine = false): Promise<Issued> {
  const lines = [
    { description: 'Pallet', quantity, uom: 'pcs', estimatedUnitPrice: '10' },
    ...(withSecondLine ? [{ description: 'Crate', quantity: '1', uom: 'pcs', estimatedUnitPrice: '10' }] : []),
  ];
  const requisition = data(await run(rina, createRequisition, { title: `Race ${i}`, justification: null, neededBy: '2030-06-30', lines }));
  const submitted = data(await run(rina, submitRequisition, { requisitionId: requisition.requisitionId, expectedVersion: 1 }));
  data(await run(bayu, decideApproval, { approvalRequestId: submitted.approvalRequestId, stepNo: 1, expectedVersion: 1, decision: 'approve' }));
  const requisitionLines = (await t.pool.query('SELECT id, quantity::text AS quantity FROM requisition_lines WHERE requisition_id = $1 ORDER BY line_no', [requisition.requisitionId]))
    .rows;
  const order = data(
    await run(dewi, createPurchaseOrder, {
      requisitionId: requisition.requisitionId,
      supplierId,
      paymentTerms: null,
      deliveryAddress: null,
      expectedDeliveryDate: null,
      lines: requisitionLines.map((r) => ({ requisitionLineId: r.id, quantity: r.quantity, unitPrice: '10', taxRatePct: '0' })),
    }),
  );
  expect(data(await run(dewi, submitPurchaseOrder, { purchaseOrderId: order.purchaseOrderId, expectedVersion: 1 })).status).toBe('approved');
  const issued = data(await run(dewi, issuePurchaseOrder, { purchaseOrderId: order.purchaseOrderId, expectedVersion: 2 }));
  const lineId = (await t.pool.query('SELECT id FROM purchase_order_lines WHERE purchase_order_id = $1 AND line_no = 1', [order.purchaseOrderId])).rows[0].id as string;
  return { requisitionLineId: requisitionLines[0]?.id as string, purchaseOrderId: order.purchaseOrderId, lineId, version: issued.version };
}

const today = () => new Date().toISOString().slice(0, 10);

async function draft(order: Issued, quantity: string, as: RequestContext): Promise<{ goodsReceiptId: string; version: number }> {
  return data(
    await run(as, createGoodsReceipt, {
      purchaseOrderId: order.purchaseOrderId,
      receivedOn: today(),
      deliveryNoteRef: null,
      notes: null,
      lines: [{ purchaseOrderLineId: order.lineId, quantity, note: null }],
    }),
  );
}

async function waitForLockWaiters(count: number): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const { rows } = await t.pool.query(
      `SELECT count(DISTINCT l.pid)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
       WHERE NOT l.granted AND a.datname = current_database()`,
    );
    if (rows[0].n >= count) return;
    await sleep(10);
  }
  throw new Error(`expected ${count} transactions waiting`);
}

/** Holds the purchase order row FOR UPDATE until `count` transactions wait, then lets them go. */
async function overlapped(purchaseOrderId: string, count: number, start: () => Promise<Result<unknown>>[]): Promise<Result<unknown>[]> {
  const holder = await t.pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM purchase_orders WHERE id = $1 FOR UPDATE', [purchaseOrderId]);
    const pending = Promise.all(start());
    await waitForLockWaiters(count);
    await holder.query('COMMIT');
    return await pending;
  } finally {
    holder.release();
  }
}

/** GR-I1 and PO-I1 for the order's line and its requisition line, and the order's status. */
async function state(order: Issued): Promise<{ received: string; fromReceipts: string; ordered: string; expectedOrdered: string; status: string }> {
  const { rows } = await t.pool.query(
    `SELECT pl.received_qty::text AS received,
       (SELECT coalesce(sum(CASE g.kind WHEN 'receipt' THEN l.quantity ELSE -l.quantity END), 0)::numeric(18,3)::text
          FROM goods_receipt_lines l JOIN goods_receipts g ON g.id = l.goods_receipt_id WHERE l.purchase_order_line_id = pl.id AND g.status = 'posted') AS "fromReceipts",
       r.ordered_qty::text AS ordered,
       (CASE WHEN po.status = 'closed' THEN least(pl.quantity, pl.received_qty) WHEN po.status IN ('cancelled', 'rejected') THEN 0 ELSE pl.quantity END)::numeric(18,3)::text AS "expectedOrdered",
       po.status
     FROM purchase_order_lines pl JOIN purchase_orders po ON po.id = pl.purchase_order_id JOIN requisition_lines r ON r.id = pl.requisition_line_id
     WHERE pl.id = $1`,
    [order.lineId],
  );
  return rows[0];
}

const version = async (table: 'purchase_orders' | 'goods_receipts', id: string) => (await t.pool.query(`SELECT version FROM ${table} WHERE id = $1`, [id])).rows[0].version as number;

describe('P8-AC9: goods-receipt races, forced to overlap', () => {
  it(`CC-04: ${PARALLEL} receivers post 1 unit each at once on a line that can take 2, ${ITERATIONS} times: two succeed, never over-received`, async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const order = await issuedOrder(i, '2', true);
      const drafts = await Promise.all(receivers.map((as) => draft(order, '1', as)));
      const results = await overlapped(order.purchaseOrderId, PARALLEL, () =>
        drafts.map((d, n) => runCommand(receiver(n), postGoodsReceipt, { goodsReceiptId: d.goodsReceiptId, expectedVersion: d.version }, { db: t.appDb })),
      );
      expect(results.map(outcome).sort()).toEqual(['BUSINESS_RULE:OVER_RECEIPT', 'BUSINESS_RULE:OVER_RECEIPT', 'BUSINESS_RULE:OVER_RECEIPT', 'ok', 'ok']);
      expect(await state(order)).toEqual({ received: '2.000', fromReceipts: '2.000', ordered: '2.000', expectedOrdered: '2.000', status: 'partially_received' });
      expect((await t.pool.query("SELECT count(*)::int AS n FROM goods_receipts WHERE purchase_order_id = $1 AND status = 'draft'", [order.purchaseOrderId])).rows[0].n).toBe(3);
    }
  }, 240_000);

  it(`two reversals of the same receipt at once, ${ITERATIONS} times: one succeeds, the other is ALREADY_REVERSED`, async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const order = await issuedOrder(100 + i, '3');
      const created = await draft(order, '2', receiver(0));
      data(await run(receiver(0), postGoodsReceipt, { goodsReceiptId: created.goodsReceiptId, expectedVersion: 1 }));
      const results = await overlapped(order.purchaseOrderId, 2, () =>
        [receiver(1), receiver(2)].map((as) =>
          runCommand(as, reverseGoodsReceipt, { goodsReceiptId: created.goodsReceiptId, expectedVersion: 2, reason: 'Race test' }, { db: t.appDb }),
        ),
      );
      expect(results.map(outcome).sort()).toEqual(['BUSINESS_RULE:ALREADY_REVERSED', 'ok']);
      expect((await t.pool.query('SELECT count(*)::int AS n FROM goods_receipts WHERE reverses_goods_receipt_id = $1', [created.goodsReceiptId])).rows[0].n).toBe(1);
      expect(await state(order)).toEqual({ received: '0.000', fromReceipts: '0.000', ordered: '3.000', expectedOrdered: '3.000', status: 'issued' });
    }
  }, 240_000);

  it(`a posting and a short-close of the same order at once, ${ITERATIONS} times: one wins, the quantities stay consistent`, async () => {
    const orders = new Set<string>();
    for (let i = 0; i < ITERATIONS; i++) {
      const order = await issuedOrder(200 + i, '4');
      const first = await draft(order, '1', receiver(0));
      data(await run(receiver(0), postGoodsReceipt, { goodsReceiptId: first.goodsReceiptId, expectedVersion: 1 }));
      const waiting = await draft(order, '2', receiver(1));
      const seen = await version('purchase_orders', order.purchaseOrderId);
      const [posted, closed] = await overlapped(order.purchaseOrderId, 2, () => [
        runCommand(receiver(1), postGoodsReceipt, { goodsReceiptId: waiting.goodsReceiptId, expectedVersion: waiting.version }, { db: t.appDb }),
        runCommand(dewi, closePurchaseOrder, { purchaseOrderId: order.purchaseOrderId, expectedVersion: seen, reason: 'Race test' }, { db: t.appDb }),
      ]);
      if (!posted || !closed) throw new Error('missing results');
      if (posted.ok) {
        orders.add('post first');
        // The posting changed the order's version, so the close acted on an older page.
        expect(outcome(closed)).toBe('CONFLICT');
        expect(await state(order)).toEqual({ received: '3.000', fromReceipts: '3.000', ordered: '4.000', expectedOrdered: '4.000', status: 'partially_received' });
      } else {
        orders.add('close first');
        expect([outcome(posted), outcome(closed)]).toEqual(['BUSINESS_RULE:PO_NOT_RECEIVABLE', 'ok']);
        expect(await state(order)).toEqual({ received: '1.000', fromReceipts: '1.000', ordered: '1.000', expectedOrdered: '1.000', status: 'closed' });
      }
    }
    expect(orders.size).toBeGreaterThanOrEqual(1);
  }, 240_000);

  it(`a posting and a cancellation of the same issued order at once, ${ITERATIONS} times: one wins, nothing received is cancelled`, async () => {
    const orders = new Set<string>();
    for (let i = 0; i < ITERATIONS; i++) {
      const order = await issuedOrder(300 + i, '2');
      const waiting = await draft(order, '2', receiver(0));
      const [posted, cancelled] = await overlapped(order.purchaseOrderId, 2, () => [
        runCommand(receiver(0), postGoodsReceipt, { goodsReceiptId: waiting.goodsReceiptId, expectedVersion: waiting.version }, { db: t.appDb }),
        runCommand(dewi, cancelPurchaseOrder, { purchaseOrderId: order.purchaseOrderId, expectedVersion: order.version, reason: 'Race test' }, { db: t.appDb }),
      ]);
      if (!posted || !cancelled) throw new Error('missing results');
      if (posted.ok) {
        orders.add('post first');
        expect(outcome(cancelled)).toBe('CONFLICT');
        expect(await state(order)).toEqual({ received: '2.000', fromReceipts: '2.000', ordered: '2.000', expectedOrdered: '2.000', status: 'received' });
      } else {
        orders.add('cancel first');
        expect([outcome(posted), outcome(cancelled)]).toEqual(['BUSINESS_RULE:PO_NOT_RECEIVABLE', 'ok']);
        expect(await state(order)).toEqual({ received: '0.000', fromReceipts: '0.000', ordered: '0.000', expectedOrdered: '0.000', status: 'cancelled' });
      }
    }
    expect(orders.size).toBeGreaterThanOrEqual(1);
  }, 240_000);
});
