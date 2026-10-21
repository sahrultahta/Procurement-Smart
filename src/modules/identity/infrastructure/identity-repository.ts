import 'server-only';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Database, Tx } from '@/shared/db/transaction';
import { users } from './auth-schema';
import { departments, roleAssignments, userProfiles } from './schema';

type Queryable = Database | Tx;

export type ActorRecord = {
  userId: string;
  email: string;
  name: string;
  status: string;
  department: { id: string; code: string; name: string } | null;
  assignments: { role: string; department: { id: string; code: string } | null }[];
};

/** The user, their profile, and their active (non-revoked) role assignments. */
export async function findActorRecord(db: Queryable, userId: string): Promise<ActorRecord | null> {
  const [row] = await db
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      status: userProfiles.status,
      departmentId: departments.id,
      departmentCode: departments.code,
      departmentName: departments.name,
    })
    .from(users)
    .innerJoin(userProfiles, eq(userProfiles.userId, users.id))
    .leftJoin(departments, eq(departments.id, userProfiles.departmentId))
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return null;

  const assignments = await db
    .select({ role: roleAssignments.role, departmentId: departments.id, departmentCode: departments.code })
    .from(roleAssignments)
    .leftJoin(departments, eq(departments.id, roleAssignments.departmentId))
    .where(and(eq(roleAssignments.userId, userId), isNull(roleAssignments.revokedAt)));

  return {
    userId: row.userId,
    email: row.email,
    name: row.name,
    status: row.status,
    department:
      row.departmentId && row.departmentCode && row.departmentName
        ? { id: row.departmentId, code: row.departmentCode, name: row.departmentName }
        : null,
    assignments: assignments.map((a) => ({
      role: a.role,
      department: a.departmentId && a.departmentCode ? { id: a.departmentId, code: a.departmentCode } : null,
    })),
  };
}

export async function findUserIdByEmail(db: Queryable, email: string): Promise<string | null> {
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  return row?.id ?? null;
}

export async function findActiveDepartments(db: Queryable, codes: readonly string[]): Promise<Map<string, string>> {
  if (codes.length === 0) return new Map();
  const rows = await db
    .select({ id: departments.id, code: departments.code })
    .from(departments)
    .where(and(inArray(departments.code, [...codes]), eq(departments.isActive, true)));
  return new Map(rows.map((r) => [r.code, r.id]));
}

/** Creates the department if its code is new. Returns its id either way. */
export async function ensureDepartment(tx: Tx, code: string, name: string): Promise<{ id: string; created: boolean }> {
  const inserted = await tx
    .insert(departments)
    .values({ code, name })
    .onConflictDoNothing({ target: departments.code })
    .returning({ id: departments.id });
  if (inserted[0]) return { id: inserted[0].id, created: true };
  const [existing] = await tx.select({ id: departments.id }).from(departments).where(eq(departments.code, code));
  if (!existing) throw new Error(`Department ${code} vanished during ensureDepartment`);
  return { id: existing.id, created: false };
}

export async function insertUserWithProfile(
  tx: Tx,
  input: { email: string; name: string; departmentId: string | null },
): Promise<string> {
  const [user] = await tx.insert(users).values({ email: input.email, name: input.name }).returning({ id: users.id });
  if (!user) throw new Error('User insert returned no row');
  await tx.insert(userProfiles).values({ userId: user.id, departmentId: input.departmentId });
  return user.id;
}

export async function insertRoleAssignment(
  tx: Tx,
  input: { userId: string; role: string; departmentId: string | null; grantedBy: string },
): Promise<string> {
  const [row] = await tx.insert(roleAssignments).values(input).returning({ id: roleAssignments.id });
  if (!row) throw new Error('Role assignment insert returned no row');
  return row.id;
}
