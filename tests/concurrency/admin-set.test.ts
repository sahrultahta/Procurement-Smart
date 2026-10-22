import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deactivateUser, grantRole, provisionUser, provisionUserInput, reactivateUser, resolveActor, revokeRole } from '@/modules/identity';
import { ADMIN_SET_LOCK_KEY } from '@/modules/identity/infrastructure/admin-repository';
import { createRequestContext, type RequestContext } from '@/shared/application/context';
import { runCommand } from '@/shared/application/runner';
import type { Result } from '@/shared/result';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/*
 * CC-08 (ADR 0008 C9): two admins removing each other at the same moment must never
 * leave the organization without an admin. X and Y are the only admins here.
 */
let t: TestDatabase;
let x: string;
let y: string;
const ITERATIONS = 20;

beforeAll(async () => {
  t = await createTestDatabase();
  const make = async (email: string, name: string): Promise<string> => {
    const input = provisionUserInput.parse({ email, name, departmentCode: null, roles: [{ role: 'admin', departmentCode: null }] });
    return (await t.appDb.transaction((tx) => provisionUser(tx, createRequestContext({ actor: null }), input, 'system:test'))).userId;
  };
  x = await make('xavier@example.com', 'Xavier Admin');
  y = await make('yuki@example.com', 'Yuki Admin');
});

afterAll(async () => {
  await t?.drop();
});

async function contextFor(userId: string): Promise<RequestContext> {
  const actor = await resolveActor(t.appDb, userId);
  if (!actor) throw new Error(`${userId} is not active`);
  return createRequestContext({ actor });
}

async function activeAdmins(): Promise<string[]> {
  const { rows } = await t.pool.query(
    `SELECT DISTINCT r.user_id::text AS id FROM role_assignments r JOIN user_profiles p ON p.user_id = r.user_id
     WHERE r.role = 'admin' AND r.revoked_at IS NULL AND p.status = 'active'`,
  );
  return rows.map((r: { id: string }) => r.id).sort();
}

const adminAssignment = async (userId: string): Promise<string> =>
  (await t.pool.query("SELECT id FROM role_assignments WHERE user_id = $1 AND role = 'admin' AND revoked_at IS NULL", [userId])).rows[0]
    .id as string;
const version = async (userId: string): Promise<number> =>
  (await t.pool.query('SELECT version FROM user_profiles WHERE user_id = $1', [userId])).rows[0].version as number;

/** Removes `target` from the admins as `actor`, by revoking the role or by deactivating the user. */
async function removal(actor: RequestContext, target: string, how: 'revoke' | 'deactivate'): Promise<() => Promise<Result<unknown>>> {
  if (how === 'revoke') {
    const assignmentId = await adminAssignment(target);
    return () => runCommand(actor, revokeRole, { assignmentId, reason: 'CC-08' }, { db: t.appDb });
  }
  const expectedVersion = await version(target);
  return () => runCommand(actor, deactivateUser, { userId: target, reason: 'CC-08', expectedVersion }, { db: t.appDb });
}

async function waitForLockWaiters(count: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const { rows } = await t.pool.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted");
    if (rows[0].n >= count) return;
    await sleep(10);
  }
  throw new Error(`expected ${count} transactions waiting on the admin-set lock`);
}

describe('CC-08: LAST_ADMIN under concurrency', () => {
  it('negative control: without serialization, check-then-remove loses the last admin', async () => {
    const a = await t.appPool.connect();
    const b = await t.appPool.connect();
    const count = "SELECT count(*)::int AS n FROM role_assignments WHERE role = 'admin' AND revoked_at IS NULL";
    const revoke = "UPDATE role_assignments SET revoked_at = now(), revoked_by = $1 WHERE user_id = $2 AND role = 'admin' AND revoked_at IS NULL";
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      // Both see two admins, so each concludes one will remain...
      expect((await a.query(count)).rows[0].n).toBe(2);
      expect((await b.query(count)).rows[0].n).toBe(2);
      await a.query(revoke, [x, y]);
      await b.query(revoke, [y, x]);
      await a.query('COMMIT');
      await b.query('COMMIT');
    } finally {
      a.release();
      b.release();
    }
    // ...and zero admins remain: the reason every admin command takes the admin-set lock.
    expect(await activeAdmins()).toEqual([]);

    // Restore both admins (test setup, as the owner) for the real test below.
    await t.pool.query(
      "INSERT INTO role_assignments (user_id, role, granted_by) VALUES ($1::uuid, 'admin', 'system:test'), ($2::uuid, 'admin', 'system:test')",
      [x, y],
    );
    expect(await activeAdmins()).toEqual([x, y].sort());
  });

  it(`keeps exactly one admin when both remove each other at once (${ITERATIONS} forced overlaps)`, async () => {
    const ways = [
      ['revoke', 'revoke'],
      ['deactivate', 'deactivate'],
      ['revoke', 'deactivate'],
    ] as const;
    for (let i = 0; i < ITERATIONS; i++) {
      const [xHow, yHow] = ways[i % ways.length] ?? ways[0];
      const [ctxX, ctxY] = [await contextFor(x), await contextFor(y)];
      const xRemovesY = await removal(ctxX, y, xHow);
      const yRemovesX = await removal(ctxY, x, yHow);

      // Hold the lock so both commands are authorized and waiting before either proceeds.
      const holder = await t.pool.connect();
      let results: Result<unknown>[];
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock($1::bigint)', [ADMIN_SET_LOCK_KEY]);
        const pending = Promise.all([xRemovesY(), yRemovesX()]);
        await waitForLockWaiters(2);
        await holder.query('COMMIT');
        results = await pending;
      } finally {
        holder.release();
      }

      const succeeded = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok).map((r) => (r.ok ? null : `${r.error.code}${r.error.rule ? `:${r.error.rule}` : ''}`));
      expect(succeeded).toHaveLength(1);
      expect(['FORBIDDEN', 'BUSINESS_RULE:LAST_ADMIN']).toContain(failed[0]);
      const remaining = await activeAdmins();
      expect(remaining).toHaveLength(1);

      // Restore both admins for the next round, through the commands themselves.
      const survivor = remaining[0] ?? '';
      const removed = survivor === x ? y : x;
      const ctx = await contextFor(survivor);
      const status = (await t.pool.query('SELECT status FROM user_profiles WHERE user_id = $1', [removed])).rows[0].status as string;
      const restored =
        status === 'deactivated'
          ? await runCommand(ctx, reactivateUser, { userId: removed, expectedVersion: await version(removed) }, { db: t.appDb })
          : await runCommand(ctx, grantRole, { userId: removed, role: 'admin', departmentCode: null }, { db: t.appDb });
      expect(restored.ok).toBe(true);
      expect(await activeAdmins()).toEqual([x, y].sort());
    }
  });
});
