import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publishApprovalPolicy } from '@/modules/organization';
import { cancelPurchaseOrder, createPurchaseOrder, submitPurchaseOrder } from '@/modules/purchasing';
import { createRequisition, submitRequisition } from '@/modules/requisitions';
import { createSupplier, reviewSupplier } from '@/modules/suppliers';
import { decideApproval } from '@/server/approvals';
import type { RequestContext } from '@/shared/application/context';
import { runCommand } from '@/shared/application/runner';
import type { Result } from '@/shared/result';
import { contextOf, provisionActor } from '../support/actors';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/*
 * P7-AC12: purchase-order races, each forced to overlap 20 times (a third connection holds the
 * requisition row the commands queue on until all of them wait). Lock order (ADR 0008 C8):
 * requisition → purchase order → approval round → requisition lines.
 *   1. CC-03: 5 buyers order 1.5 of the same 4-piece requisition line at once: two succeed.
 *   2. CC-06: one idempotency key sent twice at once creates one purchase order.
 *   3. A cancellation and a rejection of the same pending order at once: one wins, released once.
 */
let t: TestDatabase;
let rina: RequestContext;
let bayu: RequestContext;
let sari: RequestContext;
const buyers: RequestContext[] = [];
let supplierId = '';
const ITERATIONS = 20;
const PARALLEL = 5;

