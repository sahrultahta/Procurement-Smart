import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publishApprovalPolicy } from '@/modules/organization';
import { createRequisition, submitRequisition } from '@/modules/requisitions';
import { createRfq } from '@/modules/sourcing';
import { createSupplier, reviewSupplier } from '@/modules/suppliers';
import { decideApproval } from '@/server/approvals';
import type { RequestContext } from '@/shared/application/context';
import { runCommand } from '@/shared/application/runner';
import type { Result } from '@/shared/result';
import { contextOf, provisionActor } from '../support/actors';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/*
 * P6a-AC8: 5 buyers draft an RFQ for the same requisition line at once, forced to overlap
 * (a third connection holds the requisition row until all of them wait on it), 20 times.
 * The requisition row lock (C1, lock order C8) makes them run one after another; the line
 * check (and the rfq_lines trigger behind it) lets exactly one through.
 */
let t: TestDatabase;
let rina: RequestContext;
let bayu: RequestContext;
const buyers: RequestContext[] = [];
let supplierId: string;
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
  const supplier = data(
    await runCommand(
      buyers[0] as RequestContext,
      createSupplier,
      { legalName: 'Race Supplies', taxId: 'RACE-0001', email: null, phone: null, addressLine1: null, addressLine2: null, city: null, region: null, postalCode: null, countryCode: 'US' },
      { db: t.appDb },
    ),
  );
  supplierId = supplier.supplierId;
  data(await runCommand(sari, reviewSupplier, { supplierId, expectedVersion: 1, decision: 'approve', note: null }, { db: t.appDb }));
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

function outcome(result: Result<unknown>): string {
  return result.ok ? 'ok' : `${result.error.code}${result.error.rule ? `:${result.error.rule}` : ''}`;
}

function data<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(outcome(result));
  return result.data;
}

async function approvedRequisition(i: number): Promise<{ requisitionId: string; lineId: string }> {
  const created = data(
    await runCommand(
      rina,
      createRequisition,
      { title: `Race ${i}`, justification: null, neededBy: '2030-06-30', lines: [{ description: 'Toner', quantity: '4', uom: 'pcs', estimatedUnitPrice: '45.50' }] },
      { db: t.appDb },
    ),
  );
  const submitted = data(await runCommand(rina, submitRequisition, { requisitionId: created.requisitionId, expectedVersion: 1 }, { db: t.appDb }));
  data(await runCommand(bayu, decideApproval, { approvalRequestId: submitted.approvalRequestId, stepNo: 1, expectedVersion: 1, decision: 'approve' }, { db: t.appDb }));
  const { rows } = await t.pool.query('SELECT id FROM requisition_lines WHERE requisition_id = $1', [created.requisitionId]);
  return { requisitionId: created.requisitionId, lineId: rows[0].id };
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
  throw new Error(`expected ${count} transactions waiting on the requisition row`);
}

describe('P6a-AC8: parallel RFQs for the same requisition line', () => {
  it(`${PARALLEL} at once, ${ITERATIONS} forced overlaps: exactly one RFQ, numbers gapless`, async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const pr = await approvedRequisition(i);
      const holder = await t.pool.connect();
      let results: Result<unknown>[];
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT 1 FROM purchase_requisitions WHERE id = $1 FOR UPDATE', [pr.requisitionId]);
        const pending = Promise.all(
          buyers.map((buyer, n) =>
            runCommand(
              buyer,
              createRfq,
              {
                requisitionId: pr.requisitionId,
                title: `Race ${i}.${n}`,
                responseDueAt: '2030-03-15T17:00',
                lines: [{ requisitionLineId: pr.lineId, quantity: String(1 + n * 0.5) }],
                supplierIds: [supplierId],
              },
              { db: t.appDb },
            ),
          ),
        );
        await waitForLockWaiters(PARALLEL);
        await holder.query('COMMIT');
        results = await pending;
      } finally {
        holder.release();
      }
      expect(results.map(outcome).sort()).toEqual(['ok', ...Array(PARALLEL - 1).fill('BUSINESS_RULE:LINE_ALREADY_IN_RFQ')].sort());
      const { rows } = await t.pool.query('SELECT count(*)::int AS n FROM rfq_lines WHERE requisition_line_id = $1', [pr.lineId]);
      expect(rows[0].n).toBe(1);
    }
    // Rolled-back creates give their numbers back (C5).
    const { rows } = await t.pool.query('SELECT array_agg(substr(number, 10)::int ORDER BY number) AS n FROM rfqs');
    expect(rows[0].n).toEqual(Array.from({ length: ITERATIONS }, (_, k) => k + 1));
  });
});
