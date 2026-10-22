import 'server-only';
import { z } from 'zod';
import { auditChanges, recordAuditEvent } from '@/modules/audit';
import { defineCommand } from '@/shared/application/runner';
import { fail, failBusinessRule } from '@/shared/result';
import { DEPARTMENT_SCOPED_ROLES, ROLES } from '../domain/roles';
import {
  findActiveAssignmentId,
  lockAssignment,
  lockManagedUser,
  revokeAssignment,
} from '../infrastructure/admin-repository';
import { findActiveDepartments, insertRoleAssignment } from '../infrastructure/identity-repository';
import { assertAnotherAdminRemains, assertNotSelf, lockAdministration } from './admin-guards';
import { reasonField } from './admin-users';
import { roleAudit } from './audit-policies';
import { departmentCode } from './provision-user';

/*
 * Role administration (US-AD-02). Assignments are history: revoking updates the row
 * once (a trigger forbids any other change) and never deletes it.
 */

export const grantRole = defineCommand({
  name: 'admin.role.grant',
  permission: 'admin.roles',
  input: z.strictObject({ userId: z.uuid(), role: z.enum(ROLES), departmentCode: departmentCode.nullable() }),
  handler: async ({ tx, actor, request }, input): Promise<{ assignmentId: string }> => {
    assertNotSelf(actor, input.userId);
    await lockAdministration(tx, actor, 'admin.roles');
    const user = await lockManagedUser(tx, input.userId);
    if (!user) fail('NOT_FOUND', 'User not found.');
    if (user.status !== 'active') failBusinessRule('USER_DEACTIVATED', 'Reactivate this user before granting roles.');

    let departmentId: string | null = null;
    if (input.departmentCode !== null) {
      if (!DEPARTMENT_SCOPED_ROLES.includes(input.role)) {
        failBusinessRule('ROLE_NOT_SCOPABLE', `The ${input.role} role cannot be limited to a department.`);
      }
      const found = (await findActiveDepartments(tx, [input.departmentCode])).get(input.departmentCode);
      if (!found) failBusinessRule('UNKNOWN_DEPARTMENT', `Department ${input.departmentCode} does not exist or is inactive.`);
      departmentId = found;
    }
    if (await findActiveAssignmentId(tx, user.id, input.role, departmentId)) {
      failBusinessRule('ROLE_ALREADY_ASSIGNED', 'This user already has this role with this scope.');
    }

    const assignmentId = await insertRoleAssignment(tx, {
      userId: user.id,
      role: input.role,
      departmentId,
      grantedBy: actor.userId,
    });
    await recordAuditEvent(tx, request, {
      action: 'role.granted',
      entityType: 'role_assignment',
      entityId: assignmentId,
      changes: auditChanges(roleAudit, null, { userId: user.id, role: input.role, departmentCode: input.departmentCode }),
    });
    return { assignmentId };
  },
});

export const revokeRole = defineCommand({
  name: 'admin.role.revoke',
  permission: 'admin.roles',
  input: z.strictObject({ assignmentId: z.uuid(), reason: reasonField }),
  handler: async ({ tx, actor, request }, input): Promise<{ assignmentId: string }> => {
    await lockAdministration(tx, actor, 'admin.roles');
    const assignment = await lockAssignment(tx, input.assignmentId);
    if (!assignment) fail('NOT_FOUND', 'Role assignment not found.');
    assertNotSelf(actor, assignment.userId);
    if (assignment.revokedAt !== null) fail('INVALID_TRANSITION', 'This role assignment is already revoked.');
    if (assignment.role === 'admin') await assertAnotherAdminRemains(tx, assignment.userId);

    await revokeAssignment(tx, assignment.id, actor.userId, input.reason);
    await recordAuditEvent(tx, request, {
      action: 'role.revoked',
      entityType: 'role_assignment',
      entityId: assignment.id,
      changes: auditChanges(
        roleAudit,
        { userId: assignment.userId, role: assignment.role, departmentCode: assignment.departmentCode },
        null,
      ),
      reason: input.reason,
    });
    return { assignmentId: assignment.id };
  },
});
