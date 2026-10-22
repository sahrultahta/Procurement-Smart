import 'server-only';
import { z } from 'zod';
import { auditChanges, recordAuditEvent } from '@/modules/audit';
import { defineCommand } from '@/shared/application/runner';
import type { Tx } from '@/shared/db/transaction';
import { fail, failBusinessRule } from '@/shared/result';
import {
  deletePasswordSetupTokens,
  deleteUserSessions,
  lockManagedUser,
  setUserStatus,
  updateManagedUser,
  type ManagedUser,
} from '../infrastructure/admin-repository';
import { findActiveDepartments } from '../infrastructure/identity-repository';
import { assertAnotherAdminRemains, assertNotSelf, lockAdministration } from './admin-guards';
import { userAudit, userStatusAudit } from './audit-policies';
import { departmentCode, provisionUser, provisionUserInput, userName } from './provision-user';

/*
 * User administration (US-AD-01, US-ID-03, Phase 3b). Every command takes the admin-set
 * lock first, so these commands never deadlock with each other and the caller's own
 * admin rights are re-checked inside the transaction.
 */

export const versionField = z.number().int().min(1).max(2_147_483_647);
export const reasonField = z.string().trim().min(1, 'Give a reason').max(500);

async function loadUser(tx: Tx, userId: string, expectedVersion?: number): Promise<ManagedUser> {
  const user = await lockManagedUser(tx, userId);
  if (!user) fail('NOT_FOUND', 'User not found.');
  if (expectedVersion !== undefined && user.version !== expectedVersion) {
    fail('CONFLICT', 'This user was changed by someone else. Reload the page and try again.');
  }
  return user;
}

export const createUser = defineCommand({
  name: 'admin.user.create',
  permission: 'admin.users',
  input: provisionUserInput,
  handler: async ({ tx, actor, request }, input): Promise<{ userId: string }> => {
    await lockAdministration(tx, actor, 'admin.users');
    // Initial roles are role grants, so they need admin.roles as well.
    if (input.roles.length > 0 && !actor.permissions.has('admin.roles')) {
      fail('FORBIDDEN', 'You do not have permission to grant roles.');
    }
    return provisionUser(tx, request, input, actor.userId);
  },
});

export const updateUser = defineCommand({
  name: 'admin.user.update',
  permission: 'admin.users',
  input: z.strictObject({
    userId: z.uuid(),
    name: userName,
    departmentCode: departmentCode.nullable(),
    expectedVersion: versionField,
  }),
  handler: async ({ tx, actor, request }, input): Promise<{ version: number }> => {
    assertNotSelf(actor, input.userId);
    await lockAdministration(tx, actor, 'admin.users');
    const user = await loadUser(tx, input.userId, input.expectedVersion);

    let departmentId = user.departmentId;
    if (input.departmentCode !== user.departmentCode) {
      if (input.departmentCode === null) departmentId = null;
      else {
        const found = (await findActiveDepartments(tx, [input.departmentCode])).get(input.departmentCode);
        if (!found) failBusinessRule('UNKNOWN_DEPARTMENT', `Department ${input.departmentCode} does not exist or is inactive.`);
        departmentId = found;
      }
    }
    const before = { name: user.name, departmentCode: user.departmentCode };
    const after = { name: input.name, departmentCode: input.departmentCode };
    const changes = auditChanges(userAudit, before, after);
    if (Object.keys(changes).length === 0) return { version: user.version };

    const version = await updateManagedUser(tx, user.id, user.version, { name: input.name, departmentId });
    await recordAuditEvent(tx, request, { action: 'user.updated', entityType: 'user', entityId: user.id, changes });
    return { version };
  },
});

export const deactivateUser = defineCommand({
  name: 'admin.user.deactivate',
  permission: 'admin.users',
  input: z.strictObject({ userId: z.uuid(), reason: reasonField, expectedVersion: versionField }),
  handler: async ({ tx, actor, request }, input): Promise<{ version: number; revokedSessions: number }> => {
    assertNotSelf(actor, input.userId);
    await lockAdministration(tx, actor, 'admin.users');
    const user = await loadUser(tx, input.userId, input.expectedVersion);
    if (user.status !== 'active') fail('INVALID_TRANSITION', 'This user is already deactivated.');
    await assertAnotherAdminRemains(tx, user.id);

    const version = await setUserStatus(tx, user.id, user.version, { status: 'deactivated', byUserId: actor.userId });
    // Same transaction as the status change (US-ID-03): the next request with any old cookie fails.
    const revokedSessions = await deleteUserSessions(tx, user.id);
    const invalidatedSetupLinks = await deletePasswordSetupTokens(tx, user.id);
    await recordAuditEvent(tx, request, {
      action: 'user.deactivated',
      entityType: 'user',
      entityId: user.id,
      changes: auditChanges(
        userStatusAudit,
        { status: 'active' },
        { status: 'deactivated', revokedSessions, invalidatedSetupLinks },
      ),
      reason: input.reason,
    });
    return { version, revokedSessions };
  },
});

export const reactivateUser = defineCommand({
  name: 'admin.user.reactivate',
  permission: 'admin.users',
  input: z.strictObject({ userId: z.uuid(), expectedVersion: versionField }),
  handler: async ({ tx, actor, request }, input): Promise<{ version: number }> => {
    assertNotSelf(actor, input.userId);
    await lockAdministration(tx, actor, 'admin.users');
    const user = await loadUser(tx, input.userId, input.expectedVersion);
    if (user.status === 'active') fail('INVALID_TRANSITION', 'This user is already active.');

    const version = await setUserStatus(tx, user.id, user.version, { status: 'active' });
    await recordAuditEvent(tx, request, {
      action: 'user.reactivated',
      entityType: 'user',
      entityId: user.id,
      changes: auditChanges(userStatusAudit, { status: 'deactivated' }, { status: 'active' }),
    });
    return { version };
  },
});

/**
 * Prepares a new one-time password-setup link: only for an active user who has never
 * set a password, so an admin cannot take over an account that is already in use.
 * Earlier unused links stop working. The token itself is issued by Better Auth after
 * this transaction commits (src/server/admin-links.ts), because Better Auth uses its
 * own connection and must see the committed user.
 */
export const prepareSetupLink = defineCommand({
  name: 'admin.user.issueSetupLink',
  permission: 'admin.users',
  input: z.strictObject({ userId: z.uuid() }),
  handler: async ({ tx, actor, request }, input): Promise<{ email: string }> => {
    assertNotSelf(actor, input.userId);
    await lockAdministration(tx, actor, 'admin.users');
    const user = await loadUser(tx, input.userId);
    if (user.status !== 'active') failBusinessRule('USER_DEACTIVATED', 'Reactivate this user before issuing a link.');
    if (user.passwordSet) {
      failBusinessRule('PASSWORD_ALREADY_SET', 'This user has already set a password. Setup links are only for new accounts.');
    }
    const invalidatedSetupLinks = await deletePasswordSetupTokens(tx, user.id);
    await recordAuditEvent(tx, request, {
      action: 'user.setupLinkIssued',
      entityType: 'user',
      entityId: user.id,
      changes: auditChanges(userStatusAudit, null, { invalidatedSetupLinks }),
    });
    return { email: user.email };
  },
});
