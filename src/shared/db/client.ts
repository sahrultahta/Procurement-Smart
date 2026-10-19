import 'server-only';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { getEnv } from '@/shared/env';

let pool: pg.Pool | undefined;
let db: NodePgDatabase | undefined;

/** Lazily creates the shared connection pool on first use. */
export function getDb(): NodePgDatabase {
  if (!db) {
    pool = new pg.Pool({
      connectionString: getEnv().DATABASE_URL,
      max: 10,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 15_000,
    });
    // An idle client losing its connection must not crash the process.
    pool.on('error', (error) => {
      console.error(JSON.stringify({ level: 'error', msg: 'db.pool_error', error: error.message }));
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
