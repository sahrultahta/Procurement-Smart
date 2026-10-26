import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APPROVAL_ROUND_KEYS, APPROVAL_STEP_KEYS, INBOX_ITEM_KEYS, OPEN_DECISION_KEYS, approvalInbox } from '@/modules/approvals';
import { publishApprovalPolicy } from '@/modules/organization';
import {
  REQUISITION_DETAIL_KEYS,
  cancelRequisition,
  closeRequisition,
  createRequisition,
  getRequisition,
  submitRequisition,
  updateRequisitionDraft,
} from '@/modules/requisitions';
import { createPurchaseOrder } from '@/modules/purchasing';
import { createSupplier, reviewSupplier } from '@/modules/suppliers';
import { decideApproval } from '@/server/approvals';
import { fixedClock, type Clock } from '@/shared/clock';
import { runCommand, runQuery, type Operation } from '@/shared/application/runner';
import type { Result } from '@/shared/result';
import { contextOf, provisionActor } from '../support/actors';
import { createTestDatabase, sqlStateOf, type TestDatabase } from '../support/test-db';

/* Phase 5b: submission and multi-step approvals, as the runtime role through the command runner. */

let t: TestDatabase;
type Persona = 'rina' | 'rudi' | 'riko' | 'bayu' | 'budi' | 'sinta' | 'oscar' | 'sari' | 'fajar' | 'vera' | 'double' | 'dewi' | 'lena' | 'ada';
const u = {} as Record<Persona, string>;

beforeAll(async () => {
  t = await createTestDatabase();
  await t.pool.query("INSERT INTO departments (code, name) VALUES ('OPS', 'Operations'), ('FIN', 'Finance'), ('SAL', 'Sales')");
  const ops = { departmentCode: 'OPS' };
  u.rina = await provisionActor(t.appDb, 'rina@example.com', 'Rina Requester', ['requester'], ops);
  u.rudi = await provisionActor(t.appDb, 'rudi@example.com', 'Rudi Requester', ['requester'], { departmentCode: 'SAL' });
  u.riko = await provisionActor(t.appDb, 'riko@example.com', 'Riko Both', ['requester', { role: 'approver', departmentCode: 'OPS' }], ops);
  u.bayu = await provisionActor(t.appDb, 'bayu@example.com', 'Bayu Approver', [{ role: 'approver', departmentCode: 'OPS' }], ops);
  u.budi = await provisionActor(t.appDb, 'budi@example.com', 'Budi Approver', [{ role: 'approver', departmentCode: 'OPS' }], ops);
  u.sinta = await provisionActor(t.appDb, 'sinta@example.com', 'Sinta Sales Approver', [{ role: 'approver', departmentCode: 'SAL' }], { departmentCode: 'SAL' });
  u.oscar = await provisionActor(t.appDb, 'oscar@example.com', 'Oscar Org Approver', ['approver']);
  u.sari = await provisionActor(t.appDb, 'sari@example.com', 'Sari Finance', ['finance'], { departmentCode: 'FIN' });
  u.fajar = await provisionActor(t.appDb, 'fajar@example.com', 'Fajar Finance', ['finance'], { departmentCode: 'FIN' });
  u.vera = await provisionActor(t.appDb, 'vera@example.com', 'Vera Approver Finance', [{ role: 'approver', departmentCode: 'OPS' }, 'finance'], ops);
  u.double = await provisionActor(t.appDb, 'double@example.com', 'Dana Double', [{ role: 'approver', departmentCode: 'OPS' }, 'finance'], ops);
  u.dewi = await provisionActor(t.appDb, 'dewi@example.com', 'Dewi Procurement', ['procurement']);
  u.lena = await provisionActor(t.appDb, 'lena@example.com', 'Lena Auditor', ['auditor']);
  u.ada = await provisionActor(t.appDb, 'ada@example.com', 'Ada Admin', ['admin']);
});

afterAll(async () => {
  await t?.drop();
});

async function run<I, O>(as: string, op: Operation<I, O>, input: unknown, clock?: Clock): Promise<Result<O>> {
  const context = await contextOf(t.appDb, as);
  const options = { db: t.appDb, ...(clock ? { clock } : {}) };
  return op.kind === 'command' ? runCommand(context, op, input, options) : runQuery(context, op, input, options);
}

function data<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.data;
}

const approverStep = { role: 'approver', scopeMode: 'document_department' } as const;
const orgApproverStep = { role: 'approver', scopeMode: 'organization' } as const;
const financeStep = { role: 'finance', scopeMode: 'organization' } as const;
const STANDARD = [
  { departmentCode: null, minAmount: '0', maxAmount: '1000', steps: [approverStep] },
  { departmentCode: null, minAmount: '1000', maxAmount: null, steps: [approverStep, financeStep] },
];
const THREE_STEPS = [{ departmentCode: null, minAmount: '0', maxAmount: null, steps: [approverStep, orgApproverStep, financeStep] }];
const FINANCE_ONLY = [{ departmentCode: null, minAmount: '0', maxAmount: null, steps: [financeStep] }];

async function publish(name: string, rules: unknown[]): Promise<number> {
  return data(await run(u.ada, publishApprovalPolicy, { documentType: 'requisition', name, rules })).versionNo;
}

/** Each group of tests below starts from the standard policy, whatever an earlier group published. */
function withStandardPolicy(): void {
  beforeAll(async () => {
    await publish('Standard', STANDARD);
  });
}

