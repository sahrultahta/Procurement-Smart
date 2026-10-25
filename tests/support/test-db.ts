import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

/** Migrated once per test run by global-setup.ts; every test file clones it (ADR 0011). */
export const TEMPLATE_DB = 'pf_template';
export const TEST_DB_PREFIX = 'pf_test_';
export const APP_ROLE = 'procureflow_app';
export const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../db/migrations');

export function loadDotEnv(): void {
  const file = resolve(import.meta.dirname, '../../.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

function requiredUrl(name: 'TEST_DATABASE_URL' | 'TEST_APP_DATABASE_URL'): string {
  loadDotEnv();
  const url = process.env[name];
  if (!url) {
    throw new Error(
      `${name} is not set. Integration tests need PostgreSQL 18: run "npm run db:local -- start" and "npm run db:local -- ensure-app-role" (see .env.example).`,
    );
  }
  return url;
}

/** Owner-level server connection (creates and drops test databases). */
export function adminUrl(): string {
  return requiredUrl('TEST_DATABASE_URL');
}

/** Runtime-role server connection (procureflow_app): what the application itself uses. */
export function appServerUrl(): string {
  return requiredUrl('TEST_APP_DATABASE_URL');
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
  /** Owner connection: for test setup only (creating probe tables, inspecting rows). */
  pool: pg.Pool;
  db: NodePgDatabase;
  /** procureflow_app connection: run application code through this. */
  appPool: pg.Pool;
  appDb: NodePgDatabase;
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
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  const appPool = new pg.Pool({ connectionString: withDatabase(appServerUrl(), name), max: 20 });
  return {
    name,
    url,
    pool,
    db: drizzle({ client: pool }),
    appPool,
    appDb: drizzle({ client: appPool }),
    drop: async () => {
      await Promise.all([pool.end(), appPool.end()]);
      // A closed app-role connection's backend can outlive pool.end() for a moment, and FORCE may not
      // terminate another role's backend (42501, "permission denied to terminate process"): wait, retry.
      for (let attempt = 1; ; attempt++) {
        try {
          await withAdminClient((admin) => admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(name)} WITH (FORCE)`));
          return;
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code !== '42501' || attempt >= 20) throw error;
          await sleep(100 * attempt);
        }
      }
    },
  };
}

/** Runs `fn` and returns the PostgreSQL SQLSTATE it failed with (or 'none'). */
export async function sqlStateOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'none';
  } catch (error) {
    let current: unknown = error;
    while (current instanceof Error) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === 'string') return code;
      current = (current as { cause?: unknown }).cause;
    }
    throw error;
  }
}
