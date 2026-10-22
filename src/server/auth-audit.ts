import 'server-only';
import { createHash } from 'node:crypto';
import { recordAuditEvent } from '@/modules/audit';
import { resolveActor } from '@/modules/identity';
import { createRequestContext } from '@/shared/application/context';
import type { Database } from '@/shared/db/transaction';

/**
 * Audit events for authentication (P3a-AC12, ADR 0009 rule 3). Better Auth writes its
 * own rows outside our transactions, so these events are written from its hooks.
 * Passwords and tokens never reach this code; failed sign-ins record only a
 * fingerprint of the attempted email, not the email itself.
 */
type AuthEvent =
  | {
      action: 'auth.signedIn' | 'auth.signInRejected' | 'auth.signedOut' | 'auth.passwordSet' | 'auth.passwordChanged';
      userId: string;
    }
  | { action: 'auth.signInFailed'; emailFingerprint: string };

type HookContext = { headers?: Headers | undefined; request?: Request | undefined } | null | undefined;

export function emailFingerprint(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 32);
}

function headersOf(context: HookContext): Headers | undefined {
  return context?.headers ?? context?.request?.headers;
}

export async function auditAuthEvent(db: Database, context: HookContext, event: AuthEvent): Promise<void> {
  const headers = headersOf(context);
  const forwarded = headers?.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const actor = 'userId' in event ? await resolveActor(db, event.userId) : null;
  const request = createRequestContext({
    // The actor snapshot for the user the event is about (null for unknown users).
    actor: actor ?? ('userId' in event ? { userId: event.userId, roles: [], permissions: new Set() } : null),
    requestId: headers?.get('x-request-id') ?? null,
    ip: forwarded,
    userAgent: headers?.get('user-agent') ?? null,
  });
  await db.transaction((tx) =>
    recordAuditEvent(
      tx,
      request,
      'userId' in event
        ? { action: event.action, entityType: 'user', entityId: event.userId }
        : { action: event.action, entityType: 'sign_in', entityId: `email:${event.emailFingerprint}` },
    ),
  );
}
