import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publishApprovalPolicy } from '@/modules/organization';
import { cancelRequisition, createRequisition, submitRequisition, updateRequisitionDraft } from '@/modules/requisitions';
import { decideApproval } from '@/server/approvals';
import type { RequestContext } from '@/shared/application/context';
import { runCommand } from '@/shared/application/runner';
import type { Result } from '@/shared/result';
import { contextOf, provisionActor } from '../support/actors';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/*
 * P5b-AC10 (ADR 0008):
 * CC-01: 2 to 10 approvers decide the same step at once. Exactly one decision is recorded.
 * CC-02: an edit and a submit race on the same requisition version. The result equals one serial order.
 * Plus a withdrawal racing the last approval (lock order C8: document, then approval request).
 * Every race is forced: a third connection holds the requisition row until all contenders wait on it.
 */
let t: TestDatabase;
let rina: RequestContext;
let sari: RequestContext;
const approvers: RequestContext[] = [];
const ITERATIONS = 20;

beforeAll(async () => {
  t = await createTestDatabase();
  await t.pool.query("INSERT INTO departments (code, name) VALUES ('OPS', 'Operations')");
  rina = await contextOf(t.appDb, await provisionActor(t.appDb, 'rina@example.com', 'Rina', ['requester'], { departmentCode: 'OPS' }));
  sari = await contextOf(t.appDb, await provisionActor(t.appDb, 'sari@example.com', 'Sari', ['finance']));
  for (let n = 0; n < 10; n++) {
    const id = await provisionActor(t.appDb, `approver${n}@example.com`, `Approver ${n}`, [{ role: 'approver', departmentCode: 'OPS' }], { departmentCode: 'OPS' });
    approvers.push(await contextOf(t.appDb, id));
  }
  const ada = await contextOf(t.appDb, await provisionActor(t.appDb, 'ada@example.com', 'Ada', ['admin']));
  const published = await runCommand(
    ada,
    publishApprovalPolicy,
    {
      documentType: 'requisition',
      name: 'Two steps',
      rules: [
        {
          departmentCode: null,
          minAmount: '0',
          maxAmount: null,
          steps: [
            { role: 'approver', scopeMode: 'document_department' },
            { role: 'finance', scopeMode: 'organization' },
          ],
        },
      ],
    },
    { db: t.appDb },
  );
  if (!published.ok) throw new Error(published.error.message);
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

const draft = (title: string, quantity = '2') => ({
  title,
  justification: null,
  neededBy: '2030-01-31',
  lines: [{ description: 'Toner', quantity, uom: 'pcs', estimatedUnitPrice: '45.50' }],
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
  throw new Error(`expected ${count} transactions waiting on the requisition row`);
}

/** Starts the contenders while the requisition row is held, so all of them queue on it. */
async function forcedRace(requisitionId: string, contenders: (() => Promise<Result<unknown>>)[]): Promise<Result<unknown>[]> {
  const holder = await t.pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM purchase_requisitions WHERE id = $1 FOR UPDATE', [requisitionId]);
    const pending = Promise.all(contenders.map((start) => start()));
    await waitForLockWaiters(contenders.length);
    await holder.query('COMMIT');
    return await pending;
  } finally {
    holder.release();
  }
}

async function submittedRequisition(title: string): Promise<{ requisitionId: string; approvalRequestId: string; version: number }> {
  const created = data(await runCommand(rina, createRequisition, draft(title), { db: t.appDb }));
  const submitted = data(await runCommand(rina, submitRequisition, { requisitionId: created.requisitionId, expectedVersion: 1 }, { db: t.appDb }));
  return { requisitionId: created.requisitionId, approvalRequestId: submitted.approvalRequestId, version: submitted.version };
}

describe('CC-01: concurrent decisions on one step', () => {
  it(`2 to 10 approvers at once, ${ITERATIONS} forced overlaps: exactly one decision recorded`, async () => {
    const decisions = ['approve', 'reject', 'return'] as const;
    for (let i = 0; i < ITERATIONS; i++) {
      const pr = await submittedRequisition(`Decision race ${i}`);
      const count = 2 + (i % 9);
      const results = await forcedRace(
        pr.requisitionId,
        approvers.slice(0, count).map((approver, n) => () =>
          runCommand(
            approver,
            decideApproval,
            { approvalRequestId: pr.approvalRequestId, stepNo: 1, expectedVersion: 1, decision: decisions[(i + n) % 3], comment: `Race ${i}.${n}` },
            { db: t.appDb },
          ),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      for (const loser of results.filter((r) => !r.ok)) expect(['CONFLICT', 'INVALID_TRANSITION']).toContain(outcome(loser));

      const steps = (await t.pool.query('SELECT status, decided_by_user_id FROM approval_steps WHERE approval_request_id = $1 ORDER BY step_no', [pr.approvalRequestId])).rows;
      expect(steps.filter((s) => s.decided_by_user_id !== null)).toHaveLength(1);
      const request = (await t.pool.query('SELECT status, version FROM approval_requests WHERE id = $1', [pr.approvalRequestId])).rows[0];
      const requisition = (await t.pool.query('SELECT status FROM purchase_requisitions WHERE id = $1', [pr.requisitionId])).rows[0];
      const expected = {
        approved: { steps: ['approved', 'pending'], request: 'pending', requisition: 'pending_approval' },
        rejected: { steps: ['rejected', 'cancelled'], request: 'rejected', requisition: 'rejected' },
        returned: { steps: ['returned', 'cancelled'], request: 'returned', requisition: 'returned' },
      }[steps[0].status as 'approved' | 'rejected' | 'returned'];
      expect({ steps: steps.map((s) => s.status), request: request.status, requisition: requisition.status }).toEqual(expected);
      expect(request.version).toBe(2);
      const { rows } = await t.pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'approval.decided' AND entity_id = $1", [pr.approvalRequestId]);
      expect(rows[0].n).toBe(1);
    }
  });
});

describe('CC-02: edit and submit race on one requisition', () => {
  it(`${ITERATIONS} forced overlaps: one wins, the other gets CONFLICT, and nothing is lost`, async () => {
    const winners = { edit: 0, submit: 0 };
    for (let i = 0; i < ITERATIONS; i++) {
      const created = data(await runCommand(rina, createRequisition, draft(`Edit race ${i}`), { db: t.appDb }));
      const input = { requisitionId: created.requisitionId, expectedVersion: 1 };
      const contenders = [
        () => runCommand(rina, updateRequisitionDraft, { ...input, ...draft(`Edit race ${i}`, '7') }, { db: t.appDb }),
        () => runCommand(rina, submitRequisition, input, { db: t.appDb }),
      ];
      // Alternate who queues first.
      const ordered = i % 2 === 0 ? contenders : [...contenders].reverse();
      const results = await forcedRace(created.requisitionId, ordered);
      const [edit, submit] = i % 2 === 0 ? results : [...results].reverse();
      if (!edit || !submit) throw new Error('missing result');
      expect([outcome(edit), outcome(submit)].sort()).toEqual(['CONFLICT', 'ok']);

      const row = (await t.pool.query('SELECT status, version, estimated_total FROM purchase_requisitions WHERE id = $1', [created.requisitionId])).rows[0];
      const lines = (await t.pool.query('SELECT quantity, line_total FROM requisition_lines WHERE requisition_id = $1', [created.requisitionId])).rows;
      const requests = (await t.pool.query('SELECT amount_snapshot FROM approval_requests WHERE document_id = $1', [created.requisitionId])).rows;
      if (edit.ok) {
        winners.edit++;
        expect(row).toEqual({ status: 'draft', version: 2, estimated_total: '318.5000' });
        expect(lines).toEqual([{ quantity: '7.000', line_total: '318.5000' }]);
        expect(requests).toEqual([]);
      } else {
        winners.submit++;
        // The approvers were asked to approve exactly what is stored.
        expect(row).toEqual({ status: 'pending_approval', version: 2, estimated_total: '91.0000' });
        expect(lines).toEqual([{ quantity: '2.000', line_total: '91.0000' }]);
        expect(requests).toEqual([{ amount_snapshot: '91.0000' }]);
      }
    }
    // Both orders happened, so both outcomes were checked.
    expect(winners.edit).toBeGreaterThan(0);
    expect(winners.submit).toBeGreaterThan(0);
  });
});

describe('withdrawal racing the last approval (lock order C8)', () => {
  it(`${ITERATIONS} forced overlaps: one wins, no deadlock, and the request matches the requisition`, async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const pr = await submittedRequisition(`Withdraw race ${i}`);
      data(await runCommand(approvers[0] as RequestContext, decideApproval, { approvalRequestId: pr.approvalRequestId, stepNo: 1, expectedVersion: 1, decision: 'approve' }, { db: t.appDb }));
      const results = await forcedRace(pr.requisitionId, [
        () => runCommand(sari, decideApproval, { approvalRequestId: pr.approvalRequestId, stepNo: 2, expectedVersion: 2, decision: 'approve' }, { db: t.appDb }),
        () => runCommand(rina, cancelRequisition, { requisitionId: pr.requisitionId, expectedVersion: pr.version, reason: 'Withdrawn' }, { db: t.appDb }),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      // Either the approval moved the requisition on (the withdrawal sees a newer version), or the
      // withdrawal ended the request (the approval finds it complete). Never a deadlock (40P01),
      // which the runner would also report as CONFLICT, with a different message.
      const [approval, withdrawal] = results;
      if (!approval || !withdrawal) throw new Error('missing result');
      if (approval.ok) {
        expect(withdrawal).toMatchObject({ ok: false, error: { code: 'CONFLICT', message: expect.stringContaining('changed since you loaded it') } });
      } else {
        expect(approval).toMatchObject({ ok: false, error: { code: 'INVALID_TRANSITION', message: 'This approval is already complete.' } });
      }
      const request = (await t.pool.query('SELECT status FROM approval_requests WHERE id = $1', [pr.approvalRequestId])).rows[0].status;
      const requisition = (await t.pool.query('SELECT status FROM purchase_requisitions WHERE id = $1', [pr.requisitionId])).rows[0].status;
      expect([
        ['approved', 'approved'],
        ['cancelled', 'cancelled'],
      ]).toContainEqual([request, requisition]);
    }
  });
});
