import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, createTestDatabase, type TestDatabase } from '../support/test-db';

// P1-AC5: the local/CI server is PostgreSQL 18 and supports what the schema design relies on.
let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t?.drop();
});

describe('PostgreSQL baseline', () => {
  it('is PostgreSQL 18 or newer', async () => {
    const { rows } = await t.pool.query<{ server_version_num: string }>('SHOW server_version_num');
    expect(Number(rows[0]?.server_version_num)).toBeGreaterThanOrEqual(180000);
  });

  it('generates version-7 UUIDs with the built-in uuidv7()', async () => {
    const { rows } = await t.pool.query<{ id: string }>('SELECT uuidv7()::text AS id');
    expect(rows[0]?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('runs and commits a SERIALIZABLE Drizzle transaction', async () => {
    await t.db.execute(sql`CREATE TABLE tx_probe (id integer PRIMARY KEY, note text NOT NULL)`);
    const level = await t.db.transaction(
      async (tx) => {
        await tx.execute(sql`INSERT INTO tx_probe VALUES (1, 'committed')`);
        const result = await tx.execute<{ transaction_isolation: string }>(sql`SHOW transaction_isolation`);
        return result.rows[0]?.transaction_isolation;
      },
      { isolationLevel: 'serializable' },
    );
    expect(level).toBe('serializable');
    const { rows } = await t.pool.query('SELECT note FROM tx_probe WHERE id = 1');
    expect(rows).toEqual([{ note: 'committed' }]);
  });

  it('rolls back a transaction that throws', async () => {
    await t.db.execute(sql`CREATE TABLE rollback_probe (id integer PRIMARY KEY)`);
    await expect(
      t.db.transaction(async (tx) => {
        await tx.execute(sql`INSERT INTO rollback_probe VALUES (1)`);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const { rows } = await t.pool.query('SELECT count(*)::int AS n FROM rollback_probe');
    expect(rows).toEqual([{ n: 0 }]);
  });

  it('applied every migration in the journal to the template', async () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8')) as {
      entries: unknown[];
    };
    const { rows } = await t.pool.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations');
    expect(rows).toEqual([{ n: journal.entries.length }]);
  });
});
