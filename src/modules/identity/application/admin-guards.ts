import 'server-only';
import type { Actor } from '@/shared/application/context';
import type { Tx } from '@/shared/db/transaction';
import { fail, failBusinessRule } from '@/shared/result';
import type { Permission } from '../domain/roles';
import { findActiveAdminUserIds, lockAdminSet } from '../infrastructure/admin-repository';
import { resolveActor } from './actor';

/** SOD-05: administrators never change their own account or roles (ADR 0006). */
export function assertNotSelf(actor: Actor, targetUserId: string): void {
  if (actor.userId === targetUserId) {
    failBusinessRule('SELF_ADMINISTRATION', 'You cannot change your own account or roles. Ask another administrator.');
  }
}

/**
 * Takes the admin-set lock, then re-checks that the caller still holds `permission`.
 * The actor was resolved when the request started; another admin may have removed
 * them since. Under the lock that can no longer change until this transaction ends.
 */
export async function lockAdministration(tx: Tx, actor: Actor, permission: Permission): Promise<void> {
  await lockAdminSet(tx);
  const current = await resolveActor(tx, actor.userId);
  if (!current?.permissions.has(permission)) fail('FORBIDDEN', 'You do not have permission to perform this action.');
}

/**
 * LAST_ADMIN: removing `userId` from the admins must leave at least one active admin.
 * Call it only while holding the admin-set lock.
 */
export async function assertAnotherAdminRemains(tx: Tx, userId: string): Promise<void> {
  const admins = await findActiveAdminUserIds(tx);
  if (!admins.some((id) => id !== userId)) {
    failBusinessRule('LAST_ADMIN', 'At least one active administrator must remain.');
  }
}
