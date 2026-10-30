import 'server-only';
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import type { Database, Tx } from '@/shared/db/transaction';
import type { ExportedAuditEvent } from '../application/hash-chain';
import { auditEvents } from './schema';

export type AuditEventRow = typeof auditEvents.$inferInsert;

/** INSERT only: the runtime role has no UPDATE/DELETE on audit_events (ADR 0009). */
export async function insertAuditEvent(tx: Tx, row: AuditEventRow): Promise<void> {
  await tx.insert(auditEvents).values(row);
}

/** The events of the given entities, oldest first (uses audit_events_entity_idx). */
export async function findAuditEventsOf(db: Database | Tx, refs: readonly { entityType: string; entityId: string }[], limit: number) {
  const byType = new Map<string, string[]>();
  for (const ref of refs) byType.set(ref.entityType, [...(byType.get(ref.entityType) ?? []), ref.entityId]);
  return db
    .select({
      id: auditEvents.id,
      occurredAt: auditEvents.occurredAt,
      actorUserId: auditEvents.actorUserId,
      action: auditEvents.action,
      entityType: auditEvents.entityType,
      changes: auditEvents.changes,
      reason: auditEvents.reason,
    })
    .from(auditEvents)
    .where(or(...[...byType].map(([type, ids]) => and(eq(auditEvents.entityType, type), inArray(auditEvents.entityId, ids)))))
    .orderBy(asc(auditEvents.id))
    .limit(limit);
}

/**
 * Audit events after `afterId` (and up to `upToId`), oldest first, every value as text: ids as
 * decimal strings, times in UTC with microseconds (whatever the session time zone), IP as text.
 */
export async function readAuditEventsForExport(
  db: Database | Tx,
  range: { afterId: string; limit: number; upToId?: string },
): Promise<ExportedAuditEvent[]> {
  const result = await db.execute(sql`
    SELECT id::text AS id, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt", actor_user_id AS "actorUserId", actor_roles AS "actorRoles",
      action, entity_type AS "entityType", entity_id AS "entityId", changes, reason, request_id::text AS "requestId",
      host(ip) AS ip, user_agent AS "userAgent"
    FROM audit_events
    WHERE id > ${range.afterId}::bigint ${range.upToId === undefined ? sql`` : sql`AND id <= ${range.upToId}::bigint`}
    ORDER BY audit_events.id
    LIMIT ${range.limit}`);
  return result.rows as ExportedAuditEvent[];
}
