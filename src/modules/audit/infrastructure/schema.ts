import { sql } from 'drizzle-orm';
import { bigint, check, index, inet, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { AuditChanges } from '../domain/audit-event';

/*
 * Table declaration only (no I/O), so drizzle-kit can load it; hence no `server-only`.
 * Append-only enforcement (grants + triggers) lives in db/migrations/0002_*.sql (ADR 0009).
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    actorUserId: text('actor_user_id'),
    actorRoles: text('actor_roles').array().notNull().default(sql`'{}'::text[]`),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    changes: jsonb('changes').$type<AuditChanges>().notNull().default(sql`'{}'::jsonb`),
    reason: text('reason'),
    requestId: uuid('request_id'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [
    index('audit_events_entity_idx').on(t.entityType, t.entityId, t.occurredAt),
    index('audit_events_actor_idx').on(t.actorUserId, t.occurredAt),
    index('audit_events_occurred_at_idx').on(t.occurredAt),
    index('audit_events_action_idx').on(t.action, t.occurredAt),
    check('audit_events_action_format', sql`${t.action} ~ '^[a-z][a-zA-Z0-9]*(\\.[a-z][a-zA-Z0-9]*)+$'`),
    check('audit_events_entity_type_format', sql`${t.entityType} ~ '^[a-z][a-z_]{0,63}$'`),
    check('audit_events_entity_id_length', sql`char_length(${t.entityId}) BETWEEN 1 AND 128`),
    check('audit_events_actor_user_id_length', sql`${t.actorUserId} IS NULL OR char_length(${t.actorUserId}) <= 128`),
    check('audit_events_reason_length', sql`${t.reason} IS NULL OR char_length(${t.reason}) <= 2000`),
    check('audit_events_user_agent_length', sql`${t.userAgent} IS NULL OR char_length(${t.userAgent}) <= 512`),
    check('audit_events_changes_is_object', sql`jsonb_typeof(${t.changes}) = 'object'`),
  ],
);
