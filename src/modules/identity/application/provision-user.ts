import 'server-only';
import { z } from 'zod';
import { auditChanges, recordAuditEvent } from '@/modules/audit';
import type { RequestContext } from '@/shared/application/context';
import type { Tx } from '@/shared/db/transaction';
import { failBusinessRule } from '@/shared/result';
import { DEPARTMENT_SCOPED_ROLES, ROLES } from '../domain/roles';
import {
  findActiveDepartments,
  findUserIdByEmail,
  insertRoleAssignment,
  insertUserWithProfile,
} from '../infrastructure/identity-repository';
import { roleAudit, userAudit } from './audit-policies';

export const departmentCode = z.string().regex(/^[A-Z0-9-]{2,16}$/, 'Use 2-16 uppercase letters, digits, or dashes');
export const userName = z.string().trim().min(1, 'Enter a name').max(120);

export const provisionUserInput = z.strictObject({
  email: z.email().max(254).transform((value) => value.trim().toLowerCase()),
  name: userName,
  departmentCode: departmentCode.nullable(),
  roles: z
    .array(z.strictObject({ role: z.enum(ROLES), departmentCode: departmentCode.nullable() }))
    .max(ROLES.length * 4)
    .refine(
      (roles) => new Set(roles.map((r) => `${r.role}:${r.departmentCode ?? ''}`)).size === roles.length,
      'The same role is listed twice',
    ),
});
export type ProvisionUserInput = z.output<typeof provisionUserInput>;

/**
 * Creates a user with no password (they set one through a one-time link), their
 * profile, and their roles, with audit events, in the caller's transaction.
 * `grantedBy` is the granting user's id, or 'system:bootstrap' / 'system:seed'.
 * Used by the bootstrap and seed scripts now, and by the admin screens in Phase 3b.
 */
export async function provisionUser(
  tx: Tx,
  request: RequestContext,
  input: ProvisionUserInput,
  grantedBy: string,
): Promise<{ userId: string }> {
  if (await findUserIdByEmail(tx, input.email)) failBusinessRule('EMAIL_TAKEN', 'A user with this email already exists.');

  const codes = [input.departmentCode, ...input.roles.map((r) => r.departmentCode)].filter((c): c is string => c !== null);
  const departments = await findActiveDepartments(tx, codes);
  for (const code of codes) {
    if (!departments.has(code)) failBusinessRule('UNKNOWN_DEPARTMENT', `Department ${code} does not exist or is inactive.`);
  }
  for (const role of input.roles) {
    if (role.departmentCode !== null && !DEPARTMENT_SCOPED_ROLES.includes(role.role)) {
      failBusinessRule('ROLE_NOT_SCOPABLE', `The ${role.role} role cannot be limited to a department.`);
    }
  }

  const departmentId = input.departmentCode === null ? null : (departments.get(input.departmentCode) ?? null);
  const userId = await insertUserWithProfile(tx, { email: input.email, name: input.name, departmentId });
  await recordAuditEvent(tx, request, {
    action: 'user.provisioned',
    entityType: 'user',
    entityId: userId,
    changes: auditChanges(userAudit, null, { email: input.email, name: input.name, departmentCode: input.departmentCode }),
  });

  for (const role of input.roles) {
    const assignmentId = await insertRoleAssignment(tx, {
      userId,
      role: role.role,
      departmentId: role.departmentCode === null ? null : (departments.get(role.departmentCode) ?? null),
      grantedBy,
    });
    await recordAuditEvent(tx, request, {
      action: 'role.granted',
      entityType: 'role_assignment',
      entityId: assignmentId,
      changes: auditChanges(roleAudit, null, { userId, role: role.role, departmentCode: role.departmentCode }),
    });
  }
  return { userId };
}
