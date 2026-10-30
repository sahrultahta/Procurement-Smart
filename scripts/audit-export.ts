/**
 * Exports the audit trail as a hash-chained JSON Lines file (docs/operations.md).
 *   npm run audit:export -- --out <file>                                   everything
 *   npm run audit:export -- --out <file> --after-id <id> --previous-hash <hash>   continue a chain
 * Prints the event count, last id, and last hash. Keep the last hash somewhere other than the file
 * (it is what proves the file was not rewritten), and pass both to the next export.
 * Reads as DATABASE_URL (the runtime role can read audit_events); writes nothing to the database.
 */
import { createWriteStream, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const envFile = resolve(import.meta.dirname, '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { values } = parseArgs({ options: { out: { type: 'string' }, 'after-id': { type: 'string' }, 'previous-hash': { type: 'string' } } });
const usage = 'Usage: npm run audit:export -- --out <file> [--after-id <id> --previous-hash <64 hex characters>]';
if (!values.out) {
  console.error(usage);
  process.exit(1);
}
const afterId = values['after-id'] ?? '0';
const continuing = values['after-id'] !== undefined || values['previous-hash'] !== undefined;
if (!/^(0|[1-9][0-9]{0,18})$/.test(afterId) || (continuing && !/^[0-9a-f]{64}$/.test(values['previous-hash'] ?? ''))) {
  console.error(`${usage}\n--after-id and --previous-hash go together: the last id and last hash of the previous export.`);
  process.exit(1);
}
const out = resolve(values.out);
if (existsSync(out)) {
  console.error(`${out} already exists; an export never overwrites a file.`);
  process.exit(1);
}

const { exportAuditEvents, GENESIS_HASH } = await import('@/modules/audit');
const { closeDb, getDb } = await import('@/shared/db/client');

const stream = createWriteStream(out, { flags: 'wx', encoding: 'utf8' });
const write = (line: string) =>
  new Promise<void>((done, fail) => {
    stream.write(`${line}\n`, (error) => (error ? fail(error) : done()));
  });
try {
  const footer = await exportAuditEvents(getDb(), { afterId, previousHash: values['previous-hash'] ?? GENESIS_HASH, exportedAt: new Date() }, write);
  await new Promise<void>((done) => stream.end(done));
  console.log(`Exported ${footer.count} audit events to ${out}.`);
  console.log(`Last id: ${footer.lastId}`);
  console.log(`Last hash: ${footer.lastHash}`);
  console.log('Keep the last hash outside this file; give both to the next export (--after-id, --previous-hash).');
} finally {
  await closeDb();
}
