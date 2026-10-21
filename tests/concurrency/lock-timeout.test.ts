import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { recordAuditEvent } from '@/modules/audit';
import { createRequestContext } from '@/shared/application/context';
import { defineCommand, runCommand } from '@/shared/application/runner';
import { allocateDocumentNumber } from '@/shared/db/document-numbers';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

// CC-07 (ADR 0008): deterministic interleaving. Connection A holds the row lock;
// command B times out with CONFLICT and leaves no partial writes behind.
let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
  await t.db.execute(sql`CREATE TABLE probe_side_effects (id integer PRIMARY KEY)`);
  await t.db.execute(sql`GRANT SELECT, INSERT ON probe_side_effects TO procureflow_app`);
  await t.db.execute(sql`INSERT INTO document_sequences VALUES ('PO', 2026, 10)`);
});

afterAll(async () => {
  await t?.drop();
});

const ctx = () => createRequestContext({ actor: { userId: 'u-2', roles: ['buyer'], permissions: new Set(['probe.write']) } });

const writeThenAllocate = defineCommand({
  name: 'probe.writeThenAllocate',
  permission: 'probe.write',
  input: z.strictObject({ id: z.number().int() }),
  handler: async ({ tx, request }, input) => {
    // Side effects first, so a later failure must roll them back.
    await tx.execute(sql`INSERT INTO probe_side_effects VALUES (${input.id})`);
    await recordAuditEvent(tx, request, { action: 'probe.attempted', entityType: 'probe', entityId: String(input.id) });
    return allocateDocumentNumber(tx, 'PO', 2026); // needs the row lock A is holding
  },
});

describe('CC-07: lock timeout', () => {
  it('returns CONFLICT after lock_timeout and leaves no partial writes', async () => {
    const holder = await t.appPool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query("SELECT * FROM document_sequences WHERE doc_type = 'PO' AND year = 2026 FOR UPDATE");

      const started = Date.now();
      const result = await runCommand(ctx(), writeThenAllocate, { id: 1 }, { db: t.appDb, lockTimeout: '300ms' });
      const waited = Date.now() - started;

      expect(result).toEqual({
        ok: false,
        error: { code: 'CONFLICT', message: 'This record is being changed by someone else. Try again.' },
      });
      expect(waited).toBeGreaterThanOrEqual(250);
      expect(waited).toBeLessThan(5000);

      const side = await t.pool.query('SELECT count(*)::int AS n FROM probe_side_effects');
      const audit = await t.pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'probe.attempted'");
      expect([side.rows[0].n, audit.rows[0].n]).toEqual([0, 0]);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }

    // Once the lock is gone, the same command succeeds and continues the sequence.
    const retry = await runCommand(ctx(), writeThenAllocate, { id: 1 }, { db: t.appDb, lockTimeout: '300ms' });
    expect(retry).toEqual({ ok: true, data: 11 });
  });
});
