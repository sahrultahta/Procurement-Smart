import 'server-only';
import { z } from 'zod';
import { defineQuery } from '@/shared/application/runner';
import { isUuid } from '@/shared/ids';
import { fail } from '@/shared/result';
import { ROLE_LABELS, isRole } from '../domain/roles';
import {
  findAssignments,
  findUserDetail,
  findUserNames,
  listUsers as listUserRows,
  type AssignmentRow,
  type UserSummaryRow,
} from '../infrastructure/admin-repository';

/*
 * Read models for the admin screens. DTOs are built field by field (threat I-02):
 * no password hashes, tokens, sessions, or Better Auth objects ever leave this file.
 */

export type UserStatus = 'active' | 'deactivated';

export type AdminRoleDto = { role: string; label: string; departmentCode: string | null };

export type AdminUserSummaryDto = {
  id: string;
  name: string;
  email: string;
  status: UserStatus;
  /** False until the user has used their one-time setup link. */
  passwordSet: boolean;
  department: { code: string; name: string } | null;
  roles: AdminRoleDto[];
};
export const ADMIN_USER_SUMMARY_KEYS = ['id', 'name', 'email', 'status', 'passwordSet', 'department', 'roles'] as const;

export type AdminAssignmentDto = {
  id: string;
  role: string;
  label: string;
  departmentCode: string | null;
  grantedAt: string;
  grantedBy: string;
  revokedAt: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
};
export const ADMIN_ASSIGNMENT_KEYS = [
  'id',
  'role',
  'label',
  'departmentCode',
  'grantedAt',
  'grantedBy',
  'revokedAt',
  'revokedBy',
  'revokeReason',
] as const;

export type AdminUserDetailDto = Omit<AdminUserSummaryDto, 'roles'> & {
  version: number;
  createdAt: string;
  deactivatedAt: string | null;
  /** Active assignments first, then the revoked history; newest first within each. */
  assignments: AdminAssignmentDto[];
};
export const ADMIN_USER_DETAIL_KEYS = [
  'id',
  'name',
  'email',
  'status',
  'passwordSet',
  'department',
  'version',
  'createdAt',
  'deactivatedAt',
  'assignments',
] as const;

const PAGE_SIZE_MAX = 100;

// Opaque cursor: the last email of the previous page, base64url-encoded.
const cursor = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,400}$/, 'Invalid cursor')
  .transform((value, ctx) => {
    const email = Buffer.from(value, 'base64url').toString('utf8');
    if (!z.email().safeParse(email).success) {
      ctx.addIssue({ code: 'custom', message: 'Invalid cursor' });
      return z.NEVER;
    }
    return email;
  });

function encodeCursor(email: string): string {
  return Buffer.from(email, 'utf8').toString('base64url');
}

function status(value: string): UserStatus {
  return value === 'active' ? 'active' : 'deactivated';
}

function department(row: Pick<UserSummaryRow, 'departmentCode' | 'departmentName'>): { code: string; name: string } | null {
  return row.departmentCode && row.departmentName ? { code: row.departmentCode, name: row.departmentName } : null;
}

function roleDto(row: Pick<AssignmentRow, 'role' | 'departmentCode'>): AdminRoleDto {
  return { role: row.role, label: isRole(row.role) ? ROLE_LABELS[row.role] : row.role, departmentCode: row.departmentCode };
}

export const listUsers = defineQuery({
  name: 'admin.user.list',
  permission: 'admin.users',
  input: z.strictObject({
    status: z.enum(['active', 'deactivated']).optional(),
    cursor: cursor.optional(),
    limit: z.number().int().min(1).max(PAGE_SIZE_MAX).default(25),
  }),
  handler: async ({ tx }, input): Promise<{ items: AdminUserSummaryDto[]; nextCursor: string | null }> => {
    // One extra row tells us whether another page exists.
    const rows = await listUserRows(tx, { status: input.status, afterEmail: input.cursor, limit: input.limit + 1 });
    const page = rows.slice(0, input.limit);
    const assignments = await findAssignments(
      tx,
      page.map((r) => r.id),
      { includeRevoked: false },
    );
    const items = page.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      status: status(row.status),
      passwordSet: row.passwordSet,
      department: department(row),
      roles: assignments
        .filter((a) => a.userId === row.id)
        .map(roleDto)
        .sort((x, y) => x.role.localeCompare(y.role) || (x.departmentCode ?? '').localeCompare(y.departmentCode ?? '')),
    }));
    const last = page.at(-1);
    return { items, nextCursor: rows.length > input.limit && last ? encodeCursor(last.email) : null };
  },
});

export const getUser = defineQuery({
  name: 'admin.user.get',
  permission: 'admin.users',
  input: z.strictObject({ userId: z.uuid() }),
  handler: async ({ tx }, input): Promise<AdminUserDetailDto> => {
    const row = await findUserDetail(tx, input.userId);
    if (!row) fail('NOT_FOUND', 'User not found.');
    const assignments = await findAssignments(tx, [row.id], { includeRevoked: true });
    const actorIds = assignments.flatMap((a) => [a.grantedBy, a.revokedBy]).filter((id): id is string => id !== null && isUuid(id));
    const names = await findUserNames(tx, [...new Set(actorIds)]);
    // Grants made by scripts are recorded as 'system:bootstrap' / 'system:seed'.
    const who = (id: string): string => names.get(id) ?? (id.startsWith('system:') ? 'System' : 'Unknown user');

    const ordered = [...assignments.filter((a) => a.revokedAt === null), ...assignments.filter((a) => a.revokedAt !== null)];
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      status: status(row.status),
      passwordSet: row.passwordSet,
      department: department(row),
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      deactivatedAt: row.deactivatedAt?.toISOString() ?? null,
      assignments: ordered.map((a) => ({
        id: a.id,
        ...roleDto(a),
        grantedAt: a.grantedAt.toISOString(),
        grantedBy: who(a.grantedBy),
        revokedAt: a.revokedAt?.toISOString() ?? null,
        revokedBy: a.revokedBy === null ? null : who(a.revokedBy),
        revokeReason: a.revokeReason,
      })),
    };
  },
});
