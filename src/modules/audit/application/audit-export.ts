import 'server-only';
import type { Database, Tx } from '@/shared/db/transaction';
import {
  AUDIT_EXPORT_FORMAT,
  canonicalJson,
  chainHash,
  eventLine,
  footerLine,
  headerLine,
  type ExportFooter,
  type ExportedAuditEvent,
} from './hash-chain';
import { readAuditEventsForExport } from '../infrastructure/audit-repository';

const BATCH = 1000;

/**
 * Writes every audit event with an id above `afterId`, oldest first, as a hash-chained export
 * (hash-chain.ts). Reads in batches; each batch is one query, so run it against a quiet
 * moment or accept that events committed during the export end up in the next one.
 */
export async function exportAuditEvents(
  db: Database | Tx,
  options: { afterId: string; previousHash: string; exportedAt: Date },
  write: (line: string) => Promise<void> | void,
): Promise<ExportFooter> {
  await write(headerLine({ format: AUDIT_EXPORT_FORMAT, afterId: options.afterId, previousHash: options.previousHash, exportedAt: options.exportedAt.toISOString() }));
  let previousHash = options.previousHash;
  let lastId = options.afterId;
  let count = 0;
  for (;;) {
    const batch = await readAuditEventsForExport(db, { afterId: lastId, limit: BATCH });
    for (const event of batch) {
      previousHash = chainHash(previousHash, event);
      await write(eventLine(event, previousHash));
      lastId = event.id;
      count++;
    }
    if (batch.length < BATCH) break;
  }
  const footer = { count, lastId, lastHash: previousHash };
  await write(footerLine(footer));
  return footer;
}

/** The events of an export's lines (header and footer skipped); lines must already verify. */
export function exportedEvents(lines: readonly string[]): ExportedAuditEvent[] {
  const content = lines.at(-1) === '' ? lines.slice(0, -1) : lines;
  return content.slice(1, -1).map((line) => (JSON.parse(line) as { event: ExportedAuditEvent }).event);
}

export type DatabaseComparison = { missing: string[]; changed: string[]; extra: string[] };

/**
 * Compares an export with the database now, for the id range it covers: events no longer in the
 * database (`missing`), different from what was exported (`changed`), or in the range but not in
 * the export (`extra`). All empty: the trail is as it was when exported.
 */
export async function compareExportWithDatabase(db: Database | Tx, events: readonly ExportedAuditEvent[], range: { afterId: string; lastId: string }): Promise<DatabaseComparison> {
  const exported = new Map(events.map((e) => [e.id, canonicalJson(e)]));
  const seen = new Set<string>();
  const result: DatabaseComparison = { missing: [], changed: [], extra: [] };
  let cursor = range.afterId;
  for (;;) {
    const batch = await readAuditEventsForExport(db, { afterId: cursor, limit: BATCH, upToId: range.lastId });
    for (const row of batch) {
      seen.add(row.id);
      const text = exported.get(row.id);
      if (text === undefined) result.extra.push(row.id);
      else if (text !== canonicalJson(row)) result.changed.push(row.id);
      cursor = row.id;
    }
    if (batch.length < BATCH) break;
  }
  for (const id of exported.keys()) if (!seen.has(id)) result.missing.push(id);
  return result;
}
