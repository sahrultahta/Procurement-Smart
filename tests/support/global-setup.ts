import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { APP_ROLE, MIGRATIONS_DIR, TEMPLATE_DB, TEST_DB_PREFIX, adminUrl, appServerUrl, withAdminClient, withDatabase } from './test-db';

/** Recreates and migrates the template database once per integration run. */
export default async function setup(): Promise<void> {
  appServerUrl(); // fail early with a clear message if the runtime-role URL is missing
  await withAdminClient(async (admin) => {
    const role = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP_ROLE]);
    if (role.rowCount === 0) {
      throw new Error(`Role ${APP_ROLE} is missing. Run "npm run db:local -- ensure-app-role" (local) or "npm run db:app-role" (CI).`);
    }
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
