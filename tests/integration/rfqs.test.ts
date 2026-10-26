import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publishApprovalPolicy } from '@/modules/organization';
import { cancelRequisition, createRequisition, submitRequisition } from '@/modules/requisitions';
import {
  INVITED_SUPPLIER_KEYS,
  RFQ_DETAIL_KEYS,
  RFQ_LINE_KEYS,
  RFQ_SUMMARY_KEYS,
  SOURCING_LINE_OPTION_KEYS,
  SOURCING_OPTIONS_KEYS,
  cancelRfq,
  closeRfq,
  createRfq,
  getRfq,
  issueRfq,
  listRfqs,
  rfqSourcingOptions,
  updateRfqDraft,
} from '@/modules/sourcing';
import { blockSupplier, createSupplier, reviewSupplier } from '@/modules/suppliers';
import { decideApproval } from '@/server/approvals';
import { fixedClock, type Clock } from '@/shared/clock';
import { runCommand, runQuery, type Operation } from '@/shared/application/runner';
import type { Result } from '@/shared/result';
import { contextOf, provisionActor } from '../support/actors';
import { createTestDatabase, sqlStateOf, type TestDatabase } from '../support/test-db';

/* Phase 6a: the RFQ lifecycle, as the runtime role through the command runner. */

let t: TestDatabase;
type Persona = 'rina' | 'bayu' | 'dewi' | 'fajar' | 'sari' | 'lena' | 'ada' | 'agus';
const u = {} as Record<Persona, string>;
const s = {} as Record<'office' | 'parts' | 'cleaning' | 'pending', string>;

