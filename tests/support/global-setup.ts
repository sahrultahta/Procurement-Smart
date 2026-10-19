import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { MIGRATIONS_DIR, TEMPLATE_DB, TEST_DB_PREFIX, adminUrl, withAdminClient, withDatabase } from './test-db';

/** Recreates and migrates the template database once per integration run. */
export default async function setup(): Promise<void> {
  await withAdminClient(async (admin) => {
    const { rows } = await admin.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE datname = $1 OR starts_with(datname, $2)',
      [TEMPLATE_DB, TEST_DB_PREFIX],
    );
    for (const { datname } of rows) {
      await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(datname)} WITH (FORCE)`);
    }
    await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(TEMPLATE_DB)}`);
  }).catch((error: unknown) => {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(`Integration tests need a reachable PostgreSQL 18 at TEST_DATABASE_URL ("npm run db:local -- start"). Cause: ${cause}`);
  });

  const client = new pg.Client({ connectionString: withDatabase(adminUrl(), TEMPLATE_DB) });
  await client.connect();
  try {
    await migrate(drizzle({ client }), { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    // The template must have no open connections before it can be cloned.
    await client.end();
  }
}
