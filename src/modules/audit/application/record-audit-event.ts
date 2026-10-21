import 'server-only';
import type { RequestContext } from '@/shared/application/context';
import type { Tx } from '@/shared/db/transaction';
import { assertValidAuditEvent, type AuditEventInput } from '../domain/audit-event';
import { insertAuditEvent } from '../infrastructure/audit-repository';

/**
 * Writes one audit event inside the caller's transaction, so the event commits
 * or rolls back together with the change it describes (ADR 0009 rule 1).
 * Actor, roles, request id, IP, and user agent come from the request context, never from input.
 */
export async function recordAuditEvent(tx: Tx, request: RequestContext, event: AuditEventInput): Promise<void> {
  assertValidAuditEvent(event);
  await insertAuditEvent(tx, {
    actorUserId: request.actor?.userId ?? null,
    actorRoles: request.actor ? [...new Set(request.actor.roles)].sort() : [],
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    changes: event.changes ?? {},
    reason: event.reason ?? null,
    requestId: request.requestId,
    ip: request.ip,
    userAgent: request.userAgent,
  });
}