const line = (overrides: Record<string, unknown> = {}) => ({ description: 'A4 paper', quantity: '3', uom: 'ream', estimatedUnitPrice: '10.005', ...overrides });
const small = (overrides: Record<string, unknown> = {}) => ({ title: 'Office supplies', justification: null, neededBy: '2030-06-30', lines: [line()], ...overrides });
const large = (overrides: Record<string, unknown> = {}) => small({ title: 'Docking stations', lines: [line({ description: 'Dock', quantity: '2', uom: 'pcs', estimatedUnitPrice: '600' })], ...overrides });

async function create(as: string, input: Record<string, unknown> = small()) {
  return data(await run(as, createRequisition, input));
}

async function submitted(as: string, input: Record<string, unknown> = small()) {
  const created = await create(as, input);
  const result = data(await run(as, submitRequisition, { requisitionId: created.requisitionId, expectedVersion: created.version }));
  return { requisitionId: created.requisitionId, number: created.number, ...result };
}

async function requestRow(approvalRequestId: string) {
  return (await t.pool.query('SELECT * FROM approval_requests WHERE id = $1', [approvalRequestId])).rows[0];
}

async function stepsOf(approvalRequestId: string): Promise<string[]> {
  return (await t.pool.query('SELECT status FROM approval_steps WHERE approval_request_id = $1 ORDER BY step_no', [approvalRequestId])).rows.map((r) => r.status);
}

async function decide(as: string, approvalRequestId: string, stepNo: number, decision: 'approve' | 'reject' | 'return', comment?: string) {
  const { version } = await requestRow(approvalRequestId);
  return run(as, decideApproval, { approvalRequestId, stepNo, expectedVersion: version, decision, ...(comment === undefined ? {} : { comment }) });
}

const get = async (as: string, requisitionId: string) => data(await run(as, getRequisition, { requisitionId }));
const status = async (requisitionId: string) => (await t.pool.query('SELECT status FROM purchase_requisitions WHERE id = $1', [requisitionId])).rows[0].status as string;
const auditActions = async (entityId: string) => (await t.pool.query('SELECT action FROM audit_events WHERE entity_id = $1 ORDER BY id', [entityId])).rows.map((r) => r.action);
const inbox = async (as: string, limit = 100) => data(await run(as, approvalInbox, { limit }));
const rule = (result: Result<unknown>) => (result.ok ? 'ok' : (result.error.rule ?? result.error.code));

describe('P5b-AC2: submitting a requisition (PR-T03, AP-T01)', () => {
  it('without an active approval policy, NO_APPROVAL_ROUTE: never auto-approved', async () => {
    const created = await create(u.rina);
    const result = await run(u.rina, submitRequisition, { requisitionId: created.requisitionId, expectedVersion: 1 });
    expect(result).toMatchObject({ ok: false, error: { code: 'BUSINESS_RULE', rule: 'NO_APPROVAL_ROUTE' } });
    expect(await status(created.requisitionId)).toBe('draft');
    expect((await t.pool.query('SELECT count(*)::int AS n FROM approval_requests')).rows[0].n).toBe(0);
    await publish('Standard', STANDARD);
  });

  it('freezes the route, amount, department, number, title, and policy version into round 1', async () => {
    const created = await create(u.rina);
    const result = data(await run(u.rina, submitRequisition, { requisitionId: created.requisitionId, expectedVersion: 1 }));
    expect(result).toMatchObject({ status: 'pending_approval', version: 2, round: 1 });
    const row = await requestRow(result.approvalRequestId);
    const ops = (await t.pool.query("SELECT id FROM departments WHERE code = 'OPS'")).rows[0].id;
    expect(row).toMatchObject({
      document_type: 'requisition',
      document_id: created.requisitionId,
      round: 1,
      document_number: created.number,
      document_title: 'Office supplies',
      amount_snapshot: '30.0200',
      currency_code: 'USD',
      department_id: ops,
      policy_version_no: 1,
      submitted_by_user_id: u.rina,
      awarded_by_user_id: null,
      status: 'pending',
      version: 1,
    });
    const steps = (await t.pool.query('SELECT * FROM approval_steps WHERE approval_request_id = $1 ORDER BY step_no', [row.id])).rows;
    expect(steps.map((s) => [s.step_no, s.required_role, s.scope_department_id, s.status, s.activated_at !== null])).toEqual([[1, 'approver', ops, 'pending', true]]);

    const detail = await get(u.rina, created.requisitionId);
    expect(detail).toMatchObject({ status: 'pending_approval', callerCanEdit: false, callerActions: ['cancel'], openDecision: null });
    expect(detail.submittedAt).not.toBeNull();
    expect(detail.approvalHistory).toMatchObject([
      { round: 1, status: 'pending', policyVersionNo: 1, amount: '30.02', submittedBy: 'Rina Requester', completedAt: null, steps: [{ stepNo: 1, label: 'Approver for OPS', status: 'pending', decidedBy: null }] },
    ]);

    const audit = (await t.pool.query('SELECT action, entity_type, changes FROM audit_events WHERE entity_id IN ($1, $2) ORDER BY id', [created.requisitionId, row.id])).rows;
    expect(audit.slice(-2)).toEqual([
      expect.objectContaining({
        action: 'approval.requested',
        entity_type: 'approval_request',
        changes: expect.objectContaining({ route: [null, ['1. Approver for OPS']], steps: [null, ['1. pending']], amount: [null, '30.02'], round: [null, 1] }),
      }),
      expect.objectContaining({
        action: 'requisition.submitted',
        changes: { status: ['draft', 'pending_approval'], round: [null, 1], approvalRoute: [null, ['1. Approver for OPS']] },
      }),
    ]);
  });

  it('from 1,000 the route has two steps, and the lines are read-only once submitted', async () => {
    const pr = await submitted(u.rina, large());
    expect(await stepsOf(pr.approvalRequestId)).toEqual(['pending', 'waiting']);
    expect((await get(u.rina, pr.requisitionId)).approvalHistory[0]?.steps.map((s) => s.label)).toEqual(['Approver for OPS', 'Finance']);
    expect(await run(u.rina, updateRequisitionDraft, { requisitionId: pr.requisitionId, expectedVersion: pr.version, ...large({ title: 'Changed' }) })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_TRANSITION' },
    });
    expect(await sqlStateOf(() => t.appPool.query("UPDATE requisition_lines SET estimated_unit_price = 1 WHERE requisition_id = $1", [pr.requisitionId]))).toBe('PFQ01');
  });

  it('needs a positive total and a needed-by date not before today in the organization time zone', async () => {
    const zero = await create(u.rina, small({ lines: [line({ estimatedUnitPrice: '0' })] }));
    expect(rule(await run(u.rina, submitRequisition, { requisitionId: zero.requisitionId, expectedVersion: 1 }))).toBe('ZERO_TOTAL');

    const due = await create(u.rina, small({ neededBy: '2030-06-30' }));
    const input = { requisitionId: due.requisitionId, expectedVersion: 1 };
    // 20:00 UTC on the due date: still the due date in UTC, already the next day in Jakarta.
    const evening = fixedClock('2030-06-30T20:00:00Z');
    await t.pool.query("UPDATE org_settings SET timezone = 'Asia/Jakarta'");
    expect(rule(await run(u.rina, submitRequisition, input, evening))).toBe('NEEDED_BY_IN_PAST');
    await t.pool.query("UPDATE org_settings SET timezone = 'UTC'");
    expect(rule(await run(u.rina, submitRequisition, input, fixedClock('2030-07-01T00:00:00Z')))).toBe('NEEDED_BY_IN_PAST');
    expect(rule(await run(u.rina, submitRequisition, input, evening))).toBe('ok');
  });

  it('is for the requester only, at the current version, from draft or returned, with no extra fields', async () => {
    const created = await create(u.rina);
    const input = { requisitionId: created.requisitionId, expectedVersion: 1 };
    expect(rule(await run(u.bayu, submitRequisition, input))).toBe('FORBIDDEN');
    expect(rule(await run(u.rudi, submitRequisition, input))).toBe('NOT_FOUND');
    expect(rule(await run(u.rina, submitRequisition, { ...input, expectedVersion: 2 }))).toBe('CONFLICT');
    expect(rule(await run(u.rina, submitRequisition, { ...input, status: 'approved' }))).toBe('VALIDATION_FAILED');
    expect(rule(await run(u.rina, submitRequisition, { ...input, approvalRoute: [] }))).toBe('VALIDATION_FAILED');
    expect(rule(await run(u.rina, submitRequisition, input))).toBe('ok');
    expect(rule(await run(u.rina, submitRequisition, { ...input, expectedVersion: 2 }))).toBe('INVALID_TRANSITION');
    const cancelled = await create(u.rina);
    data(await run(u.rina, cancelRequisition, { requisitionId: cancelled.requisitionId, expectedVersion: 1, reason: null }));
    expect(rule(await run(u.rina, submitRequisition, { requisitionId: cancelled.requisitionId, expectedVersion: 2 }))).toBe('INVALID_TRANSITION');
  });
});