beforeAll(async () => {
  t = await createTestDatabase();
  await t.pool.query("INSERT INTO departments (code, name) VALUES ('OPS', 'Operations')");
  rina = await contextOf(t.appDb, await provisionActor(t.appDb, 'rina@example.com', 'Rina', ['requester'], { departmentCode: 'OPS' }));
  bayu = await contextOf(t.appDb, await provisionActor(t.appDb, 'bayu@example.com', 'Bayu', [{ role: 'approver', departmentCode: 'OPS' }], { departmentCode: 'OPS' }));
  sari = await contextOf(t.appDb, await provisionActor(t.appDb, 'sari@example.com', 'Sari', ['finance']));
  for (let n = 0; n < PARALLEL; n++) buyers.push(await contextOf(t.appDb, await provisionActor(t.appDb, `buyer${n}@example.com`, `Buyer ${n}`, ['procurement'])));
  const ada = await contextOf(t.appDb, await provisionActor(t.appDb, 'ada@example.com', 'Ada', ['admin']));
  const created = data(
    await run(buyer(0), createSupplier, {
      legalName: 'Race Supplies Ltd',
      taxId: 'RACE-7001',
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
  for (const documentType of ['requisition', 'purchase_order'] as const) {
    data(
      await run(ada, publishApprovalPolicy, {
        documentType,
        name: 'One step',
        rules: [{ departmentCode: null, minAmount: '0', maxAmount: null, steps: [documentType === 'requisition' ? { role: 'approver', scopeMode: 'document_department' } : { role: 'finance', scopeMode: 'organization' }] }],
      }),
    );
  }
  // Every purchase order needs approval (no threshold), so the third race has a round to decide.
  await t.pool.query('UPDATE org_settings SET po_approval_threshold = NULL, po_price_tolerance_pct = 0');
});

afterAll(async () => {
  await t?.drop();
});

function buyer(n: number): RequestContext {
  const found = buyers[n];
  if (!found) throw new Error(`no buyer ${n}`);
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

/** An approved requisition for 4 pieces. */
async function approvedLine(i: number): Promise<{ requisitionId: string; lineId: string }> {
  const created = data(
    await run(rina, createRequisition, { title: `Race ${i}`, justification: null, neededBy: '2030-06-30', lines: [{ description: 'Toner', quantity: '4', uom: 'pcs', estimatedUnitPrice: '45.50' }] }),
  );
  const submitted = data(await run(rina, submitRequisition, { requisitionId: created.requisitionId, expectedVersion: 1 }));
  data(await run(bayu, decideApproval, { approvalRequestId: submitted.approvalRequestId, stepNo: 1, expectedVersion: 1, decision: 'approve' }));
  const lineId = (await t.pool.query('SELECT id FROM requisition_lines WHERE requisition_id = $1', [created.requisitionId])).rows[0].id as string;
  return { requisitionId: created.requisitionId, lineId };
}

const order = (line: { requisitionId: string; lineId: string }, quantity: string, extra: Record<string, unknown> = {}) => ({
  requisitionId: line.requisitionId,
  supplierId,
  paymentTerms: null,
  deliveryAddress: null,
  expectedDeliveryDate: null,
  lines: [{ requisitionLineId: line.lineId, quantity, unitPrice: '45.50', taxRatePct: '11' }],
  ...extra,
});

async function waitForLockWaiters(count: number): Promise<void> {
  for (let i = 0; i < 300; i++) {
    // Ungranted locks from pg_locks: pg_stat_activity hides other roles' wait events from
    // non-superusers, but still shows which database each backend is in.
    const { rows } = await t.pool.query(
      `SELECT count(DISTINCT l.pid)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
       WHERE NOT l.granted AND a.datname = current_database()`,
    );
    if (rows[0].n >= count) return;
    await sleep(10);
  }
  throw new Error(`expected ${count} transactions waiting`);
}

/** Holds the requisition row FOR UPDATE until `count` transactions wait, then lets them go. */
async function overlapped(requisitionId: string, count: number, start: () => Promise<Result<unknown>>[]): Promise<Result<unknown>[]> {
  const holder = await t.pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM purchase_requisitions WHERE id = $1 FOR UPDATE', [requisitionId]);
    const pending = Promise.all(start());
    await waitForLockWaiters(count);
    await holder.query('COMMIT');
    return await pending;
  } finally {
    holder.release();
  }
}

/** PO-I1 for one requisition line, and what is ordered. */
async function orderedState(lineId: string): Promise<{ ordered: string; expected: string }> {
  const { rows } = await t.pool.query(
    `SELECT r.ordered_qty::text AS ordered, coalesce(sum(l.quantity) FILTER (WHERE po.status NOT IN ('cancelled', 'rejected')), 0)::numeric(18,3)::text AS expected
     FROM requisition_lines r LEFT JOIN purchase_order_lines l ON l.requisition_line_id = r.id LEFT JOIN purchase_orders po ON po.id = l.purchase_order_id
     WHERE r.id = $1 GROUP BY r.ordered_qty`,
    [lineId],
  );
  return rows[0];
}

describe('P7-AC12: purchase-order races, forced to overlap', () => {
  it(`CC-03: ${PARALLEL} buyers order 1.5 of the same 4-piece line at once, ${ITERATIONS} times: two succeed, never over-ordered`, async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const line = await approvedLine(i);
      const results = await overlapped(line.requisitionId, PARALLEL, () => buyers.map((b) => runCommand(b, createPurchaseOrder, order(line, '1.5'), { db: t.appDb })));
      expect(results.map(outcome).sort()).toEqual(['BUSINESS_RULE:OVER_ORDER', 'BUSINESS_RULE:OVER_ORDER', 'BUSINESS_RULE:OVER_ORDER', 'ok', 'ok']);
      expect(await orderedState(line.lineId)).toEqual({ ordered: '3.000', expected: '3.000' });
    }
  }, 180_000);

  it(`CC-06: the same idempotency key sent twice at once, ${ITERATIONS} times: one purchase order, the same answer twice`, async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const line = await approvedLine(100 + i);
      const input = order(line, '1', { idempotencyKey: `race-key-${i}-${line.lineId.slice(-8)}` });
      const results = await overlapped(line.requisitionId, 2, () => [0, 1].map(() => runCommand(buyer(0), createPurchaseOrder, input, { db: t.appDb })));
      expect(results.map(outcome)).toEqual(['ok', 'ok']);
      expect(results[0]?.ok && results[1]?.ok ? results[0].data : null).toEqual(results[1]?.ok ? results[1].data : undefined);
      expect((await t.pool.query('SELECT count(*)::int AS n FROM purchase_orders WHERE requisition_id = $1', [line.requisitionId])).rows[0].n).toBe(1);
      expect(await orderedState(line.lineId)).toEqual({ ordered: '1.000', expected: '1.000' });
    }
  }, 180_000);

  it(`a cancellation and a rejection of the same pending order at once, ${ITERATIONS} times: one wins, the quantity is released once`, async () => {
    const orders = new Set<string>();
    for (let i = 0; i < ITERATIONS; i++) {
      const line = await approvedLine(200 + i);
      const created = data(await run(buyer(1), createPurchaseOrder, order(line, '2')));
      const submitted = data(await run(buyer(1), submitPurchaseOrder, { purchaseOrderId: created.purchaseOrderId, expectedVersion: 1 }));
      const [cancelled, rejected] = await overlapped(line.requisitionId, 2, () => [
        runCommand(buyer(2), cancelPurchaseOrder, { purchaseOrderId: created.purchaseOrderId, expectedVersion: 2, reason: 'Race test' }, { db: t.appDb }),
        runCommand(sari, decideApproval, { approvalRequestId: submitted.approvalRequestId, stepNo: 1, expectedVersion: 1, decision: 'reject', comment: 'Race test' }, { db: t.appDb }),
      ]);
      if (!cancelled || !rejected) throw new Error('missing results');
      const state = (await t.pool.query('SELECT po.status AS po, r.status AS round FROM purchase_orders po JOIN approval_requests r ON r.id = po.current_approval_request_id WHERE po.id = $1', [created.purchaseOrderId])).rows[0];
      if (cancelled.ok) {
        orders.add('cancel first');
        expect(outcome(rejected)).toBe('INVALID_TRANSITION');
        expect(state).toEqual({ po: 'cancelled', round: 'cancelled' });
      } else {
        orders.add('reject first');
        expect([outcome(cancelled), outcome(rejected)]).toEqual(['CONFLICT', 'ok']);
        expect(state).toEqual({ po: 'rejected', round: 'rejected' });
      }
      expect(await orderedState(line.lineId)).toEqual({ ordered: '0.000', expected: '0.000' });
    }
    expect(orders.size).toBeGreaterThanOrEqual(1);
  }, 180_000);
});
