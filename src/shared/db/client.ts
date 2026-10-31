import 'server-only';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { getEnv } from '@/shared/env';
import { describeError, logger } from '@/shared/logger';

let pool: pg.Pool | undefined;
let db: NodePgDatabase | undefined;

/** Lazily creates the shared connection pool on first use. */
export function getDb(): NodePgDatabase {
  if (!db) {
    const env = getEnv();
    pool = new pg.Pool({
      connectionString: env.DATABASE_URL,
      max: env.DATABASE_POOL_MAX,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 15_000,
    });
    // An idle client losing its connection must not crash the process.
    pool.on('error', (error) => {
      logger.error('db.pool_error', { error: describeError(error) });
    });
    db = drizzle({ client: pool });
  }
  return db;
}

export async function closeDb(): Promise<void> {
  const current = pool;
  pool = undefined;
  db = undefined;
  await current?.end();
}
