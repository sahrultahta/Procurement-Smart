/**
 * Pure audit rules (ADR 0009): event shape, validation, and the per-entity
 * allowlist that decides which fields may ever appear in `changes`.
 */
export type AuditValue = string | number | boolean | null | readonly string[];
/** field → [before, after] */
export type AuditChanges = Readonly<Record<string, readonly [AuditValue, AuditValue]>>;

export type AuditEventInput = {
  /** Past-tense event name, e.g. 'requisition.submitted'. */
  action: string;
  entityType: string;
  entityId: string;
  changes?: AuditChanges;
  reason?: string;
};

export const REDACTED = '[redacted]';

const ACTION_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;
const ENTITY_TYPE_PATTERN = /^[a-z][a-z_]{0,63}$/;

/** Throws on a malformed event: that is a programming error, not user input. */
export function assertValidAuditEvent(event: AuditEventInput): void {
  if (!ACTION_PATTERN.test(event.action)) throw new Error(`Invalid audit action: ${event.action}`);
  if (!ENTITY_TYPE_PATTERN.test(event.entityType)) throw new Error(`Invalid audit entity type: ${event.entityType}`);
  if (event.entityId.length < 1 || event.entityId.length > 128) throw new Error('Audit entity id must be 1-128 characters');
  if (event.reason !== undefined && event.reason.length > 2000) throw new Error('Audit reason exceeds 2000 characters');
  for (const [field, pair] of Object.entries(event.changes ?? {})) {
    if (pair.length !== 2 || !pair.every(isAuditValue)) throw new Error(`Invalid audit change for field ${field}`);
  }
}

function isAuditValue(value: unknown): value is AuditValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export type AuditPolicy<T> = {
  readonly entityType: string;
  /** Fields recorded with their values. */
  readonly fields: readonly (keyof T & string)[];
  /** Fields whose change is recorded, but never their value (e.g. credentials). */
  readonly redacted: readonly (keyof T & string)[];
};

export function defineAuditPolicy<T>(policy: {
  entityType: string;
  fields: readonly (keyof T & string)[];
  redacted?: readonly (keyof T & string)[];
}): AuditPolicy<T> {
  const overlap = policy.fields.filter((field) => policy.redacted?.includes(field));
  if (overlap.length > 0) throw new Error(`Audit fields cannot also be redacted: ${overlap.join(', ')}`);
  return { entityType: policy.entityType, fields: policy.fields, redacted: policy.redacted ?? [] };
}

/**
 * Builds `changes` for a create (before = null), update, or delete (after = null).
 * Only fields named in the policy can appear. Everything else is ignored.
 */
export function auditChanges<T>(policy: AuditPolicy<T>, before: Partial<T> | null, after: Partial<T> | null): AuditChanges {
  const changes: Record<string, readonly [AuditValue, AuditValue]> = {};
  for (const field of policy.fields) {
    const from = normalize(before?.[field]);
    const to = normalize(after?.[field]);
    if (JSON.stringify(from) !== JSON.stringify(to)) changes[field] = [from, to];
  }
  for (const field of policy.redacted) {
    const from = before?.[field];
    const to = after?.[field];
    if (JSON.stringify(normalize(from)) !== JSON.stringify(normalize(to))) {
      changes[field] = [from === undefined || from === null ? null : REDACTED, to === undefined || to === null ? null : REDACTED];
    }
  }
  return changes;
}

function normalize(value: unknown): AuditValue {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (isAuditValue(value)) return value;
  throw new Error('Audit values must be strings, numbers, booleans, dates, null, or string arrays');
}
