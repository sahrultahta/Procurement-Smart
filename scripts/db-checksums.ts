/**
 * Row count and checksum of every table (docs/operations.md), to compare a restored database with
 * the one it was backed up from. The checksum is md5 over the rows' text, sorted, so it does not
 * depend on physical order.
 *   npm run db:checksums -- [--url <postgres URL>]      default: DATABASE_MIGRATION_URL, then DATABASE_URL
 * Prints one line per table ("schema.table rows md5") and a final line for all of them together.
 * Run it as the owner role (the runtime role cannot read every table). Reads only.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';

const envFile = resolve(import.meta.dirname, '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { values } = parseArgs({ options: { url: { type: 'string' } } });
const url = values.url ?? process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('Usage: npm run db:checksums -- [--url <postgres URL>] (or set DATABASE_MIGRATION_URL)');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const tables = await client.query<{ schema: string; name: string }>(
    `SELECT schemaname AS schema, tablename AS name FROM pg_tables
     WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY schemaname, tablename`,
  );
  const all = createHash('md5');
  for (const { schema, name } of tables.rows) {
    const id = `${client.escapeIdentifier(schema)}.${client.escapeIdentifier(name)}`;
    const { rows } = await client.query<{ n: string; sum: string | null }>(
      `SELECT count(*)::text AS n, md5(coalesce(string_agg(t::text, E'\\n' ORDER BY t::text), '')) AS sum FROM ${id} t`,
    );
    const line = `${schema}.${name} ${rows[0]?.n} ${rows[0]?.sum}`;
    all.update(`${line}\n`);
    console.log(line);
  }
  console.log(`ALL ${tables.rows.length} tables ${all.digest('hex')}`);
  await client.query('COMMIT');
} finally {
  await client.end();
}
