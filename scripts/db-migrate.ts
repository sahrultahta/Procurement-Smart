/**
 * Applies db/migrations to DATABASE_MIGRATION_URL (or DATABASE_URL).
 * Run as the schema owner role, never as the runtime app role (ADR 0003).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

const root = resolve(import.meta.dirname, '..');
const envFile = resolve(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_MIGRATION_URL or DATABASE_URL (see .env.example).');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await migrate(drizzle({ client }), { migrationsFolder: resolve(root, 'db/migrations') });
  console.log('Migrations applied.');
} finally {
  await client.end();
}
