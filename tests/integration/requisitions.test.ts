import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  REQUISITION_DETAIL_KEYS,
  REQUISITION_LINE_KEYS,
  REQUISITION_SUMMARY_KEYS,
  cancelRequisition,
  createRequisition,
  getRequisition,
  listRequisitions,
  updateRequisitionDraft,
} from '@/modules/requisitions';
import { runCommand, runQuery, type Operation } from '@/shared/application/runner';
import type { Result } from '@/shared/result';
import { contextOf, provisionActor } from '../support/actors';
import { createTestDatabase, sqlStateOf, type TestDatabase } from '../support/test-db';

/* Phase 5a: drafting requisitions, as the runtime role through the command runner. */

let t: TestDatabase;
type Persona = 'rina' | 'rudi' | 'fina' | 'riko' | 'bayu' | 'oscar' | 'dewi' | 'sari' | 'lena' | 'ada' | 'agus' | 'nodept';
const u = {} as Record<Persona, string>;

beforeAll(async () => {
  t = await createTestDatabase();
  await t.pool.query("INSERT INTO departments (code, name) VALUES ('OPS', 'Operations'), ('FIN', 'Finance')");
  u.rina = await provisionActor(t.appDb, 'rina@example.com', 'Rina Requester', ['requester'], { departmentCode: 'OPS' });
  u.rudi = await provisionActor(t.appDb, 'rudi@example.com', 'Rudi Requester', ['requester'], { departmentCode: 'OPS' });
  u.fina = await provisionActor(t.appDb, 'fina@example.com', 'Fina Requester', ['requester'], { departmentCode: 'FIN' });
  u.riko = await provisionActor(t.appDb, 'riko@example.com', 'Riko Both', ['requester', { role: 'approver', departmentCode: 'OPS' }], { departmentCode: 'OPS' });
  u.bayu = await provisionActor(t.appDb, 'bayu@example.com', 'Bayu Approver', [{ role: 'approver', departmentCode: 'OPS' }], { departmentCode: 'OPS' });
  u.oscar = await provisionActor(t.appDb, 'oscar@example.com', 'Oscar Approver', ['approver']);
  u.dewi = await provisionActor(t.appDb, 'dewi@example.com', 'Dewi Procurement', ['procurement']);
  u.sari = await provisionActor(t.appDb, 'sari@example.com', 'Sari Finance', ['finance']);
  u.lena = await provisionActor(t.appDb, 'lena@example.com', 'Lena Auditor', ['auditor']);
  u.ada = await provisionActor(t.appDb, 'ada@example.com', 'Ada Admin', ['admin']);
  u.agus = await provisionActor(t.appDb, 'agus@example.com', 'Agus Receiver', ['receiver']);
  u.nodept = await provisionActor(t.appDb, 'nodept@example.com', 'No Department', ['requester']);
});

afterAll(async () => {
  await t?.drop();
});

async function run<I, O>(as: string, op: Operation<I, O>, input: unknown): Promise<Result<O>> {
  const context = await contextOf(t.appDb, as);
  return op.kind === 'command' ? runCommand(context, op, input, { db: t.appDb }) : runQuery(context, op, input, { db: t.appDb });
}

function data<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.data;
}

const line = (overrides: Record<string, unknown> = {}) => ({ description: 'A4 paper', quantity: '3', uom: 'ream', estimatedUnitPrice: '10.005', ...overrides });
const draft = (overrides: Record<string, unknown> = {}) => ({
  title: 'Office supplies',
  justification: 'Monthly restock',
  neededBy: '2030-06-30',
  lines: [line(), line({ description: 'Pens', quantity: '0.5', uom: 'box', estimatedUnitPrice: '2.3333' })],
  ...overrides,
});

async function create(as: string, overrides: Record<string, unknown> = {}) {
  return data(await run(as, createRequisition, draft(overrides)));
}

