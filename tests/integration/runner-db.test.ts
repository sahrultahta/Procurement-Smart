import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createRequestContext } from '@/shared/application/context';
import { defineCommand, defineQuery, runCommand, runQuery } from '@/shared/application/runner';
import { allocateDocumentNumber, formatDocumentNumber } from '@/shared/db/document-numbers';
import { createTestDatabase, sqlStateOf, type TestDatabase } from '../support/test-db';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
  await t.db.execute(sql`CREATE TABLE probe_notes (id integer PRIMARY KEY)`);
  await t.db.execute(sql`GRANT SELECT, INSERT ON probe_notes TO procureflow_app`);
});

afterAll(async () => {
  await t?.drop();
});

const ctx = () =>
  createRequestContext({ actor: { userId: 'u-1', roles: ['buyer'], permissions: new Set(['probe.read', 'probe.write']) } });

describe('runner against PostgreSQL (procureflow_app)', () => {
  it('applies the per-transaction lock and statement timeouts (ADR 0008 C7)', async () => {
    const show = defineCommand({
      name: 'probe.showTimeouts',
      permission: 'probe.write',
      input: z.strictObject({}),
      handler: async ({ tx }) => {
        const lock = await tx.execute<{ lock_timeout: string }>(sql`SHOW lock_timeout`);
        const statement = await tx.execute<{ statement_timeout: string }>(sql`SHOW statement_timeout`);
        return { lock: lock.rows[0]?.lock_timeout, statement: statement.rows[0]?.statement_timeout };
      },
    });
    expect(await runCommand(ctx(), show, {}, { db: t.appDb })).toEqual({ ok: true, data: { lock: '5s', statement: '15s' } });
    // SET LOCAL does not leak into the pooled connection afterwards.
    const { rows } = await t.appPool.query('SHOW lock_timeout');
    expect(rows[0].lock_timeout).toBe('0');
  });

  it('runs queries read-only: a write inside a query fails and changes nothing', async () => {
    const sneakyWrite = defineQuery({
      name: 'probe.sneakyWrite',
      permission: 'probe.read',
      input: z.strictObject({}),
      handler: async ({ tx }) => {
        await tx.execute(sql`INSERT INTO probe_notes VALUES (1)`);
        return 'wrote';
      },
    });
    const result = await runQuery(ctx(), sneakyWrite, {}, { db: t.appDb });
    expect(result.ok ? null : result.error.code).toBe('INTERNAL');
    const { rows } = await t.pool.query('SELECT count(*)::int AS n FROM probe_notes');
    expect(rows[0].n).toBe(0);
  });

  it('runs a normal query', async () => {
    const count = defineQuery({
      name: 'probe.count',
      permission: 'probe.read',
      input: z.strictObject({}),
      handler: async ({ tx }) => (await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM probe_notes`)).rows[0]?.n,
    });
    expect(await runQuery(ctx(), count, {}, { db: t.appDb })).toEqual({ ok: true, data: 0 });
  });
});

describe('document numbers', () => {
  it('allocates consecutive numbers per type and year, independently', async () => {
    const values = await t.appDb.transaction(async (tx) => [
      await allocateDocumentNumber(tx, 'PR', 2026),
      await allocateDocumentNumber(tx, 'PR', 2026),
      await allocateDocumentNumber(tx, 'PO', 2026),
      await allocateDocumentNumber(tx, 'PR', 2027),
      await allocateDocumentNumber(tx, 'SUP', 0),
    ]);
    expect(values).toEqual([1, 2, 1, 1, 1]);
  });

  it('gives a rolled-back number back (gapless)', async () => {
    await expect(
      t.appDb.transaction(async (tx) => {
        await allocateDocumentNumber(tx, 'GR', 2026);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await t.appDb.transaction((tx) => allocateDocumentNumber(tx, 'GR', 2026))).toBe(1);
  });

  it('rejects an unknown type or year at the database (CHECK backstop)', async () => {
    expect(await sqlStateOf(() => t.appPool.query("INSERT INTO document_sequences VALUES ('pr', 2026, 1)"))).toBe('23514');
    expect(await sqlStateOf(() => t.appPool.query("INSERT INTO document_sequences VALUES ('PR', 1999, 1)"))).toBe('23514');
  });

  it('formats numbers', () => {
    expect(formatDocumentNumber('PR', 2026, 42)).toBe('PR-2026-000042');
    expect(formatDocumentNumber('SUP', 0, 7)).toBe('SUP-000007');
    expect(formatDocumentNumber('PO', 2026, 1234567)).toBe('PO-2026-1234567');
    expect(() => formatDocumentNumber('PO', 2026, 0)).toThrow();
  });
});
