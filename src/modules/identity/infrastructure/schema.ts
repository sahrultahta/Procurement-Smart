import { sql } from 'drizzle-orm';
import { boolean, check, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth-schema';

/*
 * ProcureFlow's own identity tables (docs/schema.md, ADR 0006).
 * Declarations only (no I/O, no `server-only`), so drizzle-kit can load this file.
 */
const tz = { withTimezone: true, mode: 'date' } as const;

export const departments = pgTable(
  'departments',
  {
    id: uuid('id').default(sql`uuidv7()`).primaryKey(),
    code: text('code').notNull().unique(),
    name: text('name').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    check('departments_code_format', sql`${t.code} ~ '^[A-Z0-9-]{2,16}$'`),
    check('departments_name_length', sql`char_length(${t.name}) BETWEEN 1 AND 120`),
  ],
);

export const userProfiles = pgTable(
  'user_profiles',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'restrict' }),
    departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'restrict' }),
    status: text('status').notNull().default('active'),
    deactivatedAt: timestamp('deactivated_at', tz),
    deactivatedByUserId: uuid('deactivated_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    check('user_profiles_status', sql`${t.status} IN ('active', 'deactivated')`),
    check(
      'user_profiles_deactivation_consistent',
      sql`(${t.status} = 'deactivated') = (${t.deactivatedAt} IS NOT NULL AND ${t.deactivatedByUserId} IS NOT NULL)`,
    ),
    // SOD-05 backstop: nobody deactivates themselves.
    check(
      'user_profiles_not_self_deactivated',
      sql`${t.deactivatedByUserId} IS NULL OR ${t.deactivatedByUserId} <> ${t.userId}`,
    ),
  ],
);

export const roleAssignments = pgTable(
  'role_assignments',
  {
    id: uuid('id').default(sql`uuidv7()`).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    role: text('role').notNull(),
    /** NULL = organization-wide. Only department-scoped roles may set it (CHECK). */
    departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'restrict' }),
    /** A user id, or 'system:bootstrap' / 'system:seed' for grants made by scripts. */
    grantedBy: text('granted_by').notNull(),
    grantedAt: timestamp('granted_at', tz).notNull().defaultNow(),
    revokedBy: text('revoked_by'),
    revokedAt: timestamp('revoked_at', tz),
    revokeReason: text('revoke_reason'),
  },
  (t) => [
    check(
      'role_assignments_role',
      sql`${t.role} IN ('admin', 'requester', 'approver', 'procurement', 'receiver', 'finance', 'auditor')`,
    ),
    check('role_assignments_scope', sql`${t.departmentId} IS NULL OR ${t.role} IN ('requester', 'approver')`),
    // SOD-05 backstop: nobody grants a role to themselves.
    check('role_assignments_not_self_granted', sql`${t.grantedBy} <> ${t.userId}::text`),
    check('role_assignments_not_self_revoked', sql`${t.revokedBy} IS NULL OR ${t.revokedBy} <> ${t.userId}::text`),
    check('role_assignments_revocation_consistent', sql`(${t.revokedAt} IS NULL) = (${t.revokedBy} IS NULL)`),
    check('role_assignments_revoke_reason_length', sql`${t.revokeReason} IS NULL OR char_length(${t.revokeReason}) <= 500`),
    uniqueIndex('role_assignments_active_unique')
      .on(t.userId, t.role, sql`coalesce(${t.departmentId}, '00000000-0000-0000-0000-000000000000'::uuid)`)
      .where(sql`${t.revokedAt} IS NULL`),
  ],
);
