/**
 * Creates the first administrator and prints a one-time password-setup link (valid 24 h).
 *   npm run bootstrap-admin -- --email admin@example.com --name "Ada Admin"
 * Refuses to run if an active admin already exists: later admins are granted in the app (Phase 3b).
 * Runs through the same application code as the app, as the runtime database role.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const envFile = resolve(import.meta.dirname, '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' } } });
if (!values.email || !values.name) {
  console.error('Usage: npm run bootstrap-admin -- --email <email> --name "<display name>"');
  process.exit(1);
}

const { and, eq, isNull } = await import('drizzle-orm');
const { provisionUser, provisionUserInput } = await import('@/modules/identity');
const { roleAssignments } = await import('@/modules/identity/infrastructure/schema');
const { createRequestContext } = await import('@/shared/application/context');
const { closeDb, getDb } = await import('@/shared/db/client');
const { getEnv } = await import('@/shared/env');
const { getAuth, issuePasswordSetupToken, passwordSetupPath } = await import('@/server/auth');

try {
  const db = getDb();
  const existing = await db
    .select({ id: roleAssignments.id })
    .from(roleAssignments)
    .where(and(eq(roleAssignments.role, 'admin'), isNull(roleAssignments.revokedAt)))
    .limit(1);
  if (existing.length > 0) {
    console.error('An active admin already exists. Grant further admins from the application instead.');
    process.exitCode = 1;
  } else {
    const input = provisionUserInput.parse({ email: values.email, name: values.name, departmentCode: null, roles: [{ role: 'admin', departmentCode: null }] });
    await db.transaction((tx) => provisionUser(tx, createRequestContext({ actor: null }), input, 'system:bootstrap'));
    const token = await issuePasswordSetupToken(getAuth(), input.email);
    if (!token) throw new Error('No setup token was issued');
    console.log(`Admin ${input.email} created.`);
    console.log('Open this one-time link within 24 hours to set the password (it works once):');
    console.log(`${getEnv().BETTER_AUTH_URL}${passwordSetupPath(token)}`);
  }
} finally {
  await closeDb();
}
