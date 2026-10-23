import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSettings, publishApprovalPolicy, updateOrganizationSettings } from '@/modules/organization';
import { createRequisition } from '@/modules/requisitions';
import type { RequestContext } from '@/shared/application/context';
import { runCommand, runQuery } from '@/shared/application/runner';
import { contextOf, provisionActor } from '../support/actors';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/*
 * P5a-AC6 (CC-06 for requisitions, ADR 0008 C6): parallel creates with one idempotency key.
 * P5a-AC2: parallel policy publishes stay serial, with exactly one active version.
 * P5a-AC1: the first requisition racing a currency change never ends up in a stale currency.
 */
let t: TestDatabase;
let rina: RequestContext;
let ada: RequestContext;
const ITERATIONS = 20;
const PARALLEL = 5;

beforeAll(async () => {
  t = await createTestDatabase();
  await t.pool.query("INSERT INTO departments (code, name) VALUES ('OPS', 'Operations')");
  rina = await contextOf(t.appDb, await provisionActor(t.appDb, 'rina@example.com', 'Rina', ['requester'], { departmentCode: 'OPS' }));
  ada = await contextOf(t.appDb, await provisionActor(t.appDb, 'ada@example.com', 'Ada', ['admin']));
});

afterAll(async () => {
  await t?.drop();
});

const draft = (title: string) => ({
  title,
  justification: null,
  neededBy: '2030-01-31',
  lines: [{ description: 'Toner', quantity: '2', uom: 'pcs', estimatedUnitPrice: '45.50' }],
});

describe('idempotent create under concurrency', () => {
  it(`${PARALLEL} parallel creates with one key, ${ITERATIONS} times: one requisition, the same answer for all`, async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const key = `race-${i}-${randomUUID()}`;
      const results = await Promise.all(
        Array.from({ length: PARALLEL }, () => runCommand(rina, createRequisition, { ...draft(`Race ${i}`), idempotencyKey: key }, { db: t.appDb })),
      );
      const ok = results.map((r) => (r.ok ? r.data : null));
      expect(ok.every((r) => r !== null)).toBe(true);
      // Same values for everyone (a replay comes back from jsonb, so key order may differ).
      for (const result of ok) expect(result).toEqual(ok[0]);
      const { rows } = await t.pool.query('SELECT count(*)::int AS n FROM purchase_requisitions WHERE title = $1', [`Race ${i}`]);
      expect(rows[0].n).toBe(1);
    }
    // Numbers stay gapless: no number was allocated and then thrown away.
    const { rows } = await t.pool.query('SELECT array_agg(substr(number, 9)::int ORDER BY number) AS n FROM purchase_requisitions');
    const numbers = rows[0].n as number[];
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, k) => k + 1));
  });
});

describe('parallel policy publishes', () => {
  it(`${PARALLEL} at once all succeed one after another; exactly one version is active`, async () => {
    const rules = [
      { departmentCode: null, minAmount: '0', maxAmount: null, steps: [{ role: 'approver', scopeMode: 'document_department' }] },
    ];
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, (_, n) =>
        runCommand(ada, publishApprovalPolicy, { documentType: 'requisition', name: `Parallel ${n}`, rules }, { db: t.appDb }),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const versions = results.map((r) => (r.ok ? r.data.versionNo : 0)).sort((a, b) => a - b);
    expect(versions).toEqual([1, 2, 3, 4, 5]);
    const { rows } = await t.pool.query("SELECT version_no FROM approval_policies WHERE document_type = 'requisition' AND is_active");
    expect(rows).toEqual([{ version_no: 5 }]);
  });
});

describe('the first requisition racing a currency change', () => {
  it('never leaves a requisition in a currency other than the locked org currency (10 fresh databases)', async () => {
    const outcomes = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const db = await createTestDatabase();
      try {
        await db.pool.query("INSERT INTO departments (code, name) VALUES ('OPS', 'Operations')");
        const requester = await contextOf(db.appDb, await provisionActor(db.appDb, 'r@example.com', 'R', ['requester'], { departmentCode: 'OPS' }));
        const admin = await contextOf(db.appDb, await provisionActor(db.appDb, 'a@example.com', 'A', ['admin']));
        const [created, changed] = await Promise.all([
          runCommand(requester, createRequisition, draft('First'), { db: db.appDb }),
          runCommand(admin, updateOrganizationSettings, { orgName: 'X', timezone: 'UTC', currencyCode: 'EUR', currencyScale: 2, expectedVersion: 1 }, { db: db.appDb }),
        ]);
        expect(created.ok).toBe(true);
        outcomes.add(changed.ok ? 'currency changed first' : `refused: ${changed.error.rule}`);
        const settings = await runQuery(admin, getSettings, {}, { db: db.appDb });
        const pr = (await db.pool.query('SELECT currency_code FROM purchase_requisitions')).rows[0].currency_code as string;
        expect(settings.ok && settings.data.currencyLocked).toBe(true);
        expect(settings.ok && settings.data.currencyCode).toBe(pr);
      } finally {
        await db.drop();
      }
    }
    // Every outcome seen is one of the two legal orders.
    for (const outcome of outcomes) expect(['currency changed first', 'refused: CURRENCY_LOCKED']).toContain(outcome);
  });
});
