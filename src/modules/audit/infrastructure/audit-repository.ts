import 'server-only';
import type { Tx } from '@/shared/db/transaction';
import { auditEvents } from './schema';

export type AuditEventRow = typeof auditEvents.$inferInsert;

/** INSERT only: the runtime role has no UPDATE/DELETE on audit_events (ADR 0009). */
export async function insertAuditEvent(tx: Tx, row: AuditEventRow): Promise<void> {
  await tx.insert(auditEvents).values(row);
}
