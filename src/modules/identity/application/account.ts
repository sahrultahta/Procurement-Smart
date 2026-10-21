import 'server-only';
import { z } from 'zod';
import { defineQuery } from '@/shared/application/runner';
import { fail } from '@/shared/result';
import { ROLE_LABELS, isRole } from '../domain/roles';
import { findActorRecord } from '../infrastructure/identity-repository';

/**
 * What the browser may see about the signed-in user (threat I-02, P3a-AC11).
 * Built field by field: never a database row or a Better Auth user object.
 */
export type AccountDto = {
  name: string;
  email: string;
  department: { code: string; name: string } | null;
  roles: { role: string; label: string; departmentCode: string | null }[];
  permissions: string[];
};

export const ACCOUNT_DTO_KEYS = ['name', 'email', 'department', 'roles', 'permissions'] as const;

export const getMyAccount = defineQuery({
  name: 'account.me',
  permission: 'account.read',
  input: z.strictObject({}),
  handler: async ({ tx, actor }): Promise<AccountDto> => {
    const record = await findActorRecord(tx, actor.userId);
    if (!record) fail('NOT_FOUND', 'Account not found.');
    return {
      name: record.name,
      email: record.email,
      department: record.department ? { code: record.department.code, name: record.department.name } : null,
      roles: record.assignments
        .filter((a) => isRole(a.role))
        .map((a) => ({
          role: a.role,
          label: isRole(a.role) ? ROLE_LABELS[a.role] : a.role,
          departmentCode: a.department?.code ?? null,
        }))
        .sort((x, y) => x.role.localeCompare(y.role)),
      permissions: [...actor.permissions].sort(),
    };
  },
});
