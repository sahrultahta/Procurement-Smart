import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { provisionUser, provisionUserInput, resolveActor, type Role } from '@/modules/identity';
import { createRequestContext, type RequestContext } from '@/shared/application/context';

type RoleGrant = Role | { role: Role; departmentCode: string | null };

/**
 * A real user with real role assignments, but no password: enough for the command
 * runner, which resolves actors from the database exactly as requests do.
 */
export async function provisionActor(
  db: NodePgDatabase,
  email: string,
  name: string,
  roles: RoleGrant[],
  options: { departmentCode?: string | null } = {},
): Promise<string> {
  const input = provisionUserInput.parse({
    email,
    name,
    departmentCode: options.departmentCode ?? null,
    roles: roles.map((grant) => (typeof grant === 'string' ? { role: grant, departmentCode: null } : grant)),
  });
  return (await db.transaction((tx) => provisionUser(tx, createRequestContext({ actor: null }), input, 'system:test'))).userId;
}

export async function contextOf(db: NodePgDatabase, userId: string): Promise<RequestContext> {
  const actor = await resolveActor(db, userId);
  if (!actor) throw new Error(`no active actor for ${userId}`);
  return createRequestContext({ actor });
}
