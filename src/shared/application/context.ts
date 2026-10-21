import 'server-only';
import { isIP } from 'node:net';
import { isUuid, newRequestId } from '../ids';

/** Permission strings are defined by the identity module (ADR 0006, Phase 3). */
export type Permission = string;

/** The authenticated caller, already resolved from the session by the identity module. */
export type Actor = {
  readonly userId: string;
  /** Role names, for the audit snapshot. */
  readonly roles: readonly string[];
  readonly permissions: ReadonlySet<Permission>;
};

export type RequestContext = {
  readonly requestId: string;
  readonly actor: Actor | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
};

/**
 * Builds a request context from transport values. Untrusted inputs are normalized:
 * a malformed request id is replaced, an invalid IP becomes null, and the user agent
 * is truncated to the audit column limit.
 */
export function createRequestContext(input: {
  actor: Actor | null;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}): RequestContext {
  return {
    requestId: input.requestId && isUuid(input.requestId) ? input.requestId : newRequestId(),
    actor: input.actor,
    ip: input.ip && isIP(input.ip) !== 0 ? input.ip : null,
    userAgent: input.userAgent ? input.userAgent.slice(0, 512) : null,
  };
}
