import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { auditChanges, defineAuditPolicy, recordAuditEvent } from '@/modules/audit';
import { createRequestContext } from '@/shared/application/context';
import { defineCommand, runCommand } from '@/shared/application/runner';
import { failBusinessRule } from '@/shared/result';
import { createTestDatabase, sqlStateOf, type TestDatabase } from '../support/test-db';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
  // A stand-in business table for this test only, with the same grant pattern as real ones.
  await t.db.execute(sql`CREATE TABLE probe_items (id integer PRIMARY KEY, note text NOT NULL)`);
  await t.db.execute(sql`GRANT SELECT, INSERT ON probe_items TO procureflow_app`);
});

afterAll(async () => {
  await t?.drop();
});

const request = () =>
  createRequestContext({
    actor: { userId: 'user-42', roles: ['requester', 'approver', 'requester'], permissions: new Set(['probe.write']) },
    ip: '203.0.113.7',
    userAgent: 'vitest',
  });

const appInsertEvent = (entityId: string) =>
  t.appDb.transaction((tx) => recordAuditEvent(tx, request(), { action: 'probe.created', entityType: 'probe', entityId }));

describe('audit_events privileges (P2-AC3)', () => {
  beforeEach(async () => {
    await appInsertEvent('seed');
  });

  it('really connects as the restricted runtime role (not the owner)', async () => {
    const app = await t.appPool.query('SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su');
    const owner = await t.pool.query('SELECT current_user AS u');
    expect(app.rows[0]).toEqual({ u: 'procureflow_app', su: false });
    expect(owner.rows[0].u).toBe('procureflow_owner');
  });

  it('lets the runtime role insert and read audit events', async () => {
    const { rows } = await t.appPool.query('SELECT count(*)::int AS n FROM audit_events');
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it.each([
    ['UPDATE', "UPDATE audit_events SET reason = 'tampered'"],
    ['DELETE', 'DELETE FROM audit_events'],
    ['TRUNCATE', 'TRUNCATE audit_events'],
    ['DISABLE TRIGGER', 'ALTER TABLE audit_events DISABLE TRIGGER ALL'],
    ['DROP', 'DROP TABLE audit_events'],
  ])('denies the runtime role %s (permission denied, 42501)', async (_label, statement) => {
    expect(await sqlStateOf(() => t.appPool.query(statement))).toBe('42501');
  });

  it('denies the runtime role any DDL', async () => {
    expect(await sqlStateOf(() => t.appPool.query('CREATE TABLE sneaky (id int)'))).toBe('42501');
  });

  it.each([
    ['UPDATE', "UPDATE audit_events SET reason = 'tampered'"],
    ['DELETE', 'DELETE FROM audit_events'],
    ['TRUNCATE', 'TRUNCATE audit_events'],
  ])('blocks %s even for the owner, via trigger (PFA01)', async (_label, statement) => {
    expect(await sqlStateOf(() => t.pool.query(statement))).toBe('PFA01');
  });

  it('records actor, deduplicated sorted roles, request id, IP, and user agent from the context', async () => {
    const ctx = request();
    await t.appDb.transaction((tx) =>
      recordAuditEvent(tx, ctx, { action: 'probe.inspected', entityType: 'probe', entityId: 'ctx-check', reason: 'test' }),
    );
    const { rows } = await t.pool.query(
      "SELECT actor_user_id, actor_roles, request_id, host(ip) AS ip, user_agent, reason, changes FROM audit_events WHERE entity_id = 'ctx-check'",
    );
    expect(rows).toEqual([
      {
        actor_user_id: 'user-42',
        actor_roles: ['approver', 'requester'],
        request_id: ctx.requestId,
        ip: '203.0.113.7',
        user_agent: 'vitest',
        reason: 'test',
        changes: {},
      },
    ]);
  });

  it('rejects a malformed event at the database too (CHECK backstop)', async () => {
    const state = await sqlStateOf(() =>
      t.appPool.query("INSERT INTO audit_events (action, entity_type, entity_id) VALUES ('NotAnAction', 'probe', '1')"),
    );
    expect(state).toBe('23514');
  });
});

// P2-AC4: an audit event commits or rolls back together with the change it describes.
const policy = defineAuditPolicy<{ note: string }>({ entityType: 'probe', fields: ['note'] });

const createProbe = defineCommand({
  name: 'probe.create',
  permission: 'probe.write',
  input: z.strictObject({ id: z.number().int(), note: z.string(), failAfterAudit: z.enum(['no', 'crash', 'businessRule']) }),
  handler: async ({ tx, request: ctx }, input) => {
    await tx.execute(sql`INSERT INTO probe_items (id, note) VALUES (${input.id}, ${input.note})`);
    await recordAuditEvent(tx, ctx, {
      action: 'probe.created',
      entityType: 'probe',
      entityId: String(input.id),
      changes: auditChanges(policy, null, { note: input.note }),
    });
    if (input.failAfterAudit === 'crash') throw new Error('crash after the audit insert');
    if (input.failAfterAudit === 'businessRule') failBusinessRule('PROBE_RULE', 'Rejected after audit.');
    return { id: input.id };
  },
});

async function rowsFor(id: number) {
  const items = await t.pool.query('SELECT note FROM probe_items WHERE id = $1', [id]);
  const events = await t.pool.query('SELECT action, actor_user_id, request_id, changes FROM audit_events WHERE entity_id = $1', [
    String(id),
  ]);
  return { items: items.rows, events: events.rows };
}

describe('audit in the same transaction as the change (P2-AC4)', () => {
  it('a successful command leaves exactly its data row and its audit event', async () => {
    const ctx = request();
    const result = await runCommand(ctx, createProbe, { id: 1, note: 'kept', failAfterAudit: 'no' }, { db: t.appDb });
    expect(result).toEqual({ ok: true, data: { id: 1 } });
    expect(await rowsFor(1)).toEqual({
      items: [{ note: 'kept' }],
      events: [{ action: 'probe.created', actor_user_id: 'user-42', request_id: ctx.requestId, changes: { note: [null, 'kept'] } }],
    });
  });

  it('an unexpected failure after the audit insert leaves neither row', async () => {
    const result = await runCommand(request(), createProbe, { id: 2, note: 'gone', failAfterAudit: 'crash' }, { db: t.appDb });
    expect(result.ok ? null : result.error.code).toBe('INTERNAL');
    expect(await rowsFor(2)).toEqual({ items: [], events: [] });
  });

  it('a business-rule failure after the audit insert leaves neither row', async () => {
    const result = await runCommand(request(), createProbe, { id: 3, note: 'gone', failAfterAudit: 'businessRule' }, {
      db: t.appDb,
    });
    expect(result.ok ? null : result.error).toMatchObject({ code: 'BUSINESS_RULE', rule: 'PROBE_RULE' });
    expect(await rowsFor(3)).toEqual({ items: [], events: [] });
  });

  it('a database constraint failure maps to a clear error and leaves neither row', async () => {
    await runCommand(request(), createProbe, { id: 4, note: 'first', failAfterAudit: 'no' }, { db: t.appDb });
    const duplicate = await runCommand(request(), createProbe, { id: 4, note: 'second', failAfterAudit: 'no' }, { db: t.appDb });
    expect(duplicate.ok ? null : duplicate.error.code).toBe('CONFLICT');
    const after = await rowsFor(4);
    expect(after.items).toEqual([{ note: 'first' }]);
    expect(after.events).toHaveLength(1);
  });
});
