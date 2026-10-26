import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publishApprovalPolicy } from '@/modules/organization';
import { createRequisition, submitRequisition } from '@/modules/requisitions';
import { awardQuotation, closeRfq, createRfq, issueRfq, recordQuotation, submitQuotation, withdrawQuotation } from '@/modules/sourcing';
import { createSupplier, reviewSupplier } from '@/modules/suppliers';
import { decideApproval } from '@/server/approvals';
import type { RequestContext } from '@/shared/application/context';
import { runCommand } from '@/shared/application/runner';
import type { Result } from '@/shared/result';
import { contextOf, provisionActor } from '../support/actors';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/*
 * P6b-AC10: quotation races, each forced to overlap 20 times (a third connection holds the row
 * the commands queue on until all of them wait). Lock order (ADR 0008 C8): requisition → RFQ →
 * quotations.
 *   1. 5 buyers record a quotation from the same supplier at once: exactly one live quotation.
 *   2. 2 buyers award different quotations of one RFQ at once: one award, the other a CONFLICT.
 *   3. An award and a withdrawal of the same quotation at once: one wins, the state is consistent.
 */
let t: TestDatabase;
let rina: RequestContext;
let bayu: RequestContext;
const buyers: RequestContext[] = [];
const suppliers: string[] = [];
const ITERATIONS = 20;
const PARALLEL = 5;

beforeAll(async () => {
  t = await createTestDatabase();
  await t.pool.query("INSERT INTO departments (code, name) VALUES ('OPS', 'Operations')");
  rina = await contextOf(t.appDb, await provisionActor(t.appDb, 'rina@example.com', 'Rina', ['requester'], { departmentCode: 'OPS' }));
  bayu = await contextOf(t.appDb, await provisionActor(t.appDb, 'bayu@example.com', 'Bayu', [{ role: 'approver', departmentCode: 'OPS' }], { departmentCode: 'OPS' }));
  for (let n = 0; n < PARALLEL; n++) buyers.push(await contextOf(t.appDb, await provisionActor(t.appDb, `buyer${n}@example.com`, `Buyer ${n}`, ['procurement'])));
  const sari = await contextOf(t.appDb, await provisionActor(t.appDb, 'sari@example.com', 'Sari', ['finance']));
  const ada = await contextOf(t.appDb, await provisionActor(t.appDb, 'ada@example.com', 'Ada', ['admin']));
  for (const [n, name] of ['Race Supplies A', 'Race Supplies B'].entries()) {
    const created = data(
      await runCommand(
        buyer(0),
        createSupplier,
        { legalName: name, taxId: `RACE-000${n + 1}`, email: null, phone: null, addressLine1: null, addressLine2: null, city: null, region: null, postalCode: null, countryCode: 'US' },
        { db: t.appDb },
      ),
    );
    data(await runCommand(sari, reviewSupplier, { supplierId: created.supplierId, expectedVersion: 1, decision: 'approve', note: null }, { db: t.appDb }));
    suppliers.push(created.supplierId);
  }
  data(
    await runCommand(
      ada,
      publishApprovalPolicy,
      { documentType: 'requisition', name: 'One step', rules: [{ departmentCode: null, minAmount: '0', maxAmount: null, steps: [{ role: 'approver', scopeMode: 'document_department' }] }] },
      { db: t.appDb },
    ),
  );
});

afterAll(async () => {
  await t?.drop();
});

function buyer(n: number): RequestContext {
  const found = buyers[n];
  if (!found) throw new Error(`no buyer ${n}`);
  return found;
}

function supplier(n: number): string {
  const found = suppliers[n];
  if (!found) throw new Error(`no supplier ${n}`);
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

/** An issued RFQ for one requisition line (4 pcs), sent to both suppliers. */
async function issuedRfq(i: number): Promise<{ rfqId: string; requisitionId: string; rfqLineId: string }> {
  const created = data(
    await run(rina, createRequisition, { title: `Race ${i}`, justification: null, neededBy: '2030-06-30', lines: [{ description: 'Toner', quantity: '4', uom: 'pcs', estimatedUnitPrice: '45.50' }] }),
  );
  const submitted = data(await run(rina, submitRequisition, { requisitionId: created.requisitionId, expectedVersion: 1 }));
  data(await run(bayu, decideApproval, { approvalRequestId: submitted.approvalRequestId, stepNo: 1, expectedVersion: 1, decision: 'approve' }));
  const line = (await t.pool.query('SELECT id FROM requisition_lines WHERE requisition_id = $1', [created.requisitionId])).rows[0].id as string;
  const rfq = data(
    await run(buyer(0), createRfq, {
      requisitionId: created.requisitionId,
      title: `Race ${i}`,
      responseDueAt: '2030-03-15T17:00',
      lines: [{ requisitionLineId: line, quantity: '4' }],
      supplierIds: [supplier(0), supplier(1)],
    }),
  );
  data(await run(buyer(0), issueRfq, { rfqId: rfq.rfqId, expectedVersion: 1 }));
  const rfqLineId = (await t.pool.query('SELECT id FROM rfq_lines WHERE rfq_id = $1', [rfq.rfqId])).rows[0].id as string;
  return { rfqId: rfq.rfqId, requisitionId: created.requisitionId, rfqLineId };
}

const quote = (rfq: { rfqId: string; rfqLineId: string }, supplierId: string, unitPrice: string) => ({
  rfqId: rfq.rfqId,
  supplierId,
  supplierReference: null,
  validUntil: '2030-03-31',
  leadTimeDays: 7,
  lines: [{ rfqLineId: rfq.rfqLineId, unitPrice }],
});

/** A closed RFQ with a submitted quotation from each supplier; A (40) is lower than B (42). */
async function closedRfqWithQuotes(i: number): Promise<{ rfqId: string; requisitionId: string; a: string; b: string; version: number }> {
  const rfq = await issuedRfq(i);
  const ids: string[] = [];
  for (const [n, price] of ['40', '42'].entries()) {
    const recorded = data(await run(buyer(0), recordQuotation, quote(rfq, supplier(n), price)));
    data(await run(buyer(0), submitQuotation, { quotationId: recorded.quotationId, expectedVersion: 1 }));
    ids.push(recorded.quotationId);
  }
  const closed = data(await run(buyer(0), closeRfq, { rfqId: rfq.rfqId, expectedVersion: 2 }));
  return { rfqId: rfq.rfqId, requisitionId: rfq.requisitionId, a: ids[0] as string, b: ids[1] as string, version: closed.version };
}

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

/** Holds `table` row `id` FOR UPDATE until `count` transactions wait, then lets them go. */
async function overlapped(table: 'rfqs' | 'purchase_requisitions', id: string, count: number, start: () => Promise<Result<unknown>>[]): Promise<Result<unknown>[]> {
  const holder = await t.pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query(`SELECT 1 FROM ${table === 'rfqs' ? 'rfqs' : 'purchase_requisitions'} WHERE id = $1 FOR UPDATE`, [id]);
    const pending = Promise.all(start());
    await waitForLockWaiters(count);
    await holder.query('COMMIT');
    return await pending;
  } finally {
    holder.release();
  }
}

