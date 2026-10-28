import 'server-only';
import type { Database, Tx } from '@/shared/db/transaction';
import type { AuditValue } from '../domain/audit-event';
import { findAuditEventsOf } from '../infrastructure/audit-repository';

/**
 * A document's own audit trail, for its detail page (P9-AC1, decision 6). The document's get query
 * embeds it, so whoever can read the document sees it and nobody else does. Request id, IP address,
 * and user agent are left out: only audit search shows them (decision 8).
 *
 * Audit cannot depend on identity, so the caller passes the user-name lookup.
 */
export type HistoryEntryDto = {
  id: string;
  occurredAt: string;
  /** The actor's name; 'System' when no user acted. */
  actor: string;
  action: string;
  entityType: string;
  changes: { field: string; before: string | null; after: string | null }[];
  reason: string | null;
};
export const HISTORY_ENTRY_KEYS = ['id', 'occurredAt', 'actor', 'action', 'entityType', 'changes', 'reason'] as const;

export type EntityRef = { entityType: string; entityId: string };

/** Most events a history shows: the oldest ones are kept, which is where a document starts. */
export const MAX_HISTORY_ENTRIES = 500;

function valueText(value: AuditValue): string | null {
  if (value === null) return null;
  return Array.isArray(value) ? value.join(', ') : String(value);
}

export async function findEntityHistory(
  db: Database | Tx,
  refs: readonly EntityRef[],
  userNames: (userIds: string[]) => Promise<Map<string, string>>,
): Promise<HistoryEntryDto[]> {
  if (refs.length === 0) return [];
  const rows = await findAuditEventsOf(db, refs, MAX_HISTORY_ENTRIES);
  const names = await userNames([...new Set(rows.flatMap((r) => (r.actorUserId ? [r.actorUserId] : [])))]);
  return rows.map((row) => ({
    id: String(row.id),
    occurredAt: row.occurredAt.toISOString(),
    actor: row.actorUserId === null ? 'System' : (names.get(row.actorUserId) ?? 'Unknown user'),
    action: row.action,
    entityType: row.entityType,
    changes: Object.entries(row.changes)
      .map(([field, [before, after]]) => ({ field, before: valueText(before), after: valueText(after) }))
      .sort((a, b) => a.field.localeCompare(b.field)),
    reason: row.reason,
  }));
}
