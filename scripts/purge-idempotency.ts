/**
 * Deletes idempotency keys older than N days (default 30), as the runtime role (docs/operations.md).
 *   npm run maintenance:purge-idempotency -- [--older-than-days 30]
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const envFile = resolve(import.meta.dirname, '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { values } = parseArgs({ options: { 'older-than-days': { type: 'string' } } });
const days = Number(values['older-than-days'] ?? '30');
if (!Number.isInteger(days) || days < 1 || days > 3650) {
  console.error('Usage: npm run maintenance:purge-idempotency -- [--older-than-days <1 to 3650, default 30>]');
  process.exit(1);
}

const { purgeIdempotencyKeys } = await import('@/shared/db/idempotency');
const { closeDb, getDb } = await import('@/shared/db/client');
try {
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const deleted = await purgeIdempotencyKeys(getDb(), cutoff);
  console.log(`Deleted ${deleted} idempotency keys created before ${cutoff.toISOString()}.`);
} finally {
  await closeDb();
}
