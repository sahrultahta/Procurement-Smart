import 'server-only';
import type { Actor } from '@/shared/application/context';
import type { Database, Tx } from '@/shared/db/transaction';
import { isRole, permissionsForRoles, type Role } from '../domain/roles';
import { findActorRecord } from '../infrastructure/identity-repository';

export type RoleAssignmentView = { readonly role: Role; readonly departmentId: string | null };

/** The authenticated caller as the rest of the application sees it. */
export type IdentityActor = Omit<Actor, 'roles'> & {
  readonly roles: readonly Role[];
  readonly email: string;
  readonly name: string;
  readonly departmentId: string | null;
  readonly assignments: readonly RoleAssignmentView[];
};

/**
 * Loads the actor for a session's user id. Returns null when the user has no
 * profile or the profile is deactivated, so a deactivated user is treated as
 * signed out even if a session row still exists (P3a-AC5, defense in depth).
 */
export async function resolveActor(db: Database | Tx, userId: string): Promise<IdentityActor | null> {
  const record = await findActorRecord(db, userId);
  if (!record || record.status !== 'active') return null;
  const assignments = record.assignments
    .filter((a): a is typeof a & { role: Role } => isRole(a.role))
    .map((a) => ({ role: a.role, departmentId: a.department?.id ?? null }));
  const roles = [...new Set(assignments.map((a) => a.role))].sort();
  return {
    userId: record.userId,
    roles,
    permissions: permissionsForRoles(roles),
    email: record.email,
    name: record.name,
    departmentId: record.department?.id ?? null,
    assignments,
  };
}
