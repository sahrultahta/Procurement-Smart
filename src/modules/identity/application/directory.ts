import 'server-only';
import type { Database, Tx } from '@/shared/db/transaction';
import { findApproverAssignmentDepartments, listDepartments, type DepartmentRecord } from '../infrastructure/admin-repository';

/*
 * Read-only lookups other modules need (departments by code or id, approver scopes).
 * Results are plain records; callers decide what reaches a client.
 */

export type { DepartmentRecord };

/** All departments, active or not. The table is small (one row per department). */
export async function findDepartmentDirectory(db: Database | Tx): Promise<DepartmentRecord[]> {
  return listDepartments(db);
}

export type ApproverScope = { organizationWide: boolean; departmentIds: string[] };

/**
 * Where a user holds an active `approver` assignment (ADR 0006): org-wide, or the listed
 * departments. A deactivated profile has no scope at all.
 */
export async function findApproverScope(db: Database | Tx, userId: string): Promise<ApproverScope> {
  const scopes = await findApproverAssignmentDepartments(db, userId);
  return {
    organizationWide: scopes.includes(null),
    departmentIds: scopes.filter((id): id is string => id !== null),
  };
}
