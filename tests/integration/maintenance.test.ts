import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GENESIS_HASH, compareExportWithDatabase, exportAuditEvents, exportedEvents, recordAuditEvent, verifyExport } from '@/modules/audit';
import { createRequestContext } from '@/shared/application/context';
import { purgeIdempotencyKeys } from '@/shared/db/idempotency';
import { provisionActor } from '../support/actors';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/* Phase 10: the hash-chained audit export (P10-AC5) and the idempotency purge (P10-AC6), as the runtime role. */

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
  await provisionActor(t.appDb, 'ada@example.com', 'Ada Admin', ['admin']);
  // Events with every kind of value: IP and user agent, a reason, nested changes, a system actor.
  const request = createRequestContext({ actor: null, ip: '2001:db8::7', userAgent: 'Export/1.0' });
  await t.appDb.transaction(async (tx) => {
    await recordAuditEvent(tx, request, { action: 'settings.updated', entityType: 'org_settings', entityId: '1', changes: { timezone: ['UTC', 'Asia/Jakarta'] }, reason: 'Moved office' });
    await recordAuditEvent(tx, request, { action: 'supplier.blocked', entityType: 'supplier', entityId: 'x', changes: { tags: [null, ['a', 'b']] } });
  });
});

afterAll(async () => {
  await t?.drop();
});

async function exportAll(afterId = '0', previousHash = GENESIS_HASH) {
  const lines: string[] = [];
  const footer = await exportAuditEvents(t.appDb, { afterId, previousHash, exportedAt: new Date('2026-10-29T00:00:00Z') }, (line) => {
    lines.push(line);
  });
  return { lines, footer };
}

describe('P10-AC5: audit export', () => {
  it('exports every event in id order as a chain that verifies and matches the database', async () => {
    const count = Number((await t.pool.query('SELECT count(*) AS n FROM audit_events')).rows[0].n);
    const { lines, footer } = await exportAll();
    expect(footer.count).toBe(count);
    const verified = verifyExport(lines);
    expect(verified).toMatchObject({ ok: true, count, lastId: footer.lastId, lastHash: footer.lastHash });
    const events = exportedEvents(lines);
    expect(events.map((e) => Number(e.id))).toEqual([...events.map((e) => Number(e.id))].sort((a, b) => a - b));
    const moved = events.find((e) => e.action === 'settings.updated');
    expect(moved).toMatchObject({ ip: '2001:db8::7', userAgent: 'Export/1.0', reason: 'Moved office', actorUserId: null, changes: { timezone: ['UTC', 'Asia/Jakarta'] } });
    expect(moved?.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    expect(await compareExportWithDatabase(t.appDb, events, { afterId: '0', lastId: footer.lastId })).toEqual({ missing: [], changed: [], extra: [] });
  });

  it('is the same whatever the session time zone', async () => {
    const first = exportedEvents((await exportAll()).lines);
    const client = await t.appPool.connect();
    try {
      await client.query("SET TIME ZONE 'Asia/Jakarta'");
      const rows = await client.query("SELECT to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS at FROM audit_events ORDER BY id LIMIT 1");
      expect(rows.rows[0].at).toBe(first[0]?.occurredAt);
    } finally {
      client.release();
    }
  });

  it('continues a chain from the last id and hash of the previous export', async () => {
    const first = await exportAll();
    await t.appDb.transaction((tx) =>
      recordAuditEvent(tx, createRequestContext({ actor: null }), { action: 'settings.updated', entityType: 'org_settings', entityId: '1', changes: { orgName: ['A', 'B'] } }),
    );
    const next = await exportAll(first.footer.lastId, first.footer.lastHash);
    expect(next.footer.count).toBe(1);
    expect(verifyExport(next.lines)).toMatchObject({ ok: true, previousHash: first.footer.lastHash, afterId: first.footer.lastId });
    // The new export's event chains to the old file: verifying it from scratch fails.
    expect(verifyExport(next.lines.map((l, i) => (i === 0 ? l.replace(first.footer.lastHash, GENESIS_HASH) : l))).ok).toBe(false);
  });

  it('finds events changed, deleted, or added in the database after the export (by the owner, guards off)', async () => {
    const { lines, footer } = await exportAll();
    const events = exportedEvents(lines);
    const [a, b] = events;
    if (!a || !b) throw new Error('need two events');
    const owner = await t.pool.connect();
    try {
      await owner.query('BEGIN');
      await owner.query('ALTER TABLE audit_events DISABLE TRIGGER USER');
      await owner.query("UPDATE audit_events SET reason = 'edited later' WHERE id = $1", [a.id]);
      await owner.query('DELETE FROM audit_events WHERE id = $1', [b.id]);
      await owner.query('ALTER TABLE audit_events ENABLE TRIGGER USER');
      await owner.query('COMMIT');
    } finally {
      owner.release();
    }
    expect(await compareExportWithDatabase(t.appDb, events, { afterId: '0', lastId: footer.lastId })).toEqual({ missing: [b.id], changed: [a.id], extra: [] });
    // An event written after the export, inside the range it claims, is "extra".
    expect(await compareExportWithDatabase(t.appDb, events.slice(0, -1), { afterId: '0', lastId: footer.lastId })).toMatchObject({ extra: [events.at(-1)?.id] });
  });
});

describe('P10-AC6: idempotency purge', () => {
  it('deletes only keys created before the cutoff, as the runtime role', async () => {
    const userId = (await t.pool.query('SELECT id FROM users LIMIT 1')).rows[0].id as string;
    const hash = 'a'.repeat(64);
    await t.pool.query(
      `INSERT INTO idempotency_keys (user_id, key, operation, request_hash, created_at) VALUES
        ($1, 'old-key-0001', 'po.create', $2, now() - interval '31 days'),
        ($1, 'old-key-0002', 'po.create', $2, now() - interval '30 days 1 minute'),
        ($1, 'new-key-0001', 'po.create', $2, now() - interval '29 days')`,
      [userId, hash],
    );
    const cutoff = new Date(Date.now() - 30 * 86_400_000);
    expect(await purgeIdempotencyKeys(t.appDb, cutoff)).toBe(2);
    expect((await t.pool.query('SELECT key FROM idempotency_keys ORDER BY key')).rows.map((r) => r.key)).toEqual(['new-key-0001']);
    expect(await purgeIdempotencyKeys(t.appDb, cutoff)).toBe(0);
  });
});
