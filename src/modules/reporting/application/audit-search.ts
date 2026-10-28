import 'server-only';
import { z } from 'zod';
import { defineQuery } from '@/shared/application/runner';
import { listUsers, searchAuditEvents } from '../infrastructure/report-views';
import { dateRangeShape, checkDateRange } from './report-input';

/*
 * Audit search (P9-AC1, decision 7): `audit.read` only (auditor, admin). The only place where
 * request id, IP address, and user agent are shown (decision 8).
 */

export const AUDIT_ENTITY_TYPES = [
  'requisition',
  'approval_request',
  'rfq',
  'quotation',
  'purchase_order',
  'goods_receipt',
  'supplier',
  'user',
  'role_assignment',
  'department',
  'org_settings',
  'approval_policy',
  'sign_in',
] as const;

export type AuditChangeDto = { field: string; before: string | null; after: string | null };

export type AuditEventDto = {
  id: string;
  occurredAt: string;
  /** The actor's name; 'System' when no user acted. */
  actor: string;
  actorRoles: string[];
  action: string;
  entityType: string;
  entityId: string;
  changes: AuditChangeDto[];
  reason: string | null;
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
};
export const AUDIT_EVENT_KEYS = [
  'id',
  'occurredAt',
  'actor',
  'actorRoles',
  'action',
  'entityType',
  'entityId',
  'changes',
  'reason',
  'requestId',
  'ip',
  'userAgent',
] as const;

/** An audit value as text: lists joined with ', ', null as null. */
export function auditValueText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(String).join(', ');
  return String(value);
}

export const searchAudit = defineQuery({
  name: 'audit.search',
  permission: 'audit.read',
  input: z
    .strictObject({
      entityType: z.enum(AUDIT_ENTITY_TYPES).optional(),
      entityId: z.string().trim().min(1).max(128).optional(),
      actorUserId: z.uuid().optional(),
      action: z
        .string()
        .trim()
        .regex(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/, 'Enter an action such as po.issued')
        .optional(),
      ...dateRangeShape(false),
      cursor: z
        .string()
        .regex(/^[1-9][0-9]{0,17}$/, 'Invalid cursor')
        .optional(),
      limit: z.number().int().min(1).max(100).default(50),
    })
    .superRefine(checkDateRange),
  handler: async ({ tx }, input): Promise<{ items: AuditEventDto[]; nextCursor: string | null }> => {
    const rows = await searchAuditEvents(tx, {
      entityType: input.entityType,
      entityId: input.entityId,
      actorUserId: input.actorUserId,
      action: input.action,
      from: input.from,
      to: input.to,
      beforeId: input.cursor,
      limit: input.limit + 1,
    });
    const page = rows.slice(0, input.limit);
    return {
      items: page.map((row) => ({
        id: row.id,
        occurredAt: new Date(row.occurredAt).toISOString(),
        actor: row.actorUserId === null ? 'System' : (row.actorName ?? 'Unknown user'),
        actorRoles: row.actorRoles,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        changes: Object.entries(row.changes)
          .map(([field, [before, after]]) => ({ field, before: auditValueText(before), after: auditValueText(after) }))
          .sort((a, b) => a.field.localeCompare(b.field)),
        reason: row.reason,
        requestId: row.requestId,
        ip: row.ip,
        userAgent: row.userAgent,
      })),
      nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
    };
  },
});

/** The people the audit search can filter by. */
export const auditFilterOptions = defineQuery({
  name: 'audit.filterOptions',
  permission: 'audit.read',
  input: z.strictObject({}),
  handler: async ({ tx }): Promise<{ entityTypes: readonly string[]; users: { id: string; name: string }[] }> => ({
    entityTypes: AUDIT_ENTITY_TYPES,
    users: await listUsers(tx),
  }),
});
