import 'server-only';
import { findApproverScope } from '@/modules/identity';
import type { Actor } from '@/shared/application/context';
import type { Tx } from '@/shared/db/transaction';
import type { Visibility } from '../infrastructure/purchase-order-repository';

/** Any one of these lets a caller list purchase orders; which ones they see depends on which. */
export const READ_PERMISSIONS = ['po.read.all', 'po.read.department', 'po.read.issued'] as const;

/**
 * ADR 0006 and its Phase 7 amendment: all (procurement, finance, auditor); the departments where
 * the caller holds `approver` (org-wide approver: all), so whoever may decide a PO's approval
 * step can open it; and issued orders for receivers. Approver scopes are read fresh from the
 * database in the query's transaction.
 */
export async function visibilityFor(tx: Tx, actor: Actor): Promise<Visibility> {
  if (actor.permissions.has('po.read.all')) return { all: true };
  let departmentIds: string[] = [];
  if (actor.permissions.has('po.read.department')) {
    const scope = await findApproverScope(tx, actor.userId);
    if (scope.organizationWide) return { all: true };
    departmentIds = scope.departmentIds;
  }
  return { all: false, departmentIds, issued: actor.permissions.has('po.read.issued') };
}