beforeAll(async () => {
  t = await createTestDatabase();
  await t.pool.query("INSERT INTO departments (code, name) VALUES ('OPS', 'Operations')");
  u.rina = await provisionActor(t.appDb, 'rina@example.com', 'Rina Requester', ['requester'], { departmentCode: 'OPS' });
  u.bayu = await provisionActor(t.appDb, 'bayu@example.com', 'Bayu Approver', [{ role: 'approver', departmentCode: 'OPS' }], { departmentCode: 'OPS' });
  u.dewi = await provisionActor(t.appDb, 'dewi@example.com', 'Dewi Procurement', ['procurement']);
  u.fajar = await provisionActor(t.appDb, 'fajar@example.com', 'Fajar Procurement', ['procurement']);
  u.sari = await provisionActor(t.appDb, 'sari@example.com', 'Sari Finance', ['finance']);
  u.lena = await provisionActor(t.appDb, 'lena@example.com', 'Lena Auditor', ['auditor']);
  u.ada = await provisionActor(t.appDb, 'ada@example.com', 'Ada Admin', ['admin']);
  u.agus = await provisionActor(t.appDb, 'agus@example.com', 'Agus Receiver', ['receiver']);

  const supplier = async (legalName: string, taxId: string, approve: boolean) => {
    const created = data(
      await run(u.dewi, createSupplier, {
        legalName,
        taxId,
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
    if (approve) data(await run(u.sari, reviewSupplier, { supplierId: created.supplierId, expectedVersion: 1, decision: 'approve', note: null }));
    return created.supplierId;
  };
  s.office = await supplier('Example Office Supplies Ltd', 'EX-1000-0001', true);
  s.parts = await supplier('Sample Industrial Parts Co', 'EX-1000-0002', true);
  s.cleaning = await supplier('Demo Cleaning Services', 'EX-1000-0003', true);
  s.pending = await supplier('Pending Review Trading', 'EX-1000-0004', false);

  data(
    await run(u.ada, publishApprovalPolicy, {
      documentType: 'requisition',
      name: 'One step',
      rules: [{ departmentCode: null, minAmount: '0', maxAmount: null, steps: [{ role: 'approver', scopeMode: 'document_department' }] }],
    }),
  );
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

const rule = (result: Result<unknown>) => (result.ok ? 'ok' : (result.error.rule ?? result.error.code));

const LINES = [
  { description: 'A4 paper', quantity: '20', uom: 'ream', estimatedUnitPrice: '4.25' },
  { description: 'Toner cartridge', quantity: '2', uom: 'pcs', estimatedUnitPrice: '89.90' },
  { description: 'Stapler', quantity: '5', uom: 'pcs', estimatedUnitPrice: '7.5' },
];

/** A requisition in the given state, with its line ids in line order. */
async function requisition(state: 'draft' | 'pending' | 'approved' = 'approved') {
  const created = data(await run(u.rina, createRequisition, { title: 'Office supplies', justification: null, neededBy: '2030-06-30', lines: LINES }));
  const lineIds = (await t.pool.query('SELECT id FROM requisition_lines WHERE requisition_id = $1 ORDER BY line_no', [created.requisitionId])).rows.map((r) => r.id as string);
  if (state === 'draft') return { requisitionId: created.requisitionId, number: created.number, lineIds };
  const submitted = data(await run(u.rina, submitRequisition, { requisitionId: created.requisitionId, expectedVersion: 1 }));
  if (state === 'approved') {
    data(await run(u.bayu, decideApproval, { approvalRequestId: submitted.approvalRequestId, stepNo: 1, expectedVersion: 1, decision: 'approve' }));
  }
  return { requisitionId: created.requisitionId, number: created.number, lineIds };
}

const draftInput = (requisitionId: string, lineIds: string[], overrides: Record<string, unknown> = {}) => ({
  requisitionId,
  title: 'Office supplies for Q1',
  responseDueAt: '2030-03-15T17:00',
  lines: [
    { requisitionLineId: lineIds[0], quantity: '20' },
    { requisitionLineId: lineIds[1], quantity: '1.5' },
  ],
  supplierIds: [s.office, s.parts],
  ...overrides,
});

async function createDraft(overrides: Record<string, unknown> = {}) {
  const pr = await requisition();
  const created = data(await run(u.dewi, createRfq, draftInput(pr.requisitionId, pr.lineIds, overrides)));
  return { requisitionId: pr.requisitionId, requisitionNumber: pr.number, lineIds: pr.lineIds, ...created };
}

const get = async (as: string, rfqId: string) => data(await run(as, getRfq, { rfqId }));
const auditOf = async (entityId: string) =>
  (await t.pool.query('SELECT action, actor_user_id AS actor, changes, reason FROM audit_events WHERE entity_id = $1 ORDER BY id', [entityId])).rows;
const rfqCount = async () => (await t.pool.query('SELECT count(*)::int AS n FROM rfqs')).rows[0].n as number;

describe('P6a-AC2: creating an RFQ (RFQ-T01)', () => {
  it('copies descriptions and units from the requisition, numbers it, invites suppliers, and audits it', async () => {
    const pr = await requisition();
    const created = data(await run(u.dewi, createRfq, draftInput(pr.requisitionId, pr.lineIds)));
    expect(created).toMatchObject({ version: 1 });
    expect(created.number).toMatch(new RegExp(`^RFQ-${new Date().getUTCFullYear()}-\\d{6}$`));

    const detail = await get(u.dewi, created.rfqId);
    expect(detail).toMatchObject({
      number: created.number,
      title: 'Office supplies for Q1',
      status: 'draft',
      requisitionId: pr.requisitionId,
      requisitionNumber: pr.number,
      requisitionStatus: 'approved',
      responseDueAt: '2030-03-15T17:00:00.000Z',
      createdBy: 'Dewi Procurement',
      issuedAt: null,
      callerActions: ['edit', 'issue', 'cancel'],
    });
    expect(detail.lines).toEqual([
      { id: expect.any(String), lineNo: 1, requisitionLineNo: 1, description: 'A4 paper', quantity: '20', uom: 'ream' },
      { id: expect.any(String), lineNo: 2, requisitionLineNo: 2, description: 'Toner cartridge', quantity: '1.5', uom: 'pcs' },
    ]);
    expect(detail.suppliers.map((x) => [x.code, x.legalName, x.status])).toEqual(
      expect.arrayContaining([
        [expect.stringMatching(/^SUP-/), 'Example Office Supplies Ltd', 'active'],
        [expect.stringMatching(/^SUP-/), 'Sample Industrial Parts Co', 'active'],
      ]),
    );
    expect((await auditOf(created.rfqId))[0]).toMatchObject({
      action: 'rfq.created',
      actor: u.dewi,
      changes: {
        number: [null, created.number],
        requisitionNumber: [null, pr.number],
        responseDueAt: [null, '2030-03-15T17:00:00.000Z'],
        lines: [null, ['1. 20 ream A4 paper (requisition line 1)', '2. 1.5 pcs Toner cartridge (requisition line 2)']],
        status: [null, 'draft'],
      },
    });

    const options = data(await run(u.fajar, rfqSourcingOptions, { requisitionId: pr.requisitionId }));
    expect(options.lines.map((l) => [l.lineNo, l.remainingQty, l.onRfq])).toEqual([
      [1, '20', created.number],
      [2, '2', created.number],
      [3, '5', null],
    ]);
    expect(options.suppliers.map((x) => x.legalName)).toEqual(['Demo Cleaning Services', 'Example Office Supplies Ltd', 'Sample Industrial Parts Co']);
    expect(Object.keys(options).sort()).toEqual([...SOURCING_OPTIONS_KEYS].sort());
    expect(Object.keys(options.lines[0] ?? {}).sort()).toEqual([...SOURCING_LINE_OPTION_KEYS].sort());

    const next = data(await run(u.dewi, createRfq, draftInput(pr.requisitionId, [pr.lineIds[2] as string], { lines: [{ requisitionLineId: pr.lineIds[2], quantity: '5' }] })));
    expect(Number(next.number.slice(-6))).toBe(Number(created.number.slice(-6)) + 1);
  });

  it('reads the due time in the organization time zone', async () => {
    await t.pool.query("UPDATE org_settings SET timezone = 'Asia/Jakarta'");
    try {
      const jakarta = await createDraft();
      expect((await get(u.dewi, jakarta.rfqId)).responseDueAt).toBe('2030-03-15T10:00:00.000Z');
      await t.pool.query("UPDATE org_settings SET timezone = 'America/New_York'");
      const pr = await requisition();
      // 02:30 on 10 March 2030 does not exist in New York (clocks jump from 02:00 to 03:00).
      expect(await run(u.dewi, createRfq, draftInput(pr.requisitionId, pr.lineIds, { responseDueAt: '2030-03-10T02:30' }))).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_FAILED', fieldErrors: { responseDueAt: [expect.stringContaining('America/New_York')] } },
      });
    } finally {
      await t.pool.query("UPDATE org_settings SET timezone = 'UTC'");
    }
  });

  it('needs an approved requisition', async () => {
    for (const state of ['draft', 'pending'] as const) {
      const pr = await requisition(state);
      expect(rule(await run(u.dewi, createRfq, draftInput(pr.requisitionId, pr.lineIds)))).toBe('REQUISITION_NOT_APPROVED');
    }
    expect(rule(await run(u.dewi, createRfq, draftInput(randomUUID(), [randomUUID(), randomUUID()])))).toBe('NOT_FOUND');
  });

  it('asks for no more than what is left to order, and only lines of that requisition, once each', async () => {
    const pr = await requisition();
    const before = await rfqCount();
    const tooMuch = await run(u.dewi, createRfq, draftInput(pr.requisitionId, pr.lineIds, { lines: [{ requisitionLineId: pr.lineIds[1], quantity: '2.001' }] }));
    expect(tooMuch).toMatchObject({ ok: false, error: { rule: 'QUANTITY_EXCEEDS_REMAINING', details: [{ lineNo: 2, remaining: '2' }] } });
    // Purchase orders (Phase 7) will raise ordered_qty; set it directly here.
    await t.pool.query('UPDATE requisition_lines SET ordered_qty = 15 WHERE id = $1', [pr.lineIds[0]]);
    expect(rule(await run(u.dewi, createRfq, draftInput(pr.requisitionId, pr.lineIds, { lines: [{ requisitionLineId: pr.lineIds[0], quantity: '6' }] })))).toBe(
      'QUANTITY_EXCEEDS_REMAINING',
    );

    const other = await requisition();
    expect(await run(u.dewi, createRfq, draftInput(pr.requisitionId, pr.lineIds, { lines: [{ requisitionLineId: other.lineIds[0], quantity: '1' }] }))).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', fieldErrors: { 'lines.0.requisitionLineId': [expect.stringContaining(pr.number)] } },
    });
    const twice = draftInput(pr.requisitionId, pr.lineIds, {
      lines: [
        { requisitionLineId: pr.lineIds[2], quantity: '1' },
        { requisitionLineId: pr.lineIds[2], quantity: '2' },
      ],
    });
    expect(await run(u.dewi, createRfq, twice)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', fieldErrors: { 'lines.1.requisitionLineId': ['This line is listed twice'] } } });
    for (const quantity of ['0', '-1', '1.0001', '1e2', 2]) {
      expect(rule(await run(u.dewi, createRfq, draftInput(pr.requisitionId, pr.lineIds, { lines: [{ requisitionLineId: pr.lineIds[2], quantity }] })))).toBe('VALIDATION_FAILED');
    }
    expect(await rfqCount()).toBe(before);
  });

  it('a requisition line can be on only one RFQ that is not cancelled: LINE_ALREADY_IN_RFQ', async () => {
    const first = await createDraft();
    const overlap = await run(u.fajar, createRfq, draftInput(first.requisitionId, first.lineIds, { lines: [{ requisitionLineId: first.lineIds[1], quantity: '0.5' }] }));
    expect(overlap).toMatchObject({ ok: false, error: { rule: 'LINE_ALREADY_IN_RFQ', message: expect.stringContaining(first.number) } });
    expect(
      rule(await run(u.fajar, createRfq, draftInput(first.requisitionId, first.lineIds, { lines: [{ requisitionLineId: first.lineIds[2], quantity: '5' }] }))),
    ).toBe('ok');
  });

  it('invites only active suppliers, each once; an RFQ may start without any', async () => {
    const pr = await requisition();
    const input = (supplierIds: string[]) => draftInput(pr.requisitionId, pr.lineIds, { supplierIds });
    expect(await run(u.dewi, createRfq, input([s.office, s.pending]))).toMatchObject({
      ok: false,
      error: { rule: 'SUPPLIER_NOT_ACTIVE', message: expect.stringContaining('Pending Review Trading') },
    });
    expect(rule(await run(u.dewi, createRfq, input([randomUUID()])))).toBe('SUPPLIER_NOT_ACTIVE');
    expect(await run(u.dewi, createRfq, input([s.office, s.office]))).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', fieldErrors: { supplierIds: ['A supplier is listed twice'] } } });
    const empty = data(await run(u.dewi, createRfq, input([])));
    expect((await get(u.dewi, empty.rfqId)).suppliers).toEqual([]);
  });

  it('refuses server fields sent by the client, and replays an idempotency key', async () => {
    const pr = await requisition();
    const before = await rfqCount();
    for (const extra of [
      { status: 'issued' },
      { number: 'RFQ-2030-000001' },
      { createdByUserId: u.fajar },
      { issuedAt: '2030-01-01T00:00:00Z' },
      { lines: [{ requisitionLineId: pr.lineIds[0], quantity: '1', description: 'Gold bars' }] },
      { lines: [{ requisitionLineId: pr.lineIds[0], quantity: '1', uom: 'kg' }] },
      { responseDueAt: '2030-03-15T17:00:00Z' },
      { responseDueAt: '2030-02-30T10:00' },
    ]) {
      const result = await run(u.dewi, createRfq, draftInput(pr.requisitionId, pr.lineIds, extra));
      expect({ extra, result: rule(result) }).toEqual({ extra, result: 'VALIDATION_FAILED' });
    }
    expect(await rfqCount()).toBe(before);

    const key = `rfq-${randomUUID()}`;
    const first = data(await run(u.dewi, createRfq, { ...draftInput(pr.requisitionId, pr.lineIds), idempotencyKey: key }));
    const again = data(await run(u.dewi, createRfq, { ...draftInput(pr.requisitionId, pr.lineIds), idempotencyKey: key }));
    expect(again).toEqual(first);
    expect(await rfqCount()).toBe(before + 1);
    expect(rule(await run(u.dewi, createRfq, { ...draftInput(pr.requisitionId, pr.lineIds, { title: 'Other' }), idempotencyKey: key }))).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('P6a-AC3: editing a draft RFQ (RFQ-T02)', () => {
  it('replaces title, due time, lines, and invitations; kept invitations keep their time; audited', async () => {
    const rfq = await createDraft();
    const before = await get(u.dewi, rfq.rfqId);
    const officeInvited = before.suppliers.find((x) => x.id === s.office)?.invitedAt;
    const input = {
      rfqId: rfq.rfqId,
      expectedVersion: 1,
      title: 'Office supplies, revised',
      responseDueAt: '2030-03-20T12:00',
      lines: [{ requisitionLineId: rfq.lineIds[2], quantity: '5' }, { requisitionLineId: rfq.lineIds[0], quantity: '10' }],
      supplierIds: [s.cleaning, s.office],
    };
    expect(data(await run(u.fajar, updateRfqDraft, input))).toEqual({ version: 2 });
    const after = await get(u.dewi, rfq.rfqId);
    expect(after).toMatchObject({ title: 'Office supplies, revised', responseDueAt: '2030-03-20T12:00:00.000Z', version: 2 });
    expect(after.lines.map((l) => [l.lineNo, l.requisitionLineNo, l.quantity])).toEqual([
      [1, 3, '5'],
      [2, 1, '10'],
    ]);
    expect(after.suppliers.map((x) => x.id).sort()).toEqual([s.cleaning, s.office].sort());
    expect(after.suppliers.find((x) => x.id === s.office)?.invitedAt).toBe(officeInvited);
    const updated = (await auditOf(rfq.rfqId)).find((e) => e.action === 'rfq.updated');
    expect(updated).toMatchObject({ actor: u.fajar });
    expect(Object.keys(updated.changes).sort()).toEqual(['lines', 'responseDueAt', 'suppliers', 'title']);

    // The same values, invitations in another order: nothing is written.
    const auditCount = (await auditOf(rfq.rfqId)).length;
    expect(data(await run(u.dewi, updateRfqDraft, { ...input, expectedVersion: 2, supplierIds: [s.office, s.cleaning] }))).toEqual({ version: 2 });
    expect((await auditOf(rfq.rfqId)).length).toBe(auditCount);
    expect(rule(await run(u.dewi, updateRfqDraft, { ...input, expectedVersion: 1, title: 'Stale' }))).toBe('CONFLICT');
    // Its own lines are not "on another RFQ".
    expect(rule(await run(u.dewi, updateRfqDraft, { ...input, expectedVersion: 2, lines: [{ requisitionLineId: rfq.lineIds[2], quantity: '4' }] }))).toBe('ok');
  });

  it('applies the same rules as create, and only to drafts', async () => {
    const rfq = await createDraft();
    const base = { rfqId: rfq.rfqId, expectedVersion: 1, title: 'x', responseDueAt: '2030-03-15T17:00', lines: [{ requisitionLineId: rfq.lineIds[0], quantity: '21' }], supplierIds: [s.office] };
    expect(rule(await run(u.dewi, updateRfqDraft, base))).toBe('QUANTITY_EXCEEDS_REMAINING');
    expect(rule(await run(u.dewi, updateRfqDraft, { ...base, lines: [{ requisitionLineId: rfq.lineIds[0], quantity: '1' }], supplierIds: [s.pending] }))).toBe('SUPPLIER_NOT_ACTIVE');
    expect(rule(await run(u.dewi, updateRfqDraft, { ...base, rfqId: randomUUID() }))).toBe('NOT_FOUND');
    expect(rule(await run(u.dewi, updateRfqDraft, { ...base, status: 'draft' }))).toBe('VALIDATION_FAILED');
    data(await run(u.dewi, issueRfq, { rfqId: rfq.rfqId, expectedVersion: 1 }));
    expect(rule(await run(u.dewi, updateRfqDraft, { ...base, expectedVersion: 2, lines: [{ requisitionLineId: rfq.lineIds[0], quantity: '1' }] }))).toBe('INVALID_TRANSITION');
  });
});

describe('P6a-AC4: issuing (RFQ-T03)', () => {
  it('needs an invited supplier, a due time in the future, active suppliers, and a requisition still approved', async () => {
    const noSuppliers = await createDraft({ supplierIds: [] });
    expect(rule(await run(u.dewi, issueRfq, { rfqId: noSuppliers.rfqId, expectedVersion: 1 }))).toBe('NO_SUPPLIERS_INVITED');

    const late = await createDraft({ responseDueAt: '2030-03-15T17:00' });
    expect(rule(await run(u.dewi, issueRfq, { rfqId: late.rfqId, expectedVersion: 1 }, fixedClock('2030-03-15T17:00:00Z')))).toBe('RESPONSE_DUE_IN_PAST');
    expect(rule(await run(u.dewi, issueRfq, { rfqId: late.rfqId, expectedVersion: 1 }, fixedClock('2030-03-15T16:59:00Z')))).toBe('ok');

    const blocked = await createDraft({ supplierIds: [s.cleaning] });
    const cleaning = (await t.pool.query('SELECT version FROM suppliers WHERE id = $1', [s.cleaning])).rows[0].version;
    data(await run(u.sari, blockSupplier, { supplierId: s.cleaning, expectedVersion: cleaning, reason: 'Late deliveries' }));
    expect(await run(u.dewi, issueRfq, { rfqId: blocked.rfqId, expectedVersion: 1 })).toMatchObject({
      ok: false,
      error: { rule: 'SUPPLIER_NOT_ACTIVE', message: expect.stringContaining('Demo Cleaning Services') },
    });

    const withdrawn = await createDraft();
    const prVersion = (await t.pool.query('SELECT version FROM purchase_requisitions WHERE id = $1', [withdrawn.requisitionId])).rows[0].version;
    data(await run(u.rina, cancelRequisition, { requisitionId: withdrawn.requisitionId, expectedVersion: prVersion, reason: 'No longer needed' }));
    expect(rule(await run(u.dewi, issueRfq, { rfqId: withdrawn.rfqId, expectedVersion: 1 }))).toBe('REQUISITION_NOT_APPROVED');
    expect((await get(u.dewi, withdrawn.rfqId)).requisitionStatus).toBe('cancelled');
  });

  it('records who issued it, freezes lines and invitations, and audits it', async () => {
    const rfq = await createDraft();
    expect(data(await run(u.fajar, issueRfq, { rfqId: rfq.rfqId, expectedVersion: 1 }))).toEqual({ version: 2, status: 'issued' });
    const detail = await get(u.lena, rfq.rfqId);
    expect(detail).toMatchObject({ status: 'issued', issuedBy: 'Fajar Procurement', callerActions: [] });
    expect(detail.issuedAt).not.toBeNull();
    // Phase 6b: quotations are recorded while it is issued.
    expect((await get(u.dewi, rfq.rfqId)).callerActions).toEqual(['close', 'cancel', 'record']);
    expect((await auditOf(rfq.rfqId)).map((e) => [e.action, e.changes.status])).toEqual([
      ['rfq.created', [null, 'draft']],
      ['rfq.issued', ['draft', 'issued']],
    ]);
    expect(rule(await run(u.dewi, issueRfq, { rfqId: rfq.rfqId, expectedVersion: 2 }))).toBe('INVALID_TRANSITION');

    const line = (await t.pool.query('SELECT id FROM rfq_lines WHERE rfq_id = $1 ORDER BY line_no LIMIT 1', [rfq.rfqId])).rows[0].id;
    for (const pool of [t.appPool, t.pool]) {
      for (const [statement, params] of [
        ['UPDATE rfq_lines SET quantity = 1 WHERE id = $1', [line]],
        ['DELETE FROM rfq_lines WHERE id = $1', [line]],
        ['INSERT INTO rfq_lines (rfq_id, line_no, requisition_line_id, description, quantity, uom) VALUES ($1, 9, $2, $3, 1, $4)', [rfq.rfqId, rfq.lineIds[2], 'Stapler', 'pcs']],
        ['DELETE FROM rfq_suppliers WHERE rfq_id = $1', [rfq.rfqId]],
        ['INSERT INTO rfq_suppliers (rfq_id, supplier_id, invited_by_user_id) VALUES ($1, $2, $3)', [rfq.rfqId, s.cleaning, u.dewi]],
        ["UPDATE rfqs SET title = 'Swapped' WHERE id = $1", [rfq.rfqId]],
        ["UPDATE rfqs SET response_due_at = now() + interval '1 year' WHERE id = $1", [rfq.rfqId]],
      ] as const) {
        expect({ statement, state: await sqlStateOf(() => pool.query(statement, [...params])) }).toEqual({ statement, state: 'PFB01' });
      }
    }
  });
});

describe('P6a-AC5: closing and cancelling (RFQ-T04, T06)', () => {
  it('closes an issued RFQ only', async () => {
    const rfq = await createDraft();
    expect(rule(await run(u.dewi, closeRfq, { rfqId: rfq.rfqId, expectedVersion: 1 }))).toBe('INVALID_TRANSITION');
    data(await run(u.dewi, issueRfq, { rfqId: rfq.rfqId, expectedVersion: 1 }));
    expect(rule(await run(u.dewi, closeRfq, { rfqId: rfq.rfqId, expectedVersion: 1 }))).toBe('CONFLICT');
    expect(data(await run(u.dewi, closeRfq, { rfqId: rfq.rfqId, expectedVersion: 2 }))).toEqual({ version: 3, status: 'closed' });
    expect(await get(u.sari, rfq.rfqId)).toMatchObject({ status: 'closed', closedBy: 'Dewi Procurement' });
    // Phase 6b: a closed RFQ is awarded.
    expect((await get(u.dewi, rfq.rfqId)).callerActions).toEqual(['cancel', 'award']);
    expect(rule(await run(u.dewi, closeRfq, { rfqId: rfq.rfqId, expectedVersion: 3 }))).toBe('INVALID_TRANSITION');
  });

  it('cancels a draft, issued, or closed RFQ with a reason, which frees its requisition lines', async () => {
    for (const steps of [[], ['issue'], ['issue', 'close']] as const) {
      const rfq = await createDraft();
      let version = 1;
      for (const step of steps) version = data(await run(u.dewi, step === 'issue' ? issueRfq : closeRfq, { rfqId: rfq.rfqId, expectedVersion: version })).version;
      for (const reason of [undefined, '', '   ', 'x'.repeat(501)]) {
        expect(rule(await run(u.dewi, cancelRfq, { rfqId: rfq.rfqId, expectedVersion: version, ...(reason === undefined ? {} : { reason }) }))).toBe('VALIDATION_FAILED');
      }
      expect(data(await run(u.dewi, cancelRfq, { rfqId: rfq.rfqId, expectedVersion: version, reason: '  Budget moved  ' }))).toMatchObject({ status: 'cancelled' });
      const detail = await get(u.lena, rfq.rfqId);
      expect(detail).toMatchObject({ status: 'cancelled', cancelReason: 'Budget moved', cancelledBy: 'Dewi Procurement' });
      expect((await auditOf(rfq.rfqId)).at(-1)).toMatchObject({ action: 'rfq.cancelled', reason: 'Budget moved', changes: { status: [steps.length === 0 ? 'draft' : steps.length === 1 ? 'issued' : 'closed', 'cancelled'] } });
      expect(rule(await run(u.dewi, cancelRfq, { rfqId: rfq.rfqId, expectedVersion: version + 1, reason: 'Again' }))).toBe('INVALID_TRANSITION');
      // The same requisition lines can go on a new RFQ now.
      expect(rule(await run(u.fajar, createRfq, draftInput(rfq.requisitionId, rfq.lineIds)))).toBe('ok');
    }
  });
});

describe('P6a-AC6: who can see and change RFQs', () => {
  it('procurement, finance, and the auditor read every RFQ, with filters, paging, and allowlisted fields', async () => {
    const a = await createDraft({ title: 'Paging 100% literal' });
    const b = await createDraft({ title: 'Paging plain' });
    for (const as of [u.dewi, u.sari, u.lena]) {
      const all = data(await run(as, listRfqs, { q: 'Paging' }));
      expect(all.items.map((i) => i.id)).toEqual([b.rfqId, a.rfqId]);
      expect(Object.keys(all.items[0] ?? {}).sort()).toEqual([...RFQ_SUMMARY_KEYS].sort());
    }
    expect(data(await run(u.lena, listRfqs, { q: '100%' })).items.map((i) => i.id)).toEqual([a.rfqId]);
    expect(data(await run(u.lena, listRfqs, { q: '_' })).items).toEqual([]);
    expect(data(await run(u.lena, listRfqs, { requisitionId: a.requisitionId })).items.map((i) => [i.id, i.requisitionNumber, i.lineCount, i.supplierCount])).toEqual([
      [a.rfqId, a.requisitionNumber, 2, 2],
    ]);
    const page = data(await run(u.sari, listRfqs, { q: 'Paging', limit: 1 }));
    expect(page.items.map((i) => i.id)).toEqual([b.rfqId]);
    expect(data(await run(u.sari, listRfqs, { q: 'Paging', limit: 1, cursor: page.nextCursor })).items.map((i) => i.id)).toEqual([a.rfqId]);
    expect(data(await run(u.sari, listRfqs, { status: 'issued', q: 'Paging' })).items).toEqual([]);
    for (const bad of [{ status: 'open' }, { cursor: "'; drop table rfqs; --" }, { limit: 101 }, { createdByUserId: u.dewi }]) {
      expect(rule(await run(u.sari, listRfqs, bad))).toBe('VALIDATION_FAILED');
    }

    const detail = await get(u.sari, a.rfqId);
    expect(Object.keys(detail).sort()).toEqual([...RFQ_DETAIL_KEYS].sort());
    expect(Object.keys(detail.lines[0] ?? {}).sort()).toEqual([...RFQ_LINE_KEYS].sort());
    expect(Object.keys(detail.suppliers[0] ?? {}).sort()).toEqual([...INVITED_SUPPLIER_KEYS].sort());
    expect(JSON.stringify(detail)).not.toContain(u.dewi);
    expect(detail.callerActions).toEqual([]);
    expect(rule(await run(u.sari, getRfq, { rfqId: randomUUID() }))).toBe('NOT_FOUND');
  });

  it('only procurement changes RFQs or sees the form options', async () => {
    const rfq = await createDraft();
    for (const as of [u.rina, u.bayu, u.sari, u.lena, u.ada, u.agus]) {
      expect(rule(await run(as, createRfq, draftInput(rfq.requisitionId, [rfq.lineIds[2] as string], { lines: [{ requisitionLineId: rfq.lineIds[2], quantity: '1' }] })))).toBe('FORBIDDEN');
      expect(rule(await run(as, issueRfq, { rfqId: rfq.rfqId, expectedVersion: 1 }))).toBe('FORBIDDEN');
      expect(rule(await run(as, rfqSourcingOptions, { requisitionId: rfq.requisitionId }))).toBe('FORBIDDEN');
    }
    for (const as of [u.rina, u.bayu, u.ada, u.agus]) expect(rule(await run(as, getRfq, { rfqId: rfq.rfqId }))).toBe('FORBIDDEN');
    expect(rule(await run(u.dewi, rfqSourcingOptions, { requisitionId: randomUUID() }))).toBe('NOT_FOUND');
  });
});

describe('P6a-AC7: database backstops', () => {
  it('RFQs start as drafts of approved requisitions, keep their identity, follow the machine, and are never deleted', async () => {
    const rfq = await createDraft();
    const draftPr = await requisition('draft');
    const insert = (status: string, requisitionId: string) =>
      t.appPool.query(
        `INSERT INTO rfqs (number, requisition_id, title, status, response_due_at, created_by_user_id, issued_at, issued_by_user_id)
         VALUES ('RFQ-2099-999999', $1, 'Direct', $2, now() + interval '1 day', $3, CASE WHEN $2 = 'issued' THEN now() END, CASE WHEN $2 = 'issued' THEN $3::uuid END)`,
        [requisitionId, status, u.dewi],
      );
    expect(await sqlStateOf(() => insert('issued', rfq.requisitionId))).toBe('PFB01');
    expect(await sqlStateOf(() => insert('draft', draftPr.requisitionId))).toBe('PFB01');
    for (const pool of [t.appPool, t.pool]) {
      for (const statement of [
        "UPDATE rfqs SET number = 'RFQ-2099-000001' WHERE id = $1",
        'UPDATE rfqs SET requisition_id = (SELECT id FROM purchase_requisitions LIMIT 1 OFFSET 1) WHERE id = $1',
        'UPDATE rfqs SET created_by_user_id = (SELECT id FROM users WHERE email = $$fajar@example.com$$) WHERE id = $1',
        "UPDATE rfqs SET status = 'closed', closed_at = now(), closed_by_user_id = created_by_user_id WHERE id = $1",
        "UPDATE rfqs SET status = 'awarded' WHERE id = $1",
      ]) {
        expect({ statement, state: await sqlStateOf(() => pool.query(statement, [rfq.rfqId])) }).toEqual({ statement, state: 'PFB01' });
      }
    }
    expect(await sqlStateOf(() => t.appPool.query('DELETE FROM rfqs WHERE id = $1', [rfq.rfqId]))).toBe('42501');
    expect(await sqlStateOf(() => t.pool.query('DELETE FROM rfqs WHERE id = $1', [rfq.rfqId]))).toBe('PFB01');
    expect(await sqlStateOf(() => t.appPool.query("UPDATE rfqs SET status = 'issued' WHERE id = $1", [rfq.rfqId]))).toBe('23514');
    // Issuing directly is refused once the requisition is no longer approved.
    const orphan = await createDraft();
    const prVersion = (await t.pool.query('SELECT version FROM purchase_requisitions WHERE id = $1', [orphan.requisitionId])).rows[0].version;
    data(await run(u.rina, cancelRequisition, { requisitionId: orphan.requisitionId, expectedVersion: prVersion, reason: 'Not needed' }));
    expect(
      await sqlStateOf(() =>
        t.appPool.query("UPDATE rfqs SET status = 'issued', issued_at = now(), issued_by_user_id = created_by_user_id WHERE id = $1", [orphan.rfqId]),
      ),
    ).toBe('PFB01');
    data(await run(u.dewi, cancelRfq, { rfqId: rfq.rfqId, expectedVersion: 1, reason: 'Test' }));
    expect(await sqlStateOf(() => t.pool.query("UPDATE rfqs SET status = 'draft', cancelled_at = NULL, cancelled_by_user_id = NULL, cancel_reason = NULL WHERE id = $1", [rfq.rfqId]))).toBe('PFB01');
  });

  it('draft lines come from the RFQ\'s requisition as written, within what is left, on no other live RFQ; only active suppliers are invited', async () => {
    const rfq = await createDraft();
    const other = await requisition();
    const add = (requisitionLineId: string, description: string, quantity: string, uom: string) =>
      t.appPool.query('INSERT INTO rfq_lines (rfq_id, line_no, requisition_line_id, description, quantity, uom) VALUES ($1, 9, $2, $3, $4, $5)', [
        rfq.rfqId,
        requisitionLineId,
        description,
        quantity,
        uom,
      ]);
    expect(await sqlStateOf(() => add(other.lineIds[2] as string, 'Stapler', '1', 'pcs'))).toBe('PFB01');
    expect(await sqlStateOf(() => add(rfq.lineIds[2] as string, 'Gold stapler', '1', 'pcs'))).toBe('PFB01');
    expect(await sqlStateOf(() => add(rfq.lineIds[2] as string, 'Stapler', '1', 'box'))).toBe('PFB01');
    expect(await sqlStateOf(() => add(rfq.lineIds[2] as string, 'Stapler', '5.001', 'pcs'))).toBe('PFB01');
    expect(await sqlStateOf(() => add(rfq.lineIds[2] as string, 'Stapler', '0', 'pcs'))).toBe('23514');
    expect(await sqlStateOf(() => add(rfq.lineIds[2] as string, 'Stapler', '5', 'pcs'))).toBe('none');

    const second = data(await run(u.fajar, createRfq, draftInput(other.requisitionId, other.lineIds, { lines: [{ requisitionLineId: other.lineIds[0], quantity: '1' }] })));
    expect(
      await sqlStateOf(() =>
        t.appPool.query("INSERT INTO rfq_lines (rfq_id, line_no, requisition_line_id, description, quantity, uom) VALUES ($1, 2, $2, 'A4 paper', 1, 'ream')", [
          second.rfqId,
          other.lineIds[0],
        ]),
      ),
    ).toBe('23505');
    const third = data(await run(u.fajar, createRfq, draftInput(other.requisitionId, other.lineIds, { lines: [{ requisitionLineId: other.lineIds[1], quantity: '1' }] })));
    expect(
      await sqlStateOf(() =>
        t.appPool.query("INSERT INTO rfq_lines (rfq_id, line_no, requisition_line_id, description, quantity, uom) VALUES ($1, 2, $2, 'A4 paper', 1, 'ream')", [
          third.rfqId,
          other.lineIds[0],
        ]),
      ),
    ).toBe('PFB01');
    expect(await sqlStateOf(() => t.appPool.query('INSERT INTO rfq_suppliers (rfq_id, supplier_id, invited_by_user_id) VALUES ($1, $2, $3)', [rfq.rfqId, s.pending, u.dewi]))).toBe('PFB01');
    expect(await sqlStateOf(() => t.appPool.query('UPDATE rfq_suppliers SET invited_at = now() WHERE rfq_id = $1', [rfq.rfqId]))).toBe('42501');
  });
});
