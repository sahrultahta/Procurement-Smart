/**
 * Drops and recreates the E2E database (pf_e2e only) and applies every migration.
 * Playwright runs this right before `next start` (playwright.config.ts), because its
 * web server starts before global setup. Needs TEST_DATABASE_URL (a role with CREATEDB).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { E2E_DATABASE, withDatabase } from './lib/e2e-database.ts';

const root = resolve(import.meta.dirname, '..');
const envFile = resolve(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run with NODE_ENV=production.');
  process.exit(1);
}
const adminUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl) {
  console.error('TEST_DATABASE_URL is not set (see .env.example).');
  process.exit(1);
}

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
try {
  const name = admin.escapeIdentifier(E2E_DATABASE);
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
} finally {
  await admin.end();
}

const client = new pg.Client({ connectionString: withDatabase(adminUrl, E2E_DATABASE) });
await client.connect();
try {
  await migrate(drizzle({ client }), { migrationsFolder: resolve(root, 'db/migrations') });
} finally {
  await client.end();
}
console.log(`E2E database ${E2E_DATABASE} recreated and migrated.`);