const auditOf = async (entityId: string) =>
  (await t.pool.query('SELECT action, actor_user_id AS actor, changes, reason FROM audit_events WHERE entity_id = $1 ORDER BY id', [entityId])).rows;
const count = async () => (await t.pool.query('SELECT count(*)::int AS n FROM purchase_requisitions')).rows[0].n as number;

describe('P5a-AC5: creating a requisition', () => {
  it('computes totals on the server at the currency scale, numbers it, and takes the department from the profile', async () => {
    const created = await create(u.rina);
    // 3 × 10.005 = 30.015 → 30.02; 0.5 × 2.3333 = 1.16665 → 1.17 (half-up); total 31.19.
    expect(created.estimatedTotal).toBe('31.19');
    expect(created.number).toMatch(new RegExp(`^PR-${new Date().getUTCFullYear()}-\\d{6}$`));
    const detail = data(await run(u.rina, getRequisition, { requisitionId: created.requisitionId }));
    expect(detail).toMatchObject({ status: 'draft', departmentCode: 'OPS', departmentName: 'Operations', requester: 'Rina Requester', currencyCode: 'USD', estimatedTotal: '31.19', callerCanEdit: true });
    expect(detail.lines.map((l) => [l.quantity, l.estimatedUnitPrice, l.lineTotal, l.orderedQty, l.remainingQty])).toEqual([
      ['3', '10.005', '30.02', '0', '3'],
      ['0.5', '2.3333', '1.17', '0', '0.5'],
    ]);
    expect((await auditOf(created.requisitionId))[0]).toMatchObject({
      action: 'requisition.created',
      actor: u.rina,
      changes: {
        number: [null, created.number],
        departmentCode: [null, 'OPS'],
        estimatedTotal: [null, '31.19'],
        lines: [null, ['1. 3 ream A4 paper @ 10.005', '2. 0.5 box Pens @ 2.3333']],
        status: [null, 'draft'],
      },
    });
    const next = await create(u.rina);
    expect(Number(next.number.slice(-6))).toBe(Number(created.number.slice(-6)) + 1);
  });

  it('rejects totals, statuses, departments, and other server fields sent by the client', async () => {
    const before = await count();
    for (const input of [
      draft({ estimatedTotal: '1.00' }),
      draft({ lines: [line({ lineTotal: '0.01' })] }),
      draft({ status: 'approved' }),
      draft({ departmentId: randomUUID() }),
      draft({ departmentCode: 'FIN' }),
      draft({ currencyCode: 'EUR' }),
      draft({ number: 'PR-2026-999999' }),
      draft({ requesterUserId: u.rudi }),
      draft({ lines: [line({ orderedQty: '1' })] }),
    ]) {
      expect(await run(u.rina, createRequisition, input)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    }
    expect(await count()).toBe(before);
  });

  it('validates quantities, prices, dates, and line counts as strings, never floats', async () => {
    const before = await count();
    for (const input of [
      draft({ lines: [line({ quantity: '0' })] }),
      draft({ lines: [line({ quantity: '-1' })] }),
      draft({ lines: [line({ quantity: '1.2345' })] }),
      draft({ lines: [line({ quantity: 3 })] }),
      draft({ lines: [line({ estimatedUnitPrice: '1.23456' })] }),
      draft({ lines: [line({ estimatedUnitPrice: 10 })] }),
      draft({ lines: [line({ uom: '' })] }),
      draft({ lines: [] }),
      draft({ lines: Array.from({ length: 201 }, () => line()) }),
      draft({ neededBy: '2026-02-30' }),
      draft({ neededBy: '30/06/2030' }),
      draft({ title: '   ' }),
    ]) {
      expect(await run(u.rina, createRequisition, input)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    }
    const big = await run(u.rina, createRequisition, draft({ lines: [line({ quantity: '999999999', estimatedUnitPrice: '999999999999.9999' })] }));
    expect(big).toMatchObject({ ok: false, error: { code: 'BUSINESS_RULE', rule: 'AMOUNT_TOO_LARGE' } });
    expect(await count()).toBe(before);
    // 200 lines is fine.
    expect((await create(u.rina, { lines: Array.from({ length: 200 }, () => line({ estimatedUnitPrice: '1' })) })).estimatedTotal).toBe('600.00');
  });

  it('needs a department on the profile and the requester role', async () => {
    expect(await run(u.nodept, createRequisition, draft())).toMatchObject({ ok: false, error: { code: 'BUSINESS_RULE', rule: 'NO_DEPARTMENT' } });
    for (const who of [u.dewi, u.bayu, u.ada]) {
      expect(await run(who, createRequisition, draft())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    }
  });
});

describe('P5a-AC5: editing a draft', () => {
  it('replaces header and lines, recomputes the total, checks the version, and audits the change', async () => {
    const { requisitionId } = await create(u.rina);
    const edit = { requisitionId, expectedVersion: 1, ...draft({ title: 'Office supplies (Q3)', lines: [line({ quantity: '4' })] }) };
    expect(data(await run(u.rina, updateRequisitionDraft, edit))).toEqual({ version: 2, estimatedTotal: '40.02' });
    expect((await auditOf(requisitionId)).at(-1)).toMatchObject({
      action: 'requisition.updated',
      changes: {
        title: ['Office supplies', 'Office supplies (Q3)'],
        estimatedTotal: ['31.19', '40.02'],
        lines: [['1. 3 ream A4 paper @ 10.005', '2. 0.5 box Pens @ 2.3333'], ['1. 4 ream A4 paper @ 10.005']],
      },
    });
    expect(await run(u.rina, updateRequisitionDraft, edit)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    // A no-op (same values, different spelling of the same numbers) writes nothing.
    const events = (await auditOf(requisitionId)).length;
    const same = { ...edit, expectedVersion: 2, lines: [line({ quantity: '4.000', estimatedUnitPrice: '10.0050' })] };
    expect(data(await run(u.rina, updateRequisitionDraft, same))).toEqual({ version: 2, estimatedTotal: '40.02' });
    expect((await auditOf(requisitionId)).length).toBe(events);
    expect(await run(u.rina, updateRequisitionDraft, { ...edit, expectedVersion: 2, estimatedTotal: '1' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    });
  });

  it('only the requester edits: others who can see it get FORBIDDEN, others get NOT_FOUND', async () => {
    const { requisitionId } = await create(u.rina);
    const edit = { requisitionId, expectedVersion: 1, ...draft({ title: 'Hijacked' }) };
    expect(await run(u.riko, updateRequisitionDraft, edit)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } }); // sees OPS as approver
    expect(await run(u.rudi, updateRequisitionDraft, edit)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } }); // own only
    expect(await run(u.fina, updateRequisitionDraft, edit)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await run(u.rina, updateRequisitionDraft, { ...edit, requisitionId: randomUUID() })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(data(await run(u.rina, getRequisition, { requisitionId })).title).toBe('Office supplies');
  });
});

describe('P5a-AC6: idempotent create', () => {
  it('a repeated key returns the first result; the same key with other input is refused', async () => {
    const key = `key-${randomUUID()}`;
    const first = data(await run(u.rina, createRequisition, { ...draft(), idempotencyKey: key }));
    const before = await count();
    expect(data(await run(u.rina, createRequisition, { ...draft(), idempotencyKey: key }))).toEqual(first);
    expect(await count()).toBe(before);
    expect(await run(u.rina, createRequisition, { ...draft({ title: 'Different' }), idempotencyKey: key })).toMatchObject({
      ok: false,
      error: { code: 'BUSINESS_RULE', rule: 'IDEMPOTENCY_KEY_REUSED' },
    });
    // Keys belong to a user: someone else's identical key is a new request.
    expect(data(await run(u.rudi, createRequisition, { ...draft(), idempotencyKey: key })).requisitionId).not.toBe(first.requisitionId);
    expect(await run(u.rina, createRequisition, { ...draft(), idempotencyKey: 'short' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
  });
});

describe('P5a-AC7: who sees which requisitions', () => {
  let rinaPr: string;
  let rudiPr: string;
  let finaPr: string;

  beforeAll(async () => {
    rinaPr = (await create(u.rina, { title: 'Visibility Rina' })).requisitionId;
    rudiPr = (await create(u.rudi, { title: 'Visibility Rudi' })).requisitionId;
    finaPr = (await create(u.fina, { title: 'Visibility Fina' })).requisitionId;
  });

  async function visibleTo(who: string): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = data(await run(who, listRequisitions, cursor ? { q: 'Visibility', limit: 2, cursor } : { q: 'Visibility', limit: 2 }));
      ids.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return ids.sort();
  }

  it('requesters see their own; department approvers their departments; org-wide roles everything', async () => {
    expect(await visibleTo(u.rina)).toEqual([rinaPr].sort());
    expect(await visibleTo(u.rudi)).toEqual([rudiPr].sort());
    expect(await visibleTo(u.bayu)).toEqual([rinaPr, rudiPr].sort());
    expect(await visibleTo(u.riko)).toEqual([rinaPr, rudiPr].sort());
    for (const who of [u.oscar, u.dewi, u.sari, u.lena]) expect(await visibleTo(who)).toEqual([rinaPr, rudiPr, finaPr].sort());
  });

  it("someone else's requisition by id is NOT_FOUND; roles without any read permission get FORBIDDEN", async () => {
    expect(await run(u.rina, getRequisition, { requisitionId: finaPr })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await run(u.rina, getRequisition, { requisitionId: rudiPr })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await run(u.bayu, getRequisition, { requisitionId: finaPr })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(data(await run(u.bayu, getRequisition, { requisitionId: rinaPr })).callerCanEdit).toBe(false);
    expect(data(await run(u.lena, getRequisition, { requisitionId: finaPr })).title).toBe('Visibility Fina');
    for (const who of [u.ada, u.agus]) {
      expect(await run(who, listRequisitions, {})).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
      expect(await run(who, getRequisition, { requisitionId: rinaPr })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    }
  });

  it('filters by status, department, and text, literally, and validates its input', async () => {
    const ops = data(await run(u.lena, listRequisitions, { departmentCode: 'OPS', q: 'Visibility', limit: 100 })).items;
    expect(ops.map((i) => i.id).sort()).toEqual([rinaPr, rudiPr].sort());
    expect(data(await run(u.lena, listRequisitions, { departmentCode: 'NOPE' })).items).toEqual([]);
    expect(data(await run(u.lena, listRequisitions, { status: 'approved' })).items).toEqual([]);
    for (const q of ['%', '_', "'; drop table purchase_requisitions; --"]) {
      expect(data(await run(u.lena, listRequisitions, { q, limit: 100 })).items).toEqual([]);
    }
    for (const input of [{ cursor: 'PR-1' }, { status: 'open' }, { limit: 101 }, { departmentCode: 'ops' }, { requesterUserId: u.rina }]) {
      expect(await run(u.lena, listRequisitions, input)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    }
  });

  it('returns allowlisted fields with names, not user ids', async () => {
    const page = data(await run(u.lena, listRequisitions, { limit: 5 }));
    for (const item of page.items) expect(Object.keys(item).sort()).toEqual([...REQUISITION_SUMMARY_KEYS].sort());
    const detail = data(await run(u.lena, getRequisition, { requisitionId: rinaPr }));
    expect(Object.keys(detail).sort()).toEqual([...REQUISITION_DETAIL_KEYS].sort());
    for (const l of detail.lines) expect(Object.keys(l).sort()).toEqual([...REQUISITION_LINE_KEYS].sort());
    const serialized = JSON.stringify([page, detail]);
    for (const id of Object.values(u)) expect(serialized).not.toContain(id);
  });
});

describe('P5a-AC8: cancelling a draft', () => {
  it('cancels with an optional reason, once, and freezes the requisition', async () => {
    const { requisitionId } = await create(u.rina);
    expect(await run(u.lena, cancelRequisition, { requisitionId, expectedVersion: 1, reason: null })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(data(await run(u.rina, cancelRequisition, { requisitionId, expectedVersion: 1, reason: 'Ordered elsewhere' }))).toEqual({ version: 2, status: 'cancelled' });
    expect((await auditOf(requisitionId)).at(-1)).toMatchObject({ action: 'requisition.cancelled', reason: 'Ordered elsewhere', changes: { status: ['draft', 'cancelled'] } });
    expect(data(await run(u.rina, getRequisition, { requisitionId }))).toMatchObject({ status: 'cancelled', cancelReason: 'Ordered elsewhere', callerCanEdit: false });
    expect(await run(u.rina, cancelRequisition, { requisitionId, expectedVersion: 2, reason: null })).toMatchObject({ ok: false, error: { code: 'INVALID_TRANSITION' } });
    expect(await run(u.rina, updateRequisitionDraft, { requisitionId, expectedVersion: 2, ...draft() })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_TRANSITION' },
    });
    const second = await create(u.rina);
    expect(data(await run(u.rina, cancelRequisition, { requisitionId: second.requisitionId, expectedVersion: 1, reason: '' })).status).toBe('cancelled');
  });

  it('the database keeps lines frozen outside drafts and the identity columns fixed', async () => {
    const { requisitionId } = await create(u.rina);
    data(await run(u.rina, cancelRequisition, { requisitionId, expectedVersion: 1, reason: null }));
    const lineId = (await t.pool.query('SELECT id FROM requisition_lines WHERE requisition_id = $1 LIMIT 1', [requisitionId])).rows[0].id as string;
    for (const pool of [t.appPool, t.pool]) {
      expect(await sqlStateOf(() => pool.query("UPDATE requisition_lines SET description = 'Swapped' WHERE id = $1", [lineId]))).toBe('PFQ01');
      expect(await sqlStateOf(() => pool.query('DELETE FROM requisition_lines WHERE id = $1', [lineId]))).toBe('PFQ01');
      expect(
        await sqlStateOf(() =>
          pool.query("INSERT INTO requisition_lines (requisition_id, line_no, description, quantity, uom, estimated_unit_price, line_total) VALUES ($1, 99, 'x', 1, 'pcs', 1, 1)", [requisitionId]),
        ),
      ).toBe('PFQ01');
      for (const statement of [
        "UPDATE purchase_requisitions SET number = 'PR-2026-999999' WHERE id = $1",
        'UPDATE purchase_requisitions SET requester_user_id = (SELECT id FROM users WHERE email = $2) WHERE id = $1',
        "UPDATE purchase_requisitions SET currency_code = 'EUR' WHERE id = $1",
        'UPDATE purchase_requisitions SET department_id = (SELECT id FROM departments WHERE code = $2) WHERE id = $1',
      ]) {
        const params = statement.includes('$2') ? [requisitionId, statement.includes('users') ? 'fina@example.com' : 'FIN'] : [requisitionId];
        expect(await sqlStateOf(() => pool.query(statement, params))).toBe('PFQ01');
      }
    }
    expect(await sqlStateOf(() => t.appPool.query('DELETE FROM purchase_requisitions WHERE id = $1', [requisitionId]))).toBe('42501');
    // PR-I1: never more ordered than requested.
    expect(await sqlStateOf(() => t.pool.query('UPDATE requisition_lines SET ordered_qty = quantity + 1 WHERE id = $1', [lineId]))).toBe('23514');
  });
});
