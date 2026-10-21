import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { recordAuditEvent } from '@/modules/audit';
import { createRequestContext } from '@/shared/application/context';
import { defineCommand, runCommand } from '@/shared/application/runner';
import { allocateDocumentNumber, formatDocumentNumber } from '@/shared/db/document-numbers';
import { failBusinessRule } from '@/shared/result';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

// CC-05 (ADR 0008): parallel allocations through the real runner, as procureflow_app,
// on separate pooled connections, yield unique consecutive numbers with no gaps.
let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t?.drop();
});

const ctx = () => createRequestContext({ actor: { userId: 'u-1', roles: ['buyer'], permissions: new Set(['probe.write']) } });

const createNumbered = defineCommand({
  name: 'probe.createNumbered',
  permission: 'probe.write',
  input: z.strictObject({ year: z.number().int(), failAfterAllocation: z.boolean() }),
  handler: async ({ tx, request }, input) => {
    const value = await allocateDocumentNumber(tx, 'PR', input.year);
    const number = formatDocumentNumber('PR', input.year, value);
    // Widen the race window: hold the counter lock while doing more work.
    await tx.execute(sql`SELECT pg_sleep(0.005)`);
    await recordAuditEvent(tx, request, { action: 'probe.numbered', entityType: 'probe', entityId: number });
    if (input.failAfterAllocation) failBusinessRule('PROBE_ABORT', 'Aborted after allocation.');
    return number;
  },
});

describe('CC-05: concurrent document numbering', () => {
  it.each(Array.from({ length: 20 }, (_, i) => i + 1))('iteration %i: 50 parallel commands get 50 unique consecutive numbers', async (i) => {
    const year = 2100 + i;
    const results = await Promise.all(
      Array.from({ length: 50 }, () => runCommand(ctx(), createNumbered, { year, failAfterAllocation: false }, { db: t.appDb })),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const numbers = results.map((r) => (r.ok ? r.data : '')).sort();
    expect(numbers).toEqual(Array.from({ length: 50 }, (_, n) => formatDocumentNumber('PR', year, n + 1)));
    const { rows } = await t.pool.query('SELECT last_value FROM document_sequences WHERE doc_type = $1 AND year = $2', ['PR', year]);
    expect(rows).toEqual([{ last_value: 50 }]);
  });

  it('negative control: a naive read-then-write allocator DOES produce duplicates under this load', async () => {
    // Proves the test above can detect a race: the same workload against an unlocked
    // "SELECT last_value, then UPDATE" implementation must collide.
    await t.db.execute(sql`INSERT INTO document_sequences VALUES ('RFQ', 2300, 0)`);
    const naive = () =>
      t.appDb.transaction(async (tx) => {
        const read = await tx.execute<{ last_value: number }>(
          sql`SELECT last_value FROM document_sequences WHERE doc_type = 'RFQ' AND year = 2300`,
        );
        const next = (read.rows[0]?.last_value ?? 0) + 1;
        await tx.execute(sql`SELECT pg_sleep(0.02)`);
        await tx.execute(sql`UPDATE document_sequences SET last_value = ${next} WHERE doc_type = 'RFQ' AND year = 2300`);
        return next;
      });
    const values = await Promise.all(Array.from({ length: 50 }, naive));
    expect(new Set(values).size).toBeLessThan(50);
  });

  it('stays gapless when some concurrent transactions roll back after allocating', async () => {
    const year = 2200;
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, n) =>
        runCommand(ctx(), createNumbered, { year, failAfterAllocation: n % 5 === 0 }, { db: t.appDb }),
      ),
    );
    const committed = results.filter((r) => r.ok).map((r) => (r.ok ? r.data : '')).sort();
    expect(committed).toHaveLength(40);
    expect(committed).toEqual(Array.from({ length: 40 }, (_, n) => formatDocumentNumber('PR', year, n + 1)));
    const audit = await t.pool.query(
      "SELECT count(*)::int AS n FROM audit_events WHERE action = 'probe.numbered' AND entity_id LIKE 'PR-2200-%'",
    );
    expect(audit.rows[0].n).toBe(40);
  });
});
