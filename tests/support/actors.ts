import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { provisionUser, provisionUserInput, resolveActor, type Role } from '@/modules/identity';
import { createRequestContext, type RequestContext } from '@/shared/application/context';

/**
 * A real user with real role assignments, but no password: enough for the command
 * runner, which resolves actors from the database exactly as requests do.
 */
export async function provisionActor(db: NodePgDatabase, email: string, name: string, roles: Role[]): Promise<string> {
  const input = provisionUserInput.parse({
    email,
    name,
    departmentCode: null,
    roles: roles.map((role) => ({ role, departmentCode: null })),
  });
  return (await db.transaction((tx) => provisionUser(tx, createRequestContext({ actor: null }), input, 'system:test'))).userId;
}

export async function contextOf(db: NodePgDatabase, userId: string): Promise<RequestContext> {
  const actor = await resolveActor(db, userId);
  if (!actor) throw new Error(`no active actor for ${userId}`);
  return createRequestContext({ actor });
}
