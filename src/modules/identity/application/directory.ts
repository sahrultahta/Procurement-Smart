import 'server-only';
import type { Database, Tx } from '@/shared/db/transaction';
import type { Role } from '../domain/roles';
import { findRoleAssignmentDepartments, listDepartments, type DepartmentRecord } from '../infrastructure/admin-repository';

/*
 * Read-only lookups other modules need (departments by code or id, role scopes).
 * Results are plain records; callers decide what reaches a client.
 */

export type { DepartmentRecord };

/** All departments, active or not. The table is small (one row per department). */
export async function findDepartmentDirectory(db: Database | Tx): Promise<DepartmentRecord[]> {
  return listDepartments(db);
}

export type RoleScope = { organizationWide: boolean; departmentIds: string[] };
export type ApproverScope = RoleScope;

/**
 * Where a user holds an active assignment of `role` (ADR 0006): org-wide, or the listed
 * departments. A deactivated profile or a revoked assignment gives no scope at all.
 */
export async function findRoleScope(db: Database | Tx, userId: string, role: Role): Promise<RoleScope> {
  const scopes = await findRoleAssignmentDepartments(db, userId, role);
  return {
    organizationWide: scopes.includes(null),
    departmentIds: scopes.filter((id): id is string => id !== null),
  };
}

export async function findApproverScope(db: Database | Tx, userId: string): Promise<ApproverScope> {
  return findRoleScope(db, userId, 'approver');
}