describe('P6b-AC10: quotation races, forced to overlap', () => {
  it(`${PARALLEL} buyers record a quotation from the same supplier at once, ${ITERATIONS} times: exactly one`, async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const rfq = await issuedRfq(i);
      const results = await overlapped('rfqs', rfq.rfqId, PARALLEL, () =>
        buyers.map((b, n) => runCommand(b, recordQuotation, quote(rfq, supplier(0), String(40 + n)), { db: t.appDb })),
      );
      expect(results.map(outcome).sort()).toEqual(['ok', ...Array(PARALLEL - 1).fill('BUSINESS_RULE:SUPPLIER_ALREADY_QUOTED')].sort());
      const { rows } = await t.pool.query("SELECT count(*)::int AS n FROM quotations WHERE rfq_id = $1 AND supplier_id = $2 AND status <> 'withdrawn'", [rfq.rfqId, supplier(0)]);
      expect(rows[0].n).toBe(1);
    }
  }, 120_000);

  it(`2 buyers award different quotations of one RFQ at once, ${ITERATIONS} times: one award, one CONFLICT`, async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const rfq = await closedRfqWithQuotes(100 + i);
      const results = await overlapped('purchase_requisitions', rfq.requisitionId, 2, () =>
        [rfq.a, rfq.b].map((quotationId, n) =>
          runCommand(buyer(n + 1), awardQuotation, { rfqId: rfq.rfqId, quotationId, expectedVersion: rfq.version, justification: 'Race test' }, { db: t.appDb }),
        ),
      );
      expect(results.map(outcome).sort()).toEqual(['CONFLICT', 'ok']);
      const winner = results[0]?.ok ? rfq.a : rfq.b;
      const { rows } = await t.pool.query('SELECT id, status FROM quotations WHERE rfq_id = $1 ORDER BY id', [rfq.rfqId]);
      expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({ [winner]: 'awarded', [winner === rfq.a ? rfq.b : rfq.a]: 'not_awarded' });
      const awarded = (await t.pool.query('SELECT status, awarded_quotation_id FROM rfqs WHERE id = $1', [rfq.rfqId])).rows[0];
      expect(awarded).toEqual({ status: 'awarded', awarded_quotation_id: winner });
    }
  }, 120_000);

  it(`an award and a withdrawal of the same quotation at once, ${ITERATIONS} times: one wins, the other is refused`, async () => {
    const orders = new Set<string>();
    for (let i = 0; i < ITERATIONS; i++) {
      const rfq = await closedRfqWithQuotes(200 + i);
      const [awarded, withdrawn] = await overlapped('rfqs', rfq.rfqId, 2, () => [
        runCommand(buyer(1), awardQuotation, { rfqId: rfq.rfqId, quotationId: rfq.a, expectedVersion: rfq.version }, { db: t.appDb }),
        runCommand(buyer(2), withdrawQuotation, { quotationId: rfq.a, expectedVersion: 2, reason: 'Supplier withdrew' }, { db: t.appDb }),
      ]);
      if (!awarded || !withdrawn) throw new Error('missing results');
      const state = (await t.pool.query('SELECT r.status AS rfq, q.status AS quotation FROM rfqs r JOIN quotations q ON q.id = $2 WHERE r.id = $1', [rfq.rfqId, rfq.a])).rows[0];
      if (awarded.ok) {
        // The award changed the quotation, so the withdrawal holds a stale version.
        orders.add('award first');
        expect(outcome(withdrawn)).toBe('CONFLICT');
        expect(state).toEqual({ rfq: 'awarded', quotation: 'awarded' });
      } else {
        // The withdrawal left the RFQ as it was; the award then finds the quotation withdrawn.
        orders.add('withdrawal first');
        expect([outcome(awarded), outcome(withdrawn)]).toEqual(['INVALID_TRANSITION', 'ok']);
        expect(state).toEqual({ rfq: 'closed', quotation: 'withdrawn' });
      }
    }
    expect(orders.size).toBeGreaterThanOrEqual(1);
  }, 120_000);
});
