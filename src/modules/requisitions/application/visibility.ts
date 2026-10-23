import 'server-only';
import { findApproverScope } from '@/modules/identity';
import type { Actor } from '@/shared/application/context';
import type { Tx } from '@/shared/db/transaction';
import type { Visibility } from '../infrastructure/requisition-repository';

/** Any one of these lets a caller list requisitions; which ones they see depends on which. */
export const READ_PERMISSIONS = ['requisition.read.own', 'requisition.read.department', 'requisition.read.all'] as const;

/**
 * US-PR-05 / ADR 0006: all (procurement, finance, auditor), the departments where the
 * caller holds `approver` (org-wide approver: all), and their own requisitions.
 * Approver scopes are read fresh from the database in the query's transaction.
 */
export async function visibilityFor(tx: Tx, actor: Actor): Promise<Visibility> {
  if (actor.permissions.has('requisition.read.all')) return { all: true };
  let departmentIds: string[] = [];
  if (actor.permissions.has('requisition.read.department')) {
    const scope = await findApproverScope(tx, actor.userId);
    if (scope.organizationWide) return { all: true };
    departmentIds = scope.departmentIds;
  }
  return { all: false, ownerId: actor.permissions.has('requisition.read.own') ? actor.userId : null, departmentIds };
}
