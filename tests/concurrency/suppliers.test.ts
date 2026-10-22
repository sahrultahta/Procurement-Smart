import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSupplier, reviewSupplier, updateSupplierDetails } from '@/modules/suppliers';
import type { RequestContext } from '@/shared/application/context';
import { runCommand } from '@/shared/application/runner';
import type { Result } from '@/shared/result';
import { contextOf, provisionActor } from '../support/actors';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/*
 * CC-09 (P4-AC4): parallel creates with the same tax ID or name: exactly one succeeds.
 * CC-10 (P4-AC8, AB-04): an approval racing an identity change on the same version:
 * exactly one wins, and no supplier is ever active with an unreviewed identity.
 */
let t: TestDatabase;
let dewi: RequestContext;
let fajar: RequestContext;
let sari: RequestContext;
const ITERATIONS = 20;
const PARALLEL = 5;

beforeAll(async () => {
  t = await createTestDatabase();
  dewi = await contextOf(t.appDb, await provisionActor(t.appDb, 'dewi@example.com', 'Dewi Procurement', ['procurement']));
  fajar = await contextOf(t.appDb, await provisionActor(t.appDb, 'fajar@example.com', 'Fajar Procurement', ['procurement']));
  sari = await contextOf(t.appDb, await provisionActor(t.appDb, 'sari@example.com', 'Sari Finance', ['finance']));
});

afterAll(async () => {
  await t?.drop();
});

const base = (legalName: string, taxId: string | null) => ({
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
});

function outcome(result: Result<unknown>): string {
  return result.ok ? 'ok' : `${result.error.code}${result.error.rule ? `:${result.error.rule}` : ''}`;
}

describe('CC-09: concurrent duplicate creates', () => {
  it(`${PARALLEL} parallel creates with one tax ID, ${ITERATIONS} times: exactly one succeeds`, async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const results = await Promise.all(
        Array.from({ length: PARALLEL }, (_, n) =>
          runCommand(n % 2 ? dewi : fajar, createSupplier, base(`Tax Race ${i} Variant ${n}`, `RACE-${i}-0000`), { db: t.appDb }),
        ),
      );
      expect(results.map(outcome).sort()).toEqual(['BUSINESS_RULE:SUPPLIER_DUPLICATE', ...Array(PARALLEL - 2).fill('BUSINESS_RULE:SUPPLIER_DUPLICATE'), 'ok'].sort());
    }
    const { rows } = await t.pool.query("SELECT count(*)::int AS n FROM suppliers WHERE tax_id_normalized LIKE 'RACE%'");
    expect(rows[0].n).toBe(ITERATIONS);
  });

  it(`${PARALLEL} parallel creates with one name (differently punctuated), ${ITERATIONS} times: exactly one succeeds`, async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const spellings = [`Name Race ${i}`, `NAME-RACE ${i}`, `name.race ${i}`, `Name  Race, ${i}`, `name race ${i}.`];
      const results = await Promise.all(spellings.map((name) => runCommand(dewi, createSupplier, base(name, null), { db: t.appDb })));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok).map(outcome)).toEqual(Array(PARALLEL - 1).fill('BUSINESS_RULE:SUPPLIER_DUPLICATE'));
    }
    // Codes stay gapless: rolled-back creates give their numbers back.
    const { rows } = await t.pool.query("SELECT array_agg(substr(code, 5)::int ORDER BY code) AS n FROM suppliers");
    const numbers = rows[0].n as number[];
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, k) => k + 1));
  });
});

async function waitForLockWaiters(count: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    // Ungranted locks from pg_locks: pg_stat_activity hides other roles' wait events from
    // non-superusers, but still shows which database each backend is in.
    const { rows } = await t.pool.query(
      `SELECT count(DISTINCT l.pid)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
       WHERE NOT l.granted AND a.datname = current_database()`,
    );
    if (rows[0].n >= count) return;
    await sleep(10);
  }
  throw new Error(`expected ${count} transactions waiting on the supplier row`);
}

describe('CC-10: approval racing an identity change (AB-04)', () => {
  it(`exactly one wins, ${ITERATIONS} forced overlaps; never active with an unreviewed identity`, async () => {
    const winners = { approve: 0, rename: 0 };
    for (let i = 0; i < ITERATIONS; i++) {
      const created = await runCommand(dewi, createSupplier, base(`Identity Race ${i}`, `IDRACE${i}00`), { db: t.appDb });
      if (!created.ok) throw new Error(outcome(created));
      const { supplierId } = created.data;

      // Hold the row so both commands are authorized, in their transactions, and queued on it.
      const holder = await t.pool.connect();
      let results: Result<unknown>[];
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT 1 FROM suppliers WHERE id = $1 FOR UPDATE', [supplierId]);
        const pending = Promise.all([
          runCommand(sari, reviewSupplier, { supplierId, expectedVersion: 1, decision: 'approve', note: null }, { db: t.appDb }),
          runCommand(
            dewi,
            updateSupplierDetails,
            { supplierId, expectedVersion: 1, ...base(`Identity Race ${i} Swapped`, `IDRACE${i}99`) },
            { db: t.appDb },
          ),
        ]);
        await waitForLockWaiters(2);
        await holder.query('COMMIT');
        results = await pending;
      } finally {
        holder.release();
      }

      const [approve, rename] = results.map(outcome);
      expect([approve, rename].sort()).toEqual(['CONFLICT', 'ok']);
      if (approve === 'ok') winners.approve++;
      else winners.rename++;

      const { rows } = await t.pool.query(
        'SELECT status, legal_name, reviewed_by_user_id::text AS reviewed_by, version FROM suppliers WHERE id = $1',
        [supplierId],
      );
      const row = rows[0] as { status: string; legal_name: string; reviewed_by: string | null; version: number };
      expect(row.version).toBe(2);
      if (approve === 'ok') expect(row).toMatchObject({ status: 'active', legal_name: `Identity Race ${i}`, reviewed_by: sari.actor?.userId });
      else expect(row).toMatchObject({ status: 'pending_review', legal_name: `Identity Race ${i} Swapped`, reviewed_by: null });
    }
    const { rows } = await t.pool.query("SELECT count(*)::int AS n FROM suppliers WHERE status = 'active' AND reviewed_by_user_id IS NULL");
    expect(rows[0].n).toBe(0);
    expect(winners.approve + winners.rename).toBe(ITERATIONS);
  });
});
