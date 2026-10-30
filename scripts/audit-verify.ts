/**
 * Verifies a hash-chained audit export (docs/operations.md).
 *   npm run audit:verify -- --file <file> [--expect-last-hash <hash>] [--against-db]
 * Without a database: the file's chain, order, and footer (and the last hash kept elsewhere, if
 * given). With --against-db: also that the database still holds exactly those events, unchanged
 * (DATABASE_URL). Exits 0 when everything checked is intact, 1 otherwise.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const envFile = resolve(import.meta.dirname, '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { values } = parseArgs({ options: { file: { type: 'string' }, 'expect-last-hash': { type: 'string' }, 'against-db': { type: 'boolean' } } });
if (!values.file) {
  console.error('Usage: npm run audit:verify -- --file <file> [--expect-last-hash <hash>] [--against-db]');
  process.exit(1);
}

const { compareExportWithDatabase, exportedEvents, verifyExport } = await import('@/modules/audit');
const lines = readFileSync(resolve(values.file), 'utf8').split('\n');
const result = verifyExport(lines, values['expect-last-hash'] === undefined ? {} : { expectLastHash: values['expect-last-hash'] });
if (!result.ok) {
  console.error(`NOT INTACT: line ${result.line}: ${result.problem}`);
  process.exit(1);
}
console.log(`File intact: ${result.count} events after id ${result.afterId}, up to id ${result.lastId}, last hash ${result.lastHash}.`);

if (values['against-db']) {
  const { closeDb, getDb } = await import('@/shared/db/client');
  try {
    const diff = await compareExportWithDatabase(getDb(), exportedEvents(lines), { afterId: result.afterId, lastId: result.lastId });
    const problems = (['missing', 'changed', 'extra'] as const).filter((k) => diff[k].length > 0);
    if (problems.length > 0) {
      for (const k of problems) console.error(`NOT INTACT: ${k} in the database: ids ${diff[k].join(', ')}`);
      process.exitCode = 1;
    } else {
      console.log('Database matches the export for that range.');
    }
  } finally {
    await closeDb();
  }
}
