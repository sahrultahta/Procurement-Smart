import 'server-only';
import { and, asc, eq, inArray, or } from 'drizzle-orm';
import type { Database, Tx } from '@/shared/db/transaction';
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
