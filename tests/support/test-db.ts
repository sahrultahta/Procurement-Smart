import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

/** Migrated once per test run by global-setup.ts; every test file clones it (ADR 0011). */
export const TEMPLATE_DB = 'pf_template';
export const TEST_DB_PREFIX = 'pf_test_';
export const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../db/migrations');

export function loadDotEnv(): void {
  const file = resolve(import.meta.dirname, '../../.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

export function adminUrl(): string {
  loadDotEnv();
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Integration tests need PostgreSQL 18: run "npm run db:local -- init" (or start it) and see .env.example.',
    );
  }
  return url;
}

export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

export async function withAdminClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export type TestDatabase = {
  name: string;
  url: string;
  pool: pg.Pool;
  db: NodePgDatabase;
  drop: () => Promise<void>;
};

export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `${TEST_DB_PREFIX}${process.pid}_${randomBytes(4).toString('hex')}`;
  await withAdminClient(async (admin) => {
    // Concurrent clones of one template can briefly report "object in use" (55006); retry.
    for (let attempt = 1; ; attempt++) {
      try {
        await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(name)} TEMPLATE ${admin.escapeIdentifier(TEMPLATE_DB)}`);
        return;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== '55006' || attempt >= 20) throw error;
        await sleep(100 * attempt);
      }
    }
  });
  const url = withDatabase(adminUrl(), name);
  const pool = new pg.Pool({ connectionString: url, max: 20 });
  return {
    name,
    url,
    pool,
    db: drizzle({ client: pool }),
    drop: async () => {
      await pool.end();
      await withAdminClient((admin) => admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(name)} WITH (FORCE)`));
    },
  };
}