describe('P5b-AC3: deciding a step (AP-T02 to AP-T04)', () => {
  withStandardPolicy();

  it('approving the only step approves the requisition, with audit and history', async () => {
    const pr = await submitted(u.rina);
    expect(data(await decide(u.bayu, pr.approvalRequestId, 1, 'approve'))).toEqual({
      requestStatus: 'approved',
      documentType: 'requisition',
      documentId: pr.requisitionId,
      documentStatus: 'approved',
      version: 2,
    });
    const detail = await get(u.rina, pr.requisitionId);
    expect(detail).toMatchObject({ status: 'approved', callerActions: ['cancel'] });
    expect(detail.approvedAt).not.toBeNull();
    expect(detail.approvalHistory[0]).toMatchObject({ status: 'approved', steps: [{ status: 'approved', decidedBy: 'Bayu Approver', comment: null }] });
    expect(detail.approvalHistory[0]?.completedAt).not.toBeNull();
    expect(await auditActions(pr.approvalRequestId)).toEqual(['approval.requested', 'approval.decided']);
    expect(await auditActions(pr.requisitionId)).toEqual(['requisition.created', 'requisition.submitted', 'requisition.approved']);
    const decided = (await t.pool.query("SELECT actor_user_id, changes FROM audit_events WHERE action = 'approval.decided' AND entity_id = $1", [pr.approvalRequestId])).rows[0];
    expect(decided).toEqual({ actor_user_id: u.bayu, changes: { steps: [['1. pending'], ['1. approved']], status: ['pending', 'approved'] } });
  });

  it('rejecting and returning need a comment; the comment is stored and audited', async () => {
    const pr = await submitted(u.rina);
    for (const comment of [undefined, '', '   ']) {
      const result = await decide(u.bayu, pr.approvalRequestId, 1, 'reject', comment);
      expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', fieldErrors: { comment: [expect.stringContaining('required')] } } });
    }
    expect(rule(await decide(u.bayu, pr.approvalRequestId, 1, 'reject', 'x'.repeat(2001)))).toBe('VALIDATION_FAILED');
    expect(data(await decide(u.bayu, pr.approvalRequestId, 1, 'reject', '  Not in this budget  '))).toMatchObject({ requestStatus: 'rejected', documentStatus: 'rejected' });
    expect((await get(u.rina, pr.requisitionId)).approvalHistory[0]?.steps[0]).toMatchObject({ status: 'rejected', comment: 'Not in this budget' });
    expect((await t.pool.query("SELECT reason FROM audit_events WHERE action = 'requisition.rejected' AND entity_id = $1", [pr.requisitionId])).rows[0].reason).toBe('Not in this budget');
  });

  it('someone who cannot see the requisition gets NOT_FOUND; an unknown request or step too', async () => {
    const pr = await submitted(u.rina);
    expect(rule(await decide(u.sinta, pr.approvalRequestId, 1, 'approve'))).toBe('NOT_FOUND');
    expect(rule(await run(u.bayu, decideApproval, { approvalRequestId: '01900000-0000-7000-8000-000000000000', stepNo: 1, expectedVersion: 1, decision: 'approve' }))).toBe('NOT_FOUND');
    expect(rule(await decide(u.bayu, pr.approvalRequestId, 2, 'approve'))).toBe('NOT_FOUND');
    expect(rule(await run(u.bayu, decideApproval, { approvalRequestId: pr.approvalRequestId, stepNo: 1, expectedVersion: 1, decision: 'approve', decidedBy: u.bayu }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(await stepsOf(pr.approvalRequestId)).toEqual(['pending']);
  });

  it('the step role and scope are checked, fresh from the database: NOT_ELIGIBLE_APPROVER', async () => {
    const pr = await submitted(u.rina, large());
    // Finance can see every requisition but holds no approver role.
    expect(rule(await decide(u.sari, pr.approvalRequestId, 1, 'approve'))).toBe('NOT_ELIGIBLE_APPROVER');
    // Step 2 is still waiting for step 1.
    expect(rule(await decide(u.sari, pr.approvalRequestId, 2, 'approve'))).toBe('INVALID_TRANSITION');
    data(await decide(u.bayu, pr.approvalRequestId, 1, 'approve'));
    expect(await stepsOf(pr.approvalRequestId)).toEqual(['approved', 'pending']);
    // An approver (OPS or org-wide) is not finance.
    expect(rule(await decide(u.budi, pr.approvalRequestId, 2, 'approve'))).toBe('NOT_ELIGIBLE_APPROVER');
    expect(rule(await decide(u.oscar, pr.approvalRequestId, 2, 'approve'))).toBe('NOT_ELIGIBLE_APPROVER');

    // Vera's OPS approver assignment is revoked after her session was resolved.
    const other = await submitted(u.rina);
    const staleContext = await contextOf(t.appDb, u.vera);
    await t.pool.query("UPDATE role_assignments SET revoked_at = now(), revoked_by = $2 WHERE user_id = $1 AND role = 'approver'", [u.vera, u.ada]);
    const { version } = await requestRow(other.approvalRequestId);
    const result = await runCommand(staleContext, decideApproval, { approvalRequestId: other.approvalRequestId, stepNo: 1, expectedVersion: version, decision: 'approve' }, { db: t.appDb });
    expect(rule(result)).toBe('NOT_ELIGIBLE_APPROVER');
    expect(await stepsOf(other.approvalRequestId)).toEqual(['pending']);
  });

  it('a stale request version is CONFLICT; a decided step or completed request is INVALID_TRANSITION', async () => {
    const pr = await submitted(u.rina, large());
    expect(rule(await run(u.bayu, decideApproval, { approvalRequestId: pr.approvalRequestId, stepNo: 1, expectedVersion: 2, decision: 'approve' }))).toBe('CONFLICT');
    data(await decide(u.bayu, pr.approvalRequestId, 1, 'approve'));
    expect(rule(await run(u.budi, decideApproval, { approvalRequestId: pr.approvalRequestId, stepNo: 1, expectedVersion: 1, decision: 'approve' }))).toBe('INVALID_TRANSITION');
    expect(rule(await run(u.sari, decideApproval, { approvalRequestId: pr.approvalRequestId, stepNo: 2, expectedVersion: 1, decision: 'approve' }))).toBe('CONFLICT');
    data(await decide(u.sari, pr.approvalRequestId, 2, 'approve'));
    expect(rule(await decide(u.fajar, pr.approvalRequestId, 2, 'approve'))).toBe('INVALID_TRANSITION');
    expect(await status(pr.requisitionId)).toBe('approved');
  });
});

describe('P5b-AC4: SOD-01, no self-approval', () => {
  withStandardPolicy();

  it('a requester who is also an approver for their department cannot decide their own requisition', async () => {
    const pr = await submitted(u.riko);
    expect(await decide(u.riko, pr.approvalRequestId, 1, 'approve')).toMatchObject({ ok: false, error: { code: 'BUSINESS_RULE', rule: 'SELF_APPROVAL' } });
    expect(await decide(u.riko, pr.approvalRequestId, 1, 'reject', 'Mine')).toMatchObject({ ok: false, error: { rule: 'SELF_APPROVAL' } });
    expect((await inbox(u.riko)).items.map((i) => i.documentId)).not.toContain(pr.requisitionId);
    expect((await inbox(u.bayu)).items.map((i) => i.documentId)).toContain(pr.requisitionId);
    expect((await get(u.riko, pr.requisitionId)).openDecision).toBeNull();
    expect((await get(u.bayu, pr.requisitionId)).openDecision).toMatchObject({ approvalRequestId: pr.approvalRequestId, stepNo: 1, stepCount: 1, label: 'Approver for OPS' });
  });

  it('the database trigger rejects a self-decision written directly, as the app role and as the owner', async () => {
    const pr = await submitted(u.riko);
    for (const pool of [t.appPool, t.pool]) {
      expect(
        await sqlStateOf(() =>
          pool.query("UPDATE approval_steps SET status = 'approved', decided_by_user_id = $2, decided_at = now() WHERE approval_request_id = $1", [pr.approvalRequestId, u.riko]),
        ),
      ).toBe('PFD01');
    }
    expect(await stepsOf(pr.approvalRequestId)).toEqual(['pending']);
  });
});

describe('P5b-AC5: SOD-02, distinct approvers per round', () => {
  withStandardPolicy();

  it('one person cannot decide two steps of one round, even holding both roles', async () => {
    const pr = await submitted(u.rina, large());
    data(await decide(u.double, pr.approvalRequestId, 1, 'approve'));
    expect(await decide(u.double, pr.approvalRequestId, 2, 'approve')).toMatchObject({ ok: false, error: { code: 'BUSINESS_RULE', rule: 'DUPLICATE_APPROVER' } });
    expect((await inbox(u.double)).items.map((i) => i.approvalRequestId)).not.toContain(pr.approvalRequestId);
    expect((await inbox(u.sari)).items.map((i) => i.approvalRequestId)).toContain(pr.approvalRequestId);

    // The unique index (approval_request_id, decided_by_user_id) is the backstop.
    expect(
      await sqlStateOf(() =>
        t.appPool.query("UPDATE approval_steps SET status = 'approved', decided_by_user_id = $2, decided_at = now() WHERE approval_request_id = $1 AND step_no = 2", [
          pr.approvalRequestId,
          u.double,
        ]),
      ),
    ).toBe('23505');
    data(await decide(u.sari, pr.approvalRequestId, 2, 'approve'));
    expect(await status(pr.requisitionId)).toBe('approved');
  });
});

describe('P5b-AC6: multi-step progression, reject, return and resubmit (P5-AC7)', () => {
  it('a 3-step route approves only after step 3', async () => {
    await publish('Three steps', THREE_STEPS);
    const pr = await submitted(u.rina);
    expect(await stepsOf(pr.approvalRequestId)).toEqual(['pending', 'waiting', 'waiting']);
    expect(data(await decide(u.bayu, pr.approvalRequestId, 1, 'approve'))).toMatchObject({ requestStatus: 'pending', documentStatus: 'pending_approval', version: 2 });
    expect(await stepsOf(pr.approvalRequestId)).toEqual(['approved', 'pending', 'waiting']);
    // Step 2 needs an org-wide approver: OPS approvers cannot take it.
    expect(rule(await decide(u.budi, pr.approvalRequestId, 2, 'approve'))).toBe('NOT_ELIGIBLE_APPROVER');
    expect(data(await decide(u.oscar, pr.approvalRequestId, 2, 'approve'))).toMatchObject({ requestStatus: 'pending', documentStatus: 'pending_approval' });
    expect(await status(pr.requisitionId)).toBe('pending_approval');
    expect(data(await decide(u.sari, pr.approvalRequestId, 3, 'approve'))).toMatchObject({ requestStatus: 'approved', documentStatus: 'approved', version: 4 });
    expect((await get(u.lena, pr.requisitionId)).approvalHistory[0]?.steps.map((s) => [s.label, s.status, s.decidedBy])).toEqual([
      ['Approver for OPS', 'approved', 'Bayu Approver'],
      ['Any approver (organization-wide)', 'approved', 'Oscar Org Approver'],
      ['Finance', 'approved', 'Sari Finance'],
    ]);
  });

  it('a reject at step 2 cancels step 3 and rejects the requisition', async () => {
    const pr = await submitted(u.rina);
    data(await decide(u.bayu, pr.approvalRequestId, 1, 'approve'));
    expect(data(await decide(u.oscar, pr.approvalRequestId, 2, 'reject', 'Duplicate of an earlier request'))).toMatchObject({
      requestStatus: 'rejected',
      documentStatus: 'rejected',
    });
    expect(await stepsOf(pr.approvalRequestId)).toEqual(['approved', 'rejected', 'cancelled']);
    expect((await get(u.rina, pr.requisitionId)).callerActions).toEqual([]);
    expect(rule(await run(u.rina, cancelRequisition, { requisitionId: pr.requisitionId, expectedVersion: 3, reason: 'x' }))).toBe('INVALID_TRANSITION');
  });

  it('a return sends it back to the requester; resubmitting starts round 2 at step 1 with a new snapshot', async () => {
    const pr = await submitted(u.rina);
    data(await decide(u.bayu, pr.approvalRequestId, 1, 'approve'));
    expect(data(await decide(u.oscar, pr.approvalRequestId, 2, 'return', 'Please split the toner into its own line'))).toMatchObject({
      requestStatus: 'returned',
      documentStatus: 'returned',
    });
    expect(await stepsOf(pr.approvalRequestId)).toEqual(['approved', 'returned', 'cancelled']);
    const returned = await get(u.rina, pr.requisitionId);
    expect(returned).toMatchObject({ status: 'returned', callerCanEdit: true, callerActions: ['edit', 'submit', 'cancel'] });

    const edited = data(await run(u.rina, updateRequisitionDraft, { requisitionId: pr.requisitionId, expectedVersion: returned.version, ...small({ lines: [line(), line({ description: 'Toner' })] }) }));
    const second = data(await run(u.rina, submitRequisition, { requisitionId: pr.requisitionId, expectedVersion: edited.version }));
    expect(second).toMatchObject({ status: 'pending_approval', round: 2 });
    expect(second.approvalRequestId).not.toBe(pr.approvalRequestId);
    expect(await stepsOf(second.approvalRequestId)).toEqual(['pending', 'waiting', 'waiting']);
    expect((await requestRow(second.approvalRequestId)).amount_snapshot).toBe('60.0400');
    // SOD-02 is per round: Bayu may decide step 1 again.
    data(await decide(u.bayu, second.approvalRequestId, 1, 'approve'));

    const history = (await get(u.rina, pr.requisitionId)).approvalHistory;
    expect(history.map((r) => [r.round, r.status, r.amount])).toEqual([
      [1, 'returned', '30.02'],
      [2, 'pending', '60.04'],
    ]);
    expect(history[0]?.steps[1]).toMatchObject({ status: 'returned', decidedBy: 'Oscar Org Approver', comment: 'Please split the toner into its own line' });
  });
});

describe('P5b-AC7: a policy published after submission does not change in-flight steps (P5-AC8)', () => {
  it('the frozen route is decided as submitted, new submissions follow the new policy', async () => {
    const before = await publish('Standard again', STANDARD);
    const inFlight = await submitted(u.rina);
    const after = await publish('Finance only', FINANCE_ONLY);
    expect(await stepsOf(inFlight.approvalRequestId)).toEqual(['pending']);
    expect(rule(await decide(u.sari, inFlight.approvalRequestId, 1, 'approve'))).toBe('NOT_ELIGIBLE_APPROVER');
    data(await decide(u.bayu, inFlight.approvalRequestId, 1, 'approve'));
    expect(await status(inFlight.requisitionId)).toBe('approved');

    const fresh = await submitted(u.rina);
    expect((await get(u.rina, fresh.requisitionId)).approvalHistory[0]).toMatchObject({ policyVersionNo: after, steps: [{ label: 'Finance' }] });
    expect((await requestRow(inFlight.approvalRequestId)).policy_version_no).toBe(before);
  });
});

describe('P5b-AC8: withdraw, cancel after approval, close (PR-T08 to T10)', () => {
  withStandardPolicy();

  it('withdrawing a pending requisition needs a reason and cancels the request and its open steps', async () => {
    const pr = await submitted(u.rina, large());
    const input = { requisitionId: pr.requisitionId, expectedVersion: pr.version };
    expect(await run(u.rina, cancelRequisition, { ...input, reason: '  ' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', fieldErrors: { reason: [expect.stringContaining('withdrawing')] } },
    });
    expect(rule(await run(u.dewi, cancelRequisition, { ...input, reason: 'Not needed' }))).toBe('FORBIDDEN');
    expect(rule(await run(u.bayu, cancelRequisition, { ...input, reason: 'Not needed' }))).toBe('FORBIDDEN');
    expect(data(await run(u.rina, cancelRequisition, { ...input, reason: 'Bought it with petty cash' }))).toMatchObject({ status: 'cancelled' });
    expect(await stepsOf(pr.approvalRequestId)).toEqual(['cancelled', 'cancelled']);
    expect(await requestRow(pr.approvalRequestId)).toMatchObject({ status: 'cancelled' });
    expect((await requestRow(pr.approvalRequestId)).completed_at).not.toBeNull();
    expect(await auditActions(pr.approvalRequestId)).toEqual(['approval.requested', 'approval.cancelled']);
    expect((await get(u.rina, pr.requisitionId)).approvalHistory[0]).toMatchObject({ status: 'cancelled' });
    // The approver's open decision is gone.
    expect(rule(await run(u.bayu, decideApproval, { approvalRequestId: pr.approvalRequestId, stepNo: 1, expectedVersion: 1, decision: 'approve' }))).toBe('INVALID_TRANSITION');
    expect((await inbox(u.bayu)).items.map((i) => i.approvalRequestId)).not.toContain(pr.approvalRequestId);
  });

  it('an approved requisition can be cancelled by its requester or procurement, with a reason, if nothing was ordered', async () => {
    for (const by of [u.rina, u.dewi]) {
      const pr = await submitted(u.rina);
      data(await decide(u.bayu, pr.approvalRequestId, 1, 'approve'));
      const detail = await get(by, pr.requisitionId);
      expect(detail.callerActions).toContain('cancel');
      const input = { requisitionId: pr.requisitionId, expectedVersion: detail.version };
      expect(rule(await run(by, cancelRequisition, { ...input, reason: null }))).toBe('VALIDATION_FAILED');
      expect(rule(await run(u.lena, cancelRequisition, { ...input, reason: 'x' }))).toBe('FORBIDDEN');
      expect(data(await run(by, cancelRequisition, { ...input, reason: 'Project postponed' }))).toMatchObject({ status: 'cancelled' });
    }
  });

  it('ALREADY_ORDERED once any line is on a purchase order', async () => {
    const pr = await submitted(u.rina);
    data(await decide(u.bayu, pr.approvalRequestId, 1, 'approve'));
    // A purchase order (Phase 7) for one unit of the first line.
    const supplier = data(
      await run(u.dewi, createSupplier, {
        legalName: 'Ordered From Ltd',
        taxId: 'EX-5000-0001',
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
    data(await run(u.sari, reviewSupplier, { supplierId: supplier.supplierId, expectedVersion: 1, decision: 'approve', note: null }));
    const line = (await t.pool.query('SELECT id FROM requisition_lines WHERE requisition_id = $1 ORDER BY line_no LIMIT 1', [pr.requisitionId])).rows[0].id;
    data(
      await run(u.dewi, createPurchaseOrder, {
        requisitionId: pr.requisitionId,
        supplierId: supplier.supplierId,
        paymentTerms: null,
        deliveryAddress: null,
        expectedDeliveryDate: null,
        lines: [{ requisitionLineId: line, quantity: '1', unitPrice: '1', taxRatePct: '0' }],
      }),
    );
    const detail = await get(u.rina, pr.requisitionId);
    expect(detail.callerActions).toEqual([]);
    expect(rule(await run(u.rina, cancelRequisition, { requisitionId: pr.requisitionId, expectedVersion: detail.version, reason: 'x' }))).toBe('ALREADY_ORDERED');
    expect((await get(u.dewi, pr.requisitionId)).callerActions).toEqual(['close']);
  });

  it('procurement closes an approved requisition with a reason; nothing else can be closed', async () => {
    const pending = await submitted(u.rina);
    expect(rule(await run(u.dewi, closeRequisition, { requisitionId: pending.requisitionId, expectedVersion: pending.version, reason: 'Done' }))).toBe('INVALID_TRANSITION');
    data(await decide(u.bayu, pending.approvalRequestId, 1, 'approve'));
    const { version } = await get(u.dewi, pending.requisitionId);
    const input = { requisitionId: pending.requisitionId, expectedVersion: version };
    expect(rule(await run(u.dewi, closeRequisition, { ...input, reason: ' ' }))).toBe('VALIDATION_FAILED');
    expect(rule(await run(u.dewi, closeRequisition, input))).toBe('VALIDATION_FAILED');
    expect(rule(await run(u.dewi, closeRequisition, { ...input, expectedVersion: version + 1, reason: 'Done' }))).toBe('CONFLICT');
    expect(data(await run(u.dewi, closeRequisition, { ...input, reason: 'Bought everything we needed' }))).toMatchObject({ status: 'closed' });
    const closed = await get(u.rina, pending.requisitionId);
    expect(closed).toMatchObject({ status: 'closed', closeReason: 'Bought everything we needed', callerActions: [] });
    expect(closed.closedAt).not.toBeNull();
    expect((await t.pool.query("SELECT reason, actor_user_id FROM audit_events WHERE action = 'requisition.closed' AND entity_id = $1", [pending.requisitionId])).rows[0]).toEqual({
      reason: 'Bought everything we needed',
      actor_user_id: u.dewi,
    });
    expect(rule(await run(u.dewi, closeRequisition, { ...input, expectedVersion: version + 1, reason: 'Again' }))).toBe('INVALID_TRANSITION');
  });
});

describe('P5b-AC9: the approval inbox and history', () => {
  withStandardPolicy();

  it('lists only the steps each person can decide now, in SQL, oldest first', async () => {
    const ops = await submitted(u.rina, large());
    const sales = await submitted(u.rudi);
    const ids = async (as: string) => (await inbox(as)).items.map((i) => i.approvalRequestId);

    expect(await ids(u.bayu)).toContain(ops.approvalRequestId);
    expect(await ids(u.bayu)).not.toContain(sales.approvalRequestId);
    expect(await ids(u.sinta)).toContain(sales.approvalRequestId);
    expect(await ids(u.sinta)).not.toContain(ops.approvalRequestId);
    // An org-wide approver may take department steps anywhere.
    expect(await ids(u.oscar)).toEqual(expect.arrayContaining([ops.approvalRequestId, sales.approvalRequestId]));
    // Finance steps are not open yet.
    expect(await ids(u.sari)).not.toContain(ops.approvalRequestId);

    data(await decide(u.bayu, ops.approvalRequestId, 1, 'approve'));
    expect(await ids(u.bayu)).not.toContain(ops.approvalRequestId);
    expect(await ids(u.budi)).not.toContain(ops.approvalRequestId);
    const [item] = (await inbox(u.sari)).items.filter((i) => i.approvalRequestId === ops.approvalRequestId);
    expect(item).toMatchObject({
      documentType: 'requisition',
      documentId: ops.requisitionId,
      documentNumber: ops.number,
      documentTitle: 'Docking stations',
      departmentCode: 'OPS',
      amount: '1200.00',
      currencyCode: 'USD',
      round: 1,
      stepNo: 2,
      stepCount: 2,
      label: 'Finance',
      submittedBy: 'Rina Requester',
      requestVersion: 2,
    });
    expect(Object.keys(item ?? {}).sort()).toEqual([...INBOX_ITEM_KEYS].sort());

    const all = (await inbox(u.oscar)).items;
    expect(all.map((i) => i.waitingSince)).toEqual([...all.map((i) => i.waitingSince)].sort());
    const one = await inbox(u.oscar, 1);
    expect(one.items).toHaveLength(1);
    expect(one.more).toBe(all.length > 1);
    expect(rule(await run(u.oscar, approvalInbox, { limit: 101 }))).toBe('VALIDATION_FAILED');
    expect(rule(await run(u.oscar, approvalInbox, { userId: u.bayu }))).toBe('VALIDATION_FAILED');
  });

  it('history is part of the requisition, for everyone who can see it, with names and no ids', async () => {
    const pr = await submitted(u.rina, large());
    data(await decide(u.bayu, pr.approvalRequestId, 1, 'approve', 'Fine for OPS'));
    for (const as of [u.rina, u.bayu, u.sari, u.dewi, u.lena]) {
      const detail = await get(as, pr.requisitionId);
      expect(detail.approvalHistory[0]?.steps.map((s) => [s.status, s.decidedBy, s.comment])).toEqual([
        ['approved', 'Bayu Approver', 'Fine for OPS'],
        ['pending', null, null],
      ]);
    }
    expect(rule(await run(u.rudi, getRequisition, { requisitionId: pr.requisitionId }))).toBe('NOT_FOUND');
    expect(rule(await run(u.sinta, getRequisition, { requisitionId: pr.requisitionId }))).toBe('NOT_FOUND');

    const detail = await get(u.sari, pr.requisitionId);
    expect(Object.keys(detail).sort()).toEqual([...REQUISITION_DETAIL_KEYS].sort());
    expect(Object.keys(detail.approvalHistory[0] ?? {}).sort()).toEqual([...APPROVAL_ROUND_KEYS].sort());
    expect(Object.keys(detail.approvalHistory[0]?.steps[0] ?? {}).sort()).toEqual([...APPROVAL_STEP_KEYS].sort());
    expect(Object.keys(detail.openDecision ?? {}).sort()).toEqual([...OPEN_DECISION_KEYS].sort());
    expect(JSON.stringify(detail)).not.toContain(u.bayu);
    expect(JSON.stringify(detail)).not.toContain(u.rina);
    expect((await get(u.lena, pr.requisitionId)).openDecision).toBeNull();
    expect((await get(u.lena, pr.requisitionId)).callerActions).toEqual([]);
  });
});

describe('P5b-AC12: database backstops for approval history', () => {
  withStandardPolicy();

  it('requests keep their snapshot, change only while pending, and are never deleted', async () => {
    const pr = await submitted(u.rina);
    const id = pr.approvalRequestId;
    for (const pool of [t.appPool, t.pool]) {
      for (const statement of [
        'UPDATE approval_requests SET amount_snapshot = 1 WHERE id = $1',
        'UPDATE approval_requests SET submitted_by_user_id = (SELECT user_id FROM user_profiles LIMIT 1 OFFSET 3) WHERE id = $1',
        "UPDATE approval_requests SET document_title = 'Other' WHERE id = $1",
        'UPDATE approval_requests SET round = 9 WHERE id = $1',
      ]) {
        expect(await sqlStateOf(() => pool.query(statement, [id]))).toBe('PFD01');
      }
    }
    expect(await sqlStateOf(() => t.appPool.query('DELETE FROM approval_requests WHERE id = $1', [id]))).toBe('42501');
    expect(await sqlStateOf(() => t.appPool.query('DELETE FROM approval_steps WHERE approval_request_id = $1', [id]))).toBe('42501');
    expect(await sqlStateOf(() => t.pool.query('DELETE FROM approval_steps WHERE approval_request_id = $1', [id]))).toBe('PFD01');

    // AP-I1: a second pending request for the same document.
    const row = await requestRow(id);
    expect(
      await sqlStateOf(() =>
        t.appPool.query(
          `INSERT INTO approval_requests (document_type, document_id, round, document_number, document_title, amount_snapshot, currency_code, currency_scale, department_id, policy_id, policy_version_no, submitted_by_user_id)
           VALUES ('requisition', $1, 2, $2, 'x', 1, 'USD', 2, $3, $4, 1, $5)`,
          [row.document_id, row.document_number, row.department_id, row.policy_id, u.rina],
        ),
      ),
    ).toBe('23505');

    data(await decide(u.bayu, id, 1, 'approve'));
    expect(await sqlStateOf(() => t.appPool.query("UPDATE approval_requests SET status = 'pending', completed_at = NULL WHERE id = $1", [id]))).toBe('PFD01');
    expect(await sqlStateOf(() => t.pool.query('UPDATE approval_requests SET version = version + 1 WHERE id = $1', [id]))).toBe('PFD01');
  });

  it('steps keep their route, only move forward, and cannot be added later', async () => {
    const pr = await submitted(u.rina, large());
    const id = pr.approvalRequestId;
    for (const statement of [
      "UPDATE approval_steps SET required_role = 'approver' WHERE approval_request_id = $1 AND step_no = 2",
      'UPDATE approval_steps SET scope_department_id = NULL WHERE approval_request_id = $1 AND step_no = 1',
      "UPDATE approval_steps SET status = 'approved', decided_by_user_id = (SELECT id FROM users WHERE email = 'sari@example.com'), decided_at = now() WHERE approval_request_id = $1 AND step_no = 2",
      `INSERT INTO approval_steps (approval_request_id, step_no, required_role, status) VALUES ($1, 3, 'finance', 'waiting')`,
    ]) {
      expect(await sqlStateOf(() => t.appPool.query(statement, [id]))).toBe('PFD01');
    }
    // A reject without a comment violates the CHECK even when written directly.
    expect(
      await sqlStateOf(() =>
        t.appPool.query("UPDATE approval_steps SET status = 'rejected', decided_by_user_id = $2, decided_at = now() WHERE approval_request_id = $1 AND step_no = 1", [id, u.bayu]),
      ),
    ).toBe('23514');
    data(await decide(u.bayu, id, 1, 'approve'));
    expect(await sqlStateOf(() => t.appPool.query("UPDATE approval_steps SET status = 'pending' WHERE approval_request_id = $1 AND step_no = 1", [id]))).toBe('PFD01');
    expect(await sqlStateOf(() => t.appPool.query("UPDATE approval_steps SET activated_at = now() - interval '1 day' WHERE approval_request_id = $1 AND step_no = 2", [id]))).toBe(
      'PFD01',
    );
    expect(await stepsOf(id)).toEqual(['approved', 'pending']);
  });

  it('requisitions keep the approval columns consistent with their status (CHECKs)', async () => {
    const draft = await create(u.rina);
    expect(await sqlStateOf(() => t.appPool.query("UPDATE purchase_requisitions SET status = 'approved' WHERE id = $1", [draft.requisitionId]))).toBe('23514');
    expect(await sqlStateOf(() => t.appPool.query("UPDATE purchase_requisitions SET status = 'pending_approval' WHERE id = $1", [draft.requisitionId]))).toBe('23514');
    const pr = await submitted(u.rina);
    data(await decide(u.bayu, pr.approvalRequestId, 1, 'approve'));
    expect(await sqlStateOf(() => t.appPool.query("UPDATE purchase_requisitions SET status = 'closed' WHERE id = $1", [pr.requisitionId]))).toBe('23514');
  });
});
