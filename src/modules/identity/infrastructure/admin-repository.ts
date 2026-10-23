import 'server-only';
import { and, asc, desc, eq, gt, inArray, isNull, like, sql } from 'drizzle-orm';
import type { Database, Tx } from '@/shared/db/transaction';
import { accounts, sessions, users, verifications } from './auth-schema';
import { departments, roleAssignments, userProfiles } from './schema';

type Queryable = Database | Tx;

/*
 * Reads and writes behind the administration commands (Phase 3b). Row locks are
 * taken here; the rules that decide what may change live in application/.
 */

// pg_advisory_xact_lock key for "who is an active admin" (ADR 0008 amendment, C9).
export const ADMIN_SET_LOCK_KEY = 0x5046_0001;

/**
 * Serializes every change that can alter the set of active administrators.
 * Released at commit or rollback. Waiting is bounded by the transaction's lock_timeout.
 */
export async function lockAdminSet(tx: Tx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADMIN_SET_LOCK_KEY}::bigint)`);
}

/** Users holding an unrevoked admin assignment whose profile is active. */
export async function findActiveAdminUserIds(db: Queryable): Promise<string[]> {
  const rows = await db
    .selectDistinct({ userId: roleAssignments.userId })
    .from(roleAssignments)
    .innerJoin(userProfiles, eq(userProfiles.userId, roleAssignments.userId))
    .where(and(eq(roleAssignments.role, 'admin'), isNull(roleAssignments.revokedAt), eq(userProfiles.status, 'active')));
  return rows.map((r) => r.userId);
}

const passwordSet = sql<boolean>`exists (
  select 1 from ${accounts}
  where ${accounts.userId} = ${users.id} and ${accounts.providerId} = 'credential' and ${accounts.password} is not null
)`;

export type ManagedUser = {
  id: string;
  email: string;
  name: string;
  status: string;
  departmentId: string | null;
  departmentCode: string | null;
  version: number;
  passwordSet: boolean;
};

/** Locks the user's profile row (FOR UPDATE) and returns the user, or null if unknown. */
export async function lockManagedUser(tx: Tx, userId: string): Promise<ManagedUser | null> {
  const [locked] = await tx
    .select({ userId: userProfiles.userId })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .for('update');
  if (!locked) return null;
  const [row] = await tx
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      status: userProfiles.status,
      departmentId: userProfiles.departmentId,
      departmentCode: departments.code,
      version: userProfiles.version,
      passwordSet,
    })
    .from(users)
    .innerJoin(userProfiles, eq(userProfiles.userId, users.id))
    .leftJoin(departments, eq(departments.id, userProfiles.departmentId))
    .where(eq(users.id, userId));
  return row ?? null;
}

/** Conditional on the version the caller checked; returns the new version. */
export async function updateManagedUser(
  tx: Tx,
  userId: string,
  expectedVersion: number,
  values: { name: string; departmentId: string | null },
): Promise<number> {
  await tx.update(users).set({ name: values.name }).where(eq(users.id, userId));
  const [row] = await tx
    .update(userProfiles)
    .set({ departmentId: values.departmentId, updatedAt: sql`now()`, version: sql`${userProfiles.version} + 1` })
    .where(and(eq(userProfiles.userId, userId), eq(userProfiles.version, expectedVersion)))
    .returning({ version: userProfiles.version });
  if (!row) throw new Error('user_profiles row changed under its lock');
  return row.version;
}

export async function setUserStatus(
  tx: Tx,
  userId: string,
  expectedVersion: number,
  change: { status: 'deactivated'; byUserId: string } | { status: 'active' },
): Promise<number> {
  const values =
    change.status === 'deactivated'
      ? { status: 'deactivated', deactivatedAt: sql`now()`, deactivatedByUserId: change.byUserId }
      : { status: 'active', deactivatedAt: null, deactivatedByUserId: null };
  const [row] = await tx
    .update(userProfiles)
    .set({ ...values, updatedAt: sql`now()`, version: sql`${userProfiles.version} + 1` })
    .where(and(eq(userProfiles.userId, userId), eq(userProfiles.version, expectedVersion)))
    .returning({ version: userProfiles.version });
  if (!row) throw new Error('user_profiles row changed under its lock');
  return row.version;
}

/** Revokes every session of the user. Returns how many were deleted. */
export async function deleteUserSessions(tx: Tx, userId: string): Promise<number> {
  const rows = await tx.delete(sessions).where(eq(sessions.userId, userId)).returning({ id: sessions.id });
  return rows.length;
}

/**
 * Invalidates the user's unused password-setup links. Better Auth 1.7.7 stores them as
 * verifications with identifier `reset-password:<token>` and the user id as value
 * (plain storage, our configuration); tests prove an invalidated link stops working.
 */
export async function deletePasswordSetupTokens(tx: Tx, userId: string): Promise<number> {
  const rows = await tx
    .delete(verifications)
    .where(and(eq(verifications.value, userId), like(verifications.identifier, 'reset-password:%')))
    .returning({ id: verifications.id });
  return rows.length;
}

export type AssignmentRecord = {
  id: string;
  userId: string;
  role: string;
  departmentCode: string | null;
  revokedAt: Date | null;
};

export async function lockAssignment(tx: Tx, assignmentId: string): Promise<AssignmentRecord | null> {
  const [locked] = await tx
    .select({ id: roleAssignments.id })
    .from(roleAssignments)
    .where(eq(roleAssignments.id, assignmentId))
    .for('update');
  if (!locked) return null;
  const [row] = await tx
    .select({
      id: roleAssignments.id,
      userId: roleAssignments.userId,
      role: roleAssignments.role,
      departmentCode: departments.code,
      revokedAt: roleAssignments.revokedAt,
    })
    .from(roleAssignments)
    .leftJoin(departments, eq(departments.id, roleAssignments.departmentId))
    .where(eq(roleAssignments.id, assignmentId));
  return row ?? null;
}

export async function findActiveAssignmentId(
  db: Queryable,
  userId: string,
  role: string,
  departmentId: string | null,
): Promise<string | null> {
  const [row] = await db
    .select({ id: roleAssignments.id })
    .from(roleAssignments)
    .where(
      and(
        eq(roleAssignments.userId, userId),
        eq(roleAssignments.role, role),
        departmentId === null ? isNull(roleAssignments.departmentId) : eq(roleAssignments.departmentId, departmentId),
        isNull(roleAssignments.revokedAt),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

export async function revokeAssignment(tx: Tx, assignmentId: string, revokedBy: string, reason: string): Promise<void> {
  await tx
    .update(roleAssignments)
    .set({ revokedAt: sql`now()`, revokedBy, revokeReason: reason })
    .where(and(eq(roleAssignments.id, assignmentId), isNull(roleAssignments.revokedAt)));
}

// --- Departments ---

export type DepartmentRecord = { id: string; code: string; name: string; isActive: boolean; version: number };

const departmentColumns = {
  id: departments.id,
  code: departments.code,
  name: departments.name,
  isActive: departments.isActive,
  version: departments.version,
};

export async function listDepartments(db: Queryable): Promise<DepartmentRecord[]> {
  return db.select(departmentColumns).from(departments).orderBy(asc(departments.code));
}

export async function findDepartmentIdByCode(db: Queryable, code: string): Promise<string | null> {
  const [row] = await db.select({ id: departments.id }).from(departments).where(eq(departments.code, code)).limit(1);
  return row?.id ?? null;
}

export async function lockDepartment(tx: Tx, departmentId: string): Promise<DepartmentRecord | null> {
  const [row] = await tx.select(departmentColumns).from(departments).where(eq(departments.id, departmentId)).for('update');
  return row ?? null;
}

export async function insertDepartment(tx: Tx, values: { code: string; name: string }): Promise<string> {
  const [row] = await tx.insert(departments).values(values).returning({ id: departments.id });
  if (!row) throw new Error('Department insert returned no row');
  return row.id;
}

export async function updateDepartment(
  tx: Tx,
  departmentId: string,
  expectedVersion: number,
  values: { name: string; isActive: boolean },
): Promise<number> {
  const [row] = await tx
    .update(departments)
    .set({ ...values, updatedAt: sql`now()`, version: sql`${departments.version} + 1` })
    .where(and(eq(departments.id, departmentId), eq(departments.version, expectedVersion)))
    .returning({ version: departments.version });
  if (!row) throw new Error('departments row changed under its lock');
  return row.version;
}

// --- Read models for the admin screens ---

export type UserSummaryRow = {
  id: string;
  email: string;
  name: string;
  status: string;
  passwordSet: boolean;
  departmentCode: string | null;
  departmentName: string | null;
};

export async function listUsers(
  db: Queryable,
  options: { status: 'active' | 'deactivated' | undefined; afterEmail: string | undefined; limit: number },
): Promise<UserSummaryRow[]> {
  const conditions = [
    options.status ? eq(userProfiles.status, options.status) : undefined,
    options.afterEmail ? gt(users.email, options.afterEmail) : undefined,
  ].filter((c) => c !== undefined);
  return db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      status: userProfiles.status,
      passwordSet,
      departmentCode: departments.code,
      departmentName: departments.name,
    })
    .from(users)
    .innerJoin(userProfiles, eq(userProfiles.userId, users.id))
    .leftJoin(departments, eq(departments.id, userProfiles.departmentId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(users.email))
    .limit(options.limit);
}

export type UserDetailRow = UserSummaryRow & { version: number; createdAt: Date; deactivatedAt: Date | null };

export async function findUserDetail(db: Queryable, userId: string): Promise<UserDetailRow | null> {
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      status: userProfiles.status,
      passwordSet,
      departmentCode: departments.code,
      departmentName: departments.name,
      version: userProfiles.version,
      createdAt: users.createdAt,
      deactivatedAt: userProfiles.deactivatedAt,
    })
    .from(users)
    .innerJoin(userProfiles, eq(userProfiles.userId, users.id))
    .leftJoin(departments, eq(departments.id, userProfiles.departmentId))
    .where(eq(users.id, userId));
  return row ?? null;
}

export type AssignmentRow = {
  id: string;
  userId: string;
  role: string;
  departmentCode: string | null;
  grantedBy: string;
  grantedAt: Date;
  revokedBy: string | null;
  revokedAt: Date | null;
  revokeReason: string | null;
};

/** Assignments of the given users; revoked ones only when `includeRevoked`. Newest first. */
export async function findAssignments(
  db: Queryable,
  userIds: readonly string[],
  options: { includeRevoked: boolean },
): Promise<AssignmentRow[]> {
  if (userIds.length === 0) return [];
  return db
    .select({
      id: roleAssignments.id,
      userId: roleAssignments.userId,
      role: roleAssignments.role,
      departmentCode: departments.code,
      grantedBy: roleAssignments.grantedBy,
      grantedAt: roleAssignments.grantedAt,
      revokedBy: roleAssignments.revokedBy,
      revokedAt: roleAssignments.revokedAt,
      revokeReason: roleAssignments.revokeReason,
    })
    .from(roleAssignments)
    .leftJoin(departments, eq(departments.id, roleAssignments.departmentId))
    .where(
      and(
        inArray(roleAssignments.userId, [...userIds]),
        options.includeRevoked ? undefined : isNull(roleAssignments.revokedAt),
      ),
    )
    .orderBy(desc(roleAssignments.grantedAt), asc(roleAssignments.id));
}

export async function findUserNames(db: Queryable, userIds: readonly string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const rows = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, [...userIds]));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Department ids (null = org-wide) of the user's active `approver` assignments, if the profile is active. */
export async function findApproverAssignmentDepartments(db: Queryable, userId: string): Promise<(string | null)[]> {
  const rows = await db
    .select({ departmentId: roleAssignments.departmentId })
    .from(roleAssignments)
    .innerJoin(userProfiles, eq(userProfiles.userId, roleAssignments.userId))
    .where(
      and(
        eq(roleAssignments.userId, userId),
        eq(roleAssignments.role, 'approver'),
        isNull(roleAssignments.revokedAt),
        eq(userProfiles.status, 'active'),
      ),
    );
  return rows.map((r) => r.departmentId);
}
