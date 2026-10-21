/**
 * Fictional demo data (ADR 0001): three departments and one user per role, all @example.com.
 * Idempotent: existing departments and users are left as they are.
 *
 *   npm run seed                                   create missing demo users
 *   npm run seed -- --reset-passwords              also give existing seed users new passwords
 *   npm run seed -- --prefix e2e --out .local/e2e-credentials.json --reset-passwords
 *                                                  separate users for end-to-end tests
 *
 * Passwords are random and written to a gitignored JSON file under .local/ (never printed).
 * Refuses to run with NODE_ENV=production.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const root = resolve(import.meta.dirname, '..');
const envFile = resolve(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo data with NODE_ENV=production.');
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    prefix: { type: 'string', default: '' },
    out: { type: 'string', default: '.local/seed-credentials.json' },
    'reset-passwords': { type: 'boolean', default: false },
  },
});
const prefix = values.prefix ? `${values.prefix}.` : '';
const outFile = resolve(root, values.out);
if (!outFile.startsWith(resolve(root, '.local'))) {
  console.error('--out must point inside .local/ (gitignored).');
  process.exit(1);
}

const { provisionUser, provisionUserInput } = await import('@/modules/identity');
const { ensureDepartment, findUserIdByEmail } = await import('@/modules/identity/infrastructure/identity-repository');
const { recordAuditEvent } = await import('@/modules/audit');
const { createRequestContext } = await import('@/shared/application/context');
const { closeDb, getDb } = await import('@/shared/db/client');
const { getAuth, issuePasswordSetupToken } = await import('@/server/auth');

type SeedUser = { email: string; name: string; departmentCode: string | null; roles: { role: string; departmentCode: string | null }[] };

const DEPARTMENTS = [
  { code: 'OPS', name: 'Operations' },
  { code: 'FIN', name: 'Finance' },
  { code: 'WH', name: 'Warehouse' },
];

// Fictional people (docs/user-stories.md personas).
const USERS: SeedUser[] = [
  { email: 'ada.admin', name: 'Ada Admin', departmentCode: null, roles: [{ role: 'admin', departmentCode: null }] },
  { email: 'rina.requester', name: 'Rina Requester', departmentCode: 'OPS', roles: [{ role: 'requester', departmentCode: null }] },
  { email: 'bayu.approver', name: 'Bayu Approver', departmentCode: 'OPS', roles: [{ role: 'approver', departmentCode: 'OPS' }] },
  { email: 'dewi.procurement', name: 'Dewi Procurement', departmentCode: 'OPS', roles: [{ role: 'procurement', departmentCode: null }] },
  { email: 'agus.receiver', name: 'Agus Receiver', departmentCode: 'WH', roles: [{ role: 'receiver', departmentCode: null }] },
  { email: 'sari.finance', name: 'Sari Finance', departmentCode: 'FIN', roles: [{ role: 'finance', departmentCode: null }] },
  { email: 'lena.auditor', name: 'Lena Auditor', departmentCode: null, roles: [{ role: 'auditor', departmentCode: null }] },
];

const credentials: Record<string, { name: string; password: string; roles: string[] }> = {};
const summary = { departmentsCreated: 0, usersCreated: 0, usersSkipped: 0, passwordsSet: 0 };

try {
  const db = getDb();
  const auth = getAuth();
  const system = createRequestContext({ actor: null });

  await db.transaction(async (tx) => {
    for (const department of DEPARTMENTS) {
      const { id, created } = await ensureDepartment(tx, department.code, department.name);
      if (created) {
        summary.departmentsCreated++;
        await recordAuditEvent(tx, system, {
          action: 'department.created',
          entityType: 'department',
          entityId: id,
          changes: { code: [null, department.code], name: [null, department.name] },
          reason: 'seed',
        });
      }
    }
  });

  for (const user of USERS) {
    const email = `${prefix}${user.email}@example.com`;
    const exists = (await findUserIdByEmail(db, email)) !== null;
    if (exists) summary.usersSkipped++;
    else {
      const input = provisionUserInput.parse({ ...user, email });
      await db.transaction((tx) => provisionUser(tx, system, input, 'system:seed'));
      summary.usersCreated++;
    }
    if (!exists || values['reset-passwords']) {
      const password = randomBytes(15).toString('base64url'); // 20 characters
      const token = await issuePasswordSetupToken(auth, email);
      if (!token) throw new Error(`No setup token for ${email}`);
      await auth.api.resetPassword({ body: { newPassword: password, token } });
      credentials[email] = { name: user.name, password, roles: user.roles.map((r) => r.role) };
      summary.passwordsSet++;
    }
  }

  if (Object.keys(credentials).length > 0) {
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  }
  console.log(
    `Seed done: ${summary.departmentsCreated} departments created, ${summary.usersCreated} users created, ` +
      `${summary.usersSkipped} existing users skipped, ${summary.passwordsSet} passwords set.`,
  );
  if (summary.passwordsSet > 0) console.log(`Sign-in credentials for the users above: ${outFile}`);
} finally {
  await closeDb();
}
