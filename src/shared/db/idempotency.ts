import 'server-only';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { failBusinessRule } from '../result';
import { idempotencyKeys } from './tables';
import type { Tx } from './transaction';

/** Optional field of every `*.create` command (docs/api-contracts.md). */
export const idempotencyKeyField = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,100}$/, 'Invalid idempotency key')
  .optional();

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Runs `create` at most once per (user, key) (ADR 0008 C6), inside the caller's transaction.
 *
 * The key row is claimed first. A concurrent request with the same key blocks on that
 * row's unique index until the first transaction ends: after a commit it reads the stored
 * response; after a rollback it claims the key itself. The same key with a different input
 * is refused (`IDEMPOTENCY_KEY_REUSED`), so a key can never return someone else's result.
 * Without a key, `create` simply runs.
 */
export async function withIdempotency<T>(
  tx: Tx,
  scope: { userId: string; key: string | undefined; operation: string; input: unknown },
  create: () => Promise<T>,
): Promise<T> {
  if (scope.key === undefined) return create();
  const requestHash = createHash('sha256').update(canonical(scope.input)).digest('hex');
  const claimed = await tx
    .insert(idempotencyKeys)
    .values({ userId: scope.userId, key: scope.key, operation: scope.operation, requestHash })
    .onConflictDoNothing()
    .returning({ key: idempotencyKeys.key });

  if (claimed.length === 0) {
    const [existing] = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.userId, scope.userId), eq(idempotencyKeys.key, scope.key)));
    if (!existing || existing.response === null) throw new Error('idempotency key row has no stored response');
    if (existing.operation !== scope.operation || existing.requestHash !== requestHash) {
      failBusinessRule('IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different request. Reload the form and try again.');
    }
    return existing.response as T;
  }

  const result = await create();
  await tx
    .update(idempotencyKeys)
    .set({ response: result as never })
    .where(and(eq(idempotencyKeys.userId, scope.userId), eq(idempotencyKeys.key, scope.key)));
  return result;
}
