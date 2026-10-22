import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SELECTABLE_SUPPLIER_KEYS,
  SUPPLIER_DETAIL_KEYS,
  SUPPLIER_SUMMARY_KEYS,
  blockSupplier,
  createSupplier,
  deactivateSupplier,
  getSupplier,
  listSuppliers,
  reactivateSupplier,
  reviewSupplier,
  selectableForPurchasing,
  unblockSupplier,
  updateSupplierDetails,
} from '@/modules/suppliers';
import { runCommand, runQuery, type Operation } from '@/shared/application/runner';
import type { Result } from '@/shared/result';
import { contextOf, provisionActor } from '../support/actors';
import { createTestDatabase, sqlStateOf, type TestDatabase } from '../support/test-db';

/*
 * Phase 4: supplier commands and queries through the command runner, as the runtime role.
 */

let t: TestDatabase;
let dewi: string; // procurement (maker)
let sari: string; // finance (checker)
let fajar: string; // procurement + finance (the maker-checker trap)
let lena: string; // auditor (read-only)
let rina: string; // requester (no supplier access)

beforeAll(async () => {
  t = await createTestDatabase();
  dewi = await provisionActor(t.appDb, 'dewi@example.com', 'Dewi Procurement', ['procurement']);
  sari = await provisionActor(t.appDb, 'sari@example.com', 'Sari Finance', ['finance']);
  fajar = await provisionActor(t.appDb, 'fajar@example.com', 'Fajar Both', ['procurement', 'finance']);
  lena = await provisionActor(t.appDb, 'lena@example.com', 'Lena Auditor', ['auditor']);
  rina = await provisionActor(t.appDb, 'rina@example.com', 'Rina Requester', ['requester']);
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

let seq = 0;
const unique = (): number => ++seq;

type Fields = {
  legalName: string;
  taxId: string | null;
  email: string | null;
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  countryCode: string;
};

function fields(overrides: Partial<Fields> = {}): Fields {
  const n = unique();
  return {
    legalName: `Example Supplies ${n} Ltd`,
    taxId: `TX-${String(n).padStart(6, '0')}`,
    email: `sales${n}@example.com`,
    phone: '+1 555 0100',
    addressLine1: '1 Example Street',
    addressLine2: null,
    city: 'Springfield',
    region: null,
    postalCode: '00000',
    countryCode: 'US',
    ...overrides,
  };
}

type Row = { status: string; version: number; reviewed_by: string | null; identity_changed_by: string | null; status_reason: string | null };
async function row(id: string): Promise<Row> {
  const { rows } = await t.pool.query(
    `SELECT status, version, reviewed_by_user_id::text AS reviewed_by, identity_changed_by_user_id::text AS identity_changed_by,
       status_reason FROM suppliers WHERE id = $1`,
    [id],
  );
  return rows[0] as Row;
}

async function create(overrides: Partial<Fields> = {}, as = dewi): Promise<{ supplierId: string; code: string; fields: Fields }> {
  const f = fields(overrides);
  return { ...data(await run(as, createSupplier, f)), fields: f };
}

async function approved(overrides: Partial<Fields> = {}): Promise<{ supplierId: string; code: string; fields: Fields }> {
  const created = await create(overrides);
  data(await run(sari, reviewSupplier, { supplierId: created.supplierId, expectedVersion: 1, decision: 'approve', note: null }));
  return created;
}

type AuditRow = { action: string; actor: string | null; changes: Record<string, unknown>; reason: string | null };
async function auditOf(entityId: string): Promise<AuditRow[]> {
  const { rows } = await t.pool.query('SELECT action, actor_user_id AS actor, changes, reason FROM audit_events WHERE entity_id = $1 ORDER BY id', [
    entityId,
  ]);
  return rows as AuditRow[];
}

const count = async (): Promise<number> => (await t.pool.query('SELECT count(*)::int AS n FROM suppliers')).rows[0].n as number;

describe('SUP-T01: creating a supplier', () => {
  it('starts in pending_review with a gapless code, audited', async () => {
    const before = await count();
    const { supplierId, code, fields: f } = await create();
    expect(code).toMatch(/^SUP-\d{6}$/);
    expect(await row(supplierId)).toMatchObject({ status: 'pending_review', version: 1, reviewed_by: null });
    expect(await auditOf(supplierId)).toEqual([
      expect.objectContaining({
        action: 'supplier.created',
        actor: dewi,
        changes: expect.objectContaining({ code: [null, code], legalName: [null, f.legalName], status: [null, 'pending_review'] }),
      }),
    ]);
    const next = await create();
    expect(Number(next.code.slice(4))).toBe(Number(code.slice(4)) + 1);
    expect(await count()).toBe(before + 2);
  });
});

describe('P4-AC2: maker-checker (SOD-03)', () => {
  it('the creator cannot review, even holding finance; someone else can', async () => {
    const { supplierId } = await create({}, fajar);
    for (const decision of ['approve', 'reject'] as const) {
      expect(await run(fajar, reviewSupplier, { supplierId, expectedVersion: 1, decision, note: 'mine' })).toMatchObject({
        ok: false,
        error: { code: 'BUSINESS_RULE', rule: 'MAKER_CHECKER' },
      });
    }
    expect(data(await run(fajar, getSupplier, { supplierId })).callerIsMaker).toBe(true);
    expect(data(await run(sari, getSupplier, { supplierId })).callerIsMaker).toBe(false);

    data(await run(sari, reviewSupplier, { supplierId, expectedVersion: 1, decision: 'approve', note: 'Checked the registration' }));
    expect(await row(supplierId)).toMatchObject({ status: 'active', reviewed_by: sari });
    expect((await auditOf(supplierId)).at(-1)).toMatchObject({
      action: 'supplier.reviewed',
      actor: sari,
      reason: 'Checked the registration',
      changes: { status: ['pending_review', 'active'] },
    });
  });

  it('the last identity changer cannot review either', async () => {
    const { supplierId, fields: f } = await approved();
    data(await run(fajar, updateSupplierDetails, { supplierId, expectedVersion: 2, ...f, legalName: `${f.legalName} Renamed` }));
    expect(await row(supplierId)).toMatchObject({ status: 'pending_review', identity_changed_by: fajar, reviewed_by: null });
    expect(await run(fajar, reviewSupplier, { supplierId, expectedVersion: 3, decision: 'approve', note: null })).toMatchObject({
      ok: false,
      error: { rule: 'MAKER_CHECKER' },
    });
    // Dewi created it, so she cannot review it either (she lacks the permission anyway).
    expect(await run(dewi, reviewSupplier, { supplierId, expectedVersion: 3, decision: 'approve', note: null })).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    data(await run(sari, reviewSupplier, { supplierId, expectedVersion: 3, decision: 'approve', note: null }));
  });

  it('is backed by CHECKs and a trigger the runtime role cannot get around', async () => {
    const { supplierId } = await create();
    const selfReview = t.appPool.query(
      "UPDATE suppliers SET status = 'active', reviewed_by_user_id = created_by_user_id, reviewed_at = now() WHERE id = $1",
      [supplierId],
    );
    await expect(selfReview).rejects.toMatchObject({ code: '23514' });
    const unreviewedActive = t.appPool.query("UPDATE suppliers SET status = 'active' WHERE id = $1", [supplierId]);
    await expect(unreviewedActive).rejects.toMatchObject({ code: '23514' });
    expect(await sqlStateOf(() => t.appPool.query('UPDATE suppliers SET created_by_user_id = $2 WHERE id = $1', [supplierId, sari]))).toBe('PFS01');
    expect(await sqlStateOf(() => t.appPool.query("UPDATE suppliers SET code = 'SUP-999999' WHERE id = $1", [supplierId]))).toBe('PFS01');
    expect(await sqlStateOf(() => t.appPool.query('DELETE FROM suppliers WHERE id = $1', [supplierId]))).toBe('42501');
  });
});

describe('P4-AC3: identity changes send an active supplier back to review', () => {
  it('contact edits keep the status and the review; name or tax ID edits clear the review', async () => {
    const { supplierId, fields: f } = await approved();
    const contact = data(await run(dewi, updateSupplierDetails, { supplierId, expectedVersion: 2, ...f, email: 'new@example.com', city: 'Shelbyville' }));
    expect(contact).toEqual({ version: 3, status: 'active' });
    expect(await row(supplierId)).toMatchObject({ status: 'active', reviewed_by: sari, identity_changed_by: null });

    const renamed = data(await run(dewi, updateSupplierDetails, { supplierId, expectedVersion: 3, ...f, email: 'new@example.com', city: 'Shelbyville', legalName: f.legalName.toUpperCase() }));
    expect(renamed).toEqual({ version: 4, status: 'pending_review' });
    expect(await row(supplierId)).toMatchObject({ status: 'pending_review', reviewed_by: null, identity_changed_by: dewi });
    expect((await auditOf(supplierId)).at(-1)).toMatchObject({
      action: 'supplier.updated',
      changes: { legalName: [f.legalName, f.legalName.toUpperCase()], status: ['active', 'pending_review'] },
    });

    data(await run(sari, reviewSupplier, { supplierId, expectedVersion: 4, decision: 'approve', note: null }));
    data(await run(dewi, updateSupplierDetails, { supplierId, expectedVersion: 5, ...f, email: 'new@example.com', city: 'Shelbyville', legalName: f.legalName.toUpperCase(), taxId: 'TX-NEW-0001' }));
    expect(await row(supplierId)).toMatchObject({ status: 'pending_review', reviewed_by: null });
  });

  it('a blocked supplier keeps its block on an identity edit, and needs a fresh review after unblocking', async () => {
    const { supplierId, fields: f } = await approved();
    data(await run(dewi, blockSupplier, { supplierId, expectedVersion: 2, reason: 'Quality complaints' }));
    data(await run(dewi, updateSupplierDetails, { supplierId, expectedVersion: 3, ...f, legalName: `${f.legalName} Group` }));
    expect(await row(supplierId)).toMatchObject({ status: 'blocked', reviewed_by: null, identity_changed_by: dewi });
    data(await run(sari, unblockSupplier, { supplierId, expectedVersion: 4, reason: 'Complaints resolved' }));
    expect(await row(supplierId)).toMatchObject({ status: 'pending_review' });
  });

  it('a no-op edit writes nothing; an inactive supplier cannot be edited', async () => {
    const { supplierId, fields: f } = await create();
    const events = (await auditOf(supplierId)).length;
    expect(data(await run(dewi, updateSupplierDetails, { supplierId, expectedVersion: 1, ...f }))).toEqual({ version: 1, status: 'pending_review' });
    expect((await auditOf(supplierId)).length).toBe(events);
    data(await run(sari, reviewSupplier, { supplierId, expectedVersion: 1, decision: 'reject', note: 'Not a real company' }));
    expect(await run(dewi, updateSupplierDetails, { supplierId, expectedVersion: 2, ...f, city: 'Elsewhere' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_TRANSITION' },
    });
  });
});

describe('P4-AC4: duplicates', () => {
  it('rejects the same name ignoring case, spacing, and punctuation, and the same tax ID however formatted', async () => {
    const { code } = await create({ legalName: 'PT Maju Jaya', taxId: '01.234.567.8-901.000' });
    const byName = await run(dewi, createSupplier, fields({ legalName: 'pt.  MAJU-jaya' }));
    expect(byName).toMatchObject({ ok: false, error: { code: 'BUSINESS_RULE', rule: 'SUPPLIER_DUPLICATE' } });
    if (!byName.ok) expect(byName.error.message).toContain(code);
    expect(await run(dewi, createSupplier, fields({ taxId: '012345678901000' }))).toMatchObject({ ok: false, error: { rule: 'SUPPLIER_DUPLICATE' } });
    expect(await run(dewi, createSupplier, fields({ taxId: '0123 4567 8901 000' }))).toMatchObject({ ok: false, error: { rule: 'SUPPLIER_DUPLICATE' } });
    // Legal suffixes count: a CV is not the PT.
    data(await run(dewi, createSupplier, fields({ legalName: 'CV Maju Jaya' })));
  });

  it('applies on edit and reactivation; inactive suppliers free the name but never the tax ID', async () => {
    const a = await create();
    const b = await create();
    expect(await run(dewi, updateSupplierDetails, { supplierId: b.supplierId, expectedVersion: 1, ...b.fields, legalName: a.fields.legalName })).toMatchObject({
      ok: false,
      error: { rule: 'SUPPLIER_DUPLICATE' },
    });

    data(await run(sari, reviewSupplier, { supplierId: a.supplierId, expectedVersion: 1, decision: 'reject', note: 'Duplicate entry' }));
    // Now inactive: its name may be reused, its tax ID may not.
    const reuse = await create({ legalName: a.fields.legalName });
    expect(await run(dewi, createSupplier, fields({ taxId: a.fields.taxId }))).toMatchObject({ ok: false, error: { rule: 'SUPPLIER_DUPLICATE' } });
    expect(await run(dewi, reactivateSupplier, { supplierId: a.supplierId, expectedVersion: 2 })).toMatchObject({
      ok: false,
      error: { rule: 'SUPPLIER_DUPLICATE' },
    });
    data(await run(dewi, updateSupplierDetails, { supplierId: reuse.supplierId, expectedVersion: 1, ...reuse.fields, legalName: `${a.fields.legalName} II` }));
    data(await run(dewi, reactivateSupplier, { supplierId: a.supplierId, expectedVersion: 2 }));
    expect(await row(a.supplierId)).toMatchObject({ status: 'pending_review', reviewed_by: null, status_reason: null });
  });

  it('the unique indexes back the rule up at the database', async () => {
    const a = await create();
    const clash = t.appPool.query(
      `INSERT INTO suppliers (code, legal_name, normalized_name, country_code, created_by_user_id)
       SELECT 'SUP-900001', 'x', normalized_name, 'US', created_by_user_id FROM suppliers WHERE id = $1`,
      [a.supplierId],
    );
    await expect(clash).rejects.toMatchObject({ code: '23505' });
  });
});

describe('P4-AC5: selectable for purchasing', () => {
  it('returns active suppliers only, with allowlisted fields', async () => {
    const pending = await create();
    const active = await approved();
    const blocked = await approved();
    data(await run(sari, blockSupplier, { supplierId: blocked.supplierId, expectedVersion: 2, reason: 'Sanctions check pending' }));
    const inactive = await approved();
    data(await run(dewi, deactivateSupplier, { supplierId: inactive.supplierId, expectedVersion: 2, reason: 'No longer used' }));

    const selectable = data(await run(dewi, selectableForPurchasing, {}));
    const ids = selectable.map((s) => s.id);
    expect(ids).toContain(active.supplierId);
    for (const s of [pending, blocked, inactive]) expect(ids).not.toContain(s.supplierId);
    const { rows } = await t.pool.query("SELECT count(*)::int AS n FROM suppliers WHERE status = 'active'");
    expect(selectable).toHaveLength(rows[0].n);
    for (const s of selectable) expect(Object.keys(s).sort()).toEqual([...SELECTABLE_SUPPLIER_KEYS].sort());
  });
});

describe('P4-AC6: search is literal and injection-safe', () => {
  it('finds by code, by name ignoring punctuation, and by tax ID however formatted', async () => {
    const { supplierId, code } = await create({ legalName: 'Sinar Terang, Tbk.', taxId: '99.888.777.6-555.444' });
    const find = async (q: string) => data(await run(lena, listSuppliers, { q, limit: 100 })).items.map((i) => i.id);
    expect(await find(code)).toEqual([supplierId]);
    expect(await find(code.toLowerCase())).toEqual([supplierId]);
    expect(await find('sinar terang')).toContain(supplierId);
    expect(await find('SINAR-TERANG TBK')).toContain(supplierId);
    expect(await find('998887776555444')).toEqual([supplierId]);
    expect(await find('99 888 777')).toContain(supplierId);
  });

  it("treats '; drop table', %, _ and backslashes as plain text", async () => {
    const before = await count();
    for (const q of ["'; drop table suppliers; --", '%', '_', '%%', '\\', "' OR '1'='1"]) {
      const result = data(await run(lena, listSuppliers, { q, limit: 100 }));
      expect({ q, items: result.items.length }).toEqual({ q, items: 0 });
    }
    // "SUP-%" would match every code if % were a wildcard. It matches only names containing "sup".
    const codeWildcard = data(await run(lena, listSuppliers, { q: 'SUP-%', limit: 100 })).items.map((i) => i.id).sort();
    const named = (await t.pool.query("SELECT id::text FROM suppliers WHERE normalized_name LIKE '%sup%' ORDER BY id")).rows.map(
      (r: { id: string }) => r.id,
    );
    expect(codeWildcard).toEqual(named.sort());
    expect(codeWildcard.length).toBeLessThan(await count());
    expect(await count()).toBe(before);
  });

  it('filters by status, pages by code, and validates its input', async () => {
    const all: string[] = [];
    let cursor: string | undefined;
    do {
      const page = data(await run(lena, listSuppliers, cursor ? { limit: 3, cursor } : { limit: 3 }));
      for (const item of page.items) expect(Object.keys(item).sort()).toEqual([...SUPPLIER_SUMMARY_KEYS].sort());
      all.push(...page.items.map((i) => i.code));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(all).toEqual([...all].sort());
    expect(all.length).toBe(await count());
    const pending = data(await run(lena, listSuppliers, { status: 'pending_review', limit: 100 })).items;
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((s) => s.status === 'pending_review')).toBe(true);
    for (const input of [{ cursor: "SUP-1' OR 1=1" }, { status: 'approved' }, { limit: 0 }, { q: 'x'.repeat(101) }, { sort: 'legal_name' }]) {
      expect(await run(lena, listSuppliers, input)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    }
  });
});

describe('P4-AC7: block, unblock, deactivate, reactivate', () => {
  it('each needs a reason and the current version, is audited, and follows the state machine', async () => {
    const { supplierId } = await approved();
    expect(await run(dewi, blockSupplier, { supplierId, expectedVersion: 2, reason: ' ' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    });
    expect(await run(dewi, blockSupplier, { supplierId, expectedVersion: 1, reason: 'Late deliveries' })).toMatchObject({
      ok: false,
      error: { code: 'CONFLICT' },
    });
    data(await run(dewi, blockSupplier, { supplierId, expectedVersion: 2, reason: 'Late deliveries' }));
    expect(await row(supplierId)).toMatchObject({ status: 'blocked', status_reason: 'Late deliveries' });
    expect((await auditOf(supplierId)).at(-1)).toMatchObject({
      action: 'supplier.blocked',
      actor: dewi,
      reason: 'Late deliveries',
      changes: { status: ['active', 'blocked'] },
    });
    expect(await run(sari, blockSupplier, { supplierId, expectedVersion: 3, reason: 'Again' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_TRANSITION' },
    });
    expect(await run(dewi, unblockSupplier, { supplierId, expectedVersion: 3, reason: 'Fixed' })).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    data(await run(sari, unblockSupplier, { supplierId, expectedVersion: 3, reason: 'Deliveries on time again' }));
    expect(await row(supplierId)).toMatchObject({ status: 'pending_review', reviewed_by: null, status_reason: null });
    expect((await auditOf(supplierId)).at(-1)).toMatchObject({ action: 'supplier.unblocked', reason: 'Deliveries on time again' });

    data(await run(sari, reviewSupplier, { supplierId, expectedVersion: 4, decision: 'approve', note: null }));
    // Finance may block too (supplier.block).
    data(await run(sari, blockSupplier, { supplierId, expectedVersion: 5, reason: 'Audit finding' }));
    expect(await run(dewi, deactivateSupplier, { supplierId, expectedVersion: 6, reason: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_TRANSITION' },
    });
    data(await run(sari, unblockSupplier, { supplierId, expectedVersion: 6, reason: 'Cleared' }));
    data(await run(sari, reviewSupplier, { supplierId, expectedVersion: 7, decision: 'approve', note: null }));
    data(await run(dewi, deactivateSupplier, { supplierId, expectedVersion: 8, reason: 'Contract ended' }));
    expect(await row(supplierId)).toMatchObject({ status: 'inactive', status_reason: 'Contract ended' });
    expect(await run(dewi, reactivateSupplier, { supplierId, expectedVersion: 8 })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    data(await run(dewi, reactivateSupplier, { supplierId, expectedVersion: 9 }));
    expect(await row(supplierId)).toMatchObject({ status: 'pending_review', reviewed_by: null });
    expect((await auditOf(supplierId)).at(-1)).toMatchObject({ action: 'supplier.reactivated', changes: { status: ['inactive', 'pending_review'] } });
  });

  it('rejects transitions the state machine does not list', async () => {
    const { supplierId } = await create();
    expect(await run(dewi, blockSupplier, { supplierId, expectedVersion: 1, reason: 'x' })).toMatchObject({ ok: false, error: { code: 'INVALID_TRANSITION' } });
    expect(await run(sari, unblockSupplier, { supplierId, expectedVersion: 1, reason: 'x' })).toMatchObject({ ok: false, error: { code: 'INVALID_TRANSITION' } });
    expect(await run(dewi, deactivateSupplier, { supplierId, expectedVersion: 1, reason: 'x' })).toMatchObject({ ok: false, error: { code: 'INVALID_TRANSITION' } });
    expect(await run(dewi, reactivateSupplier, { supplierId, expectedVersion: 1 })).toMatchObject({ ok: false, error: { code: 'INVALID_TRANSITION' } });
    data(await run(sari, reviewSupplier, { supplierId, expectedVersion: 1, decision: 'approve', note: null }));
    expect(await run(sari, reviewSupplier, { supplierId, expectedVersion: 2, decision: 'approve', note: null })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_TRANSITION' },
    });
    expect(await row(supplierId)).toMatchObject({ status: 'active', version: 2 });
  });

  it('a rejection needs a reason, which becomes the status reason', async () => {
    const { supplierId } = await create();
    expect(await run(sari, reviewSupplier, { supplierId, expectedVersion: 1, decision: 'reject', note: '' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', fieldErrors: { note: ['Give a reason for rejecting'] } },
    });
    data(await run(sari, reviewSupplier, { supplierId, expectedVersion: 1, decision: 'reject', note: 'Could not verify the address' }));
    expect(await row(supplierId)).toMatchObject({ status: 'inactive', reviewed_by: sari, status_reason: 'Could not verify the address' });
  });
});

describe('P4-AC10: strict inputs, allowlisted outputs, visibility', () => {
  it('rejects tampered or malformed fields before touching the database', async () => {
    const before = await count();
    const base = fields();
    for (const input of [
      { ...base, status: 'active' },
      { ...base, code: 'SUP-000001' },
      { ...base, createdByUserId: sari },
      { ...base, reviewedByUserId: sari },
      { ...base, normalizedName: 'x' },
      { ...base, bankAccount: '123' },
      { ...base, countryCode: 'XX' },
      { ...base, countryCode: 'us' },
      { ...base, legalName: '---' },
      { ...base, legalName: 'x'.repeat(201) },
      { ...base, email: 'not-an-email' },
      { ...base, taxId: 'AB;12' },
      { ...base, taxId: '1234' },
      { ...base, phone: 'call me' },
    ]) {
      expect(await run(dewi, createSupplier, input)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    }
    expect(await count()).toBe(before);
    // Blank optional fields are stored as null.
    const { supplierId } = await create({ taxId: null, email: '', phone: '  ', city: '' } as unknown as Partial<Fields>);
    expect(data(await run(lena, getSupplier, { supplierId }))).toMatchObject({ taxId: null, email: null, phone: null, city: null });
  });

  it('returns details with names, not user ids, and nothing beyond the allowlist', async () => {
    const { supplierId } = await approved();
    const detail = data(await run(lena, getSupplier, { supplierId }));
    expect(Object.keys(detail).sort()).toEqual([...SUPPLIER_DETAIL_KEYS].sort());
    expect(detail).toMatchObject({ createdBy: 'Dewi Procurement', reviewedBy: 'Sari Finance', identityChangedBy: null, callerIsMaker: false });
    const serialized = JSON.stringify(detail);
    for (const userId of [dewi, sari]) expect(serialized).not.toContain(userId);
    expect(serialized).not.toMatch(/normalized|bank/i);
  });

  it('unknown ids are NOT_FOUND; people without supplier.read get nothing', async () => {
    expect(await run(lena, getSupplier, { supplierId: randomUUID() })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await run(dewi, blockSupplier, { supplierId: randomUUID(), expectedVersion: 1, reason: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    const { supplierId } = await create();
    expect(await run(rina, listSuppliers, {})).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await run(rina, selectableForPurchasing, {})).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await run(rina, getSupplier, { supplierId })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await run(lena, createSupplier, fields())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });
});
