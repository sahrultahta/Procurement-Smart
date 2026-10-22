import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_ASSIGNMENT_KEYS,
  ADMIN_USER_DETAIL_KEYS,
  ADMIN_USER_SUMMARY_KEYS,
  DEPARTMENT_DTO_KEYS,
  assertAnotherAdminRemains,
  createDepartment,
  createUser,
  deactivateUser,
  getUser,
  grantRole,
  listDepartments,
  listUsers,
  prepareSetupLink,
  reactivateUser,
  resolveActor,
  revokeRole,
  updateDepartment,
  updateUser,
} from '@/modules/identity';
import { issueSetupLink } from '@/server/admin-links';
import type { Auth } from '@/server/auth';
import { createRequestContext, type RequestContext } from '@/shared/application/context';
import { runCommand, runQuery, type Operation } from '@/shared/application/runner';
import { AppFailure, type Result } from '@/shared/result';
import { BASE_URL, callAuth, makeAuth, provisionWithPassword, sessionCookie } from '../support/auth';
import { createTestDatabase, sqlStateOf, type TestDatabase } from '../support/test-db';

/*
 * Phase 3b administration commands and queries, run as the runtime role through the
 * command runner, exactly as the Server Actions call them.
 */

let t: TestDatabase;
let auth: Auth;
const PASSWORD = 'correct horse battery staple';
let adminA: string;
let adminB: string;

let ipCounter = 0;
const nextIp = (): string => {
  ipCounter += 1;
  return `10.77.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
};

beforeAll(async () => {
  t = await createTestDatabase();
  auth = makeAuth(t.appDb);
  await t.pool.query(
    "INSERT INTO departments (code, name, is_active) VALUES ('OPS', 'Operations', true), ('FIN', 'Finance', true), ('OLD', 'Closed unit', false)",
  );
  adminA = await provisionWithPassword(t.appDb, auth, { email: 'tomas@example.com', name: 'Tomas Admin', password: PASSWORD, roles: ['admin'] });
  adminB = await provisionWithPassword(t.appDb, auth, { email: 'tia@example.com', name: 'Tia Admin', password: PASSWORD, roles: ['admin'] });
});

afterAll(async () => {
  await t?.drop();
});

async function contextFor(userId: string): Promise<RequestContext> {
  const actor = await resolveActor(t.appDb, userId);
  if (!actor) throw new Error(`no active actor for ${userId}`);
  return createRequestContext({ actor });
}

async function run<I, O>(as: string | RequestContext, op: Operation<I, O>, input: unknown): Promise<Result<O>> {
  const context = typeof as === 'string' ? await contextFor(as) : as;
  return op.kind === 'command' ? runCommand(context, op, input, { db: t.appDb }) : runQuery(context, op, input, { db: t.appDb });
}

function data<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.data;
}

async function link(userId: string, as = adminA): Promise<Result<{ url: string }>> {
  return issueSetupLink(await contextFor(as), userId, { auth, db: t.appDb, baseURL: BASE_URL });
}

async function setPassword(url: string, password = PASSWORD): Promise<number> {
  const token = new URL(url).searchParams.get('token');
  return (await callAuth(auth, '/reset-password', { body: { newPassword: password, token }, ip: nextIp() })).status;
}

const signIn = (email: string, password = PASSWORD) => callAuth(auth, '/sign-in/email', { body: { email, password }, ip: nextIp() });

async function sessionUserId(cookie: string): Promise<string | null> {
  const response = await callAuth(auth, '/get-session', { method: 'GET', cookie, ip: nextIp() });
  return ((await response.json()) as { user?: { id: string } } | null)?.user?.id ?? null;
}

type AuditRow = { action: string; actor: string | null; changes: Record<string, unknown>; reason: string | null };
async function auditOf(entityId: string): Promise<AuditRow[]> {
  const { rows } = await t.pool.query(
    'SELECT action, actor_user_id AS actor, changes, reason FROM audit_events WHERE entity_id = $1 ORDER BY id',
    [entityId],
  );
  return rows as AuditRow[];
}

async function versionOf(userId: string): Promise<number> {
  return (await t.pool.query('SELECT version FROM user_profiles WHERE user_id = $1', [userId])).rows[0].version as number;
}

let seq = 0;
async function newUser(
  options: { roles?: { role: string; departmentCode: string | null }[]; departmentCode?: string | null; withPassword?: boolean } = {},
): Promise<{ id: string; email: string }> {
  seq += 1;
  const email = `user${seq}@example.com`;
  const { userId } = data(
    await run(adminA, createUser, {
      email,
      name: `User ${seq}`,
      departmentCode: options.departmentCode === undefined ? 'OPS' : options.departmentCode,
      roles: options.roles ?? [],
    }),
  );
  if (options.withPassword) expect(await setPassword(data(await link(userId)).url)).toBe(200);
  return { id: userId, email };
}

const countUsers = async (): Promise<number> => (await t.pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n as number;

describe('P3b-AC1: admin.user.create and the one-time setup link', () => {
  it('creates the user, profile, and scoped roles, audited, and the link works exactly once', async () => {
    const result = await run(adminA, createUser, {
      email: 'Rina.New@Example.com',
      name: 'Rina Requester',
      departmentCode: 'OPS',
      roles: [
        { role: 'requester', departmentCode: 'OPS' },
        { role: 'approver', departmentCode: null },
      ],
    });
    const { userId } = data(result);
    const detail = data(await run(adminA, getUser, { userId }));
    expect(detail).toMatchObject({ email: 'rina.new@example.com', status: 'active', passwordSet: false, department: { code: 'OPS' } });
    expect(detail.assignments.map((a) => [a.role, a.departmentCode, a.grantedBy])).toEqual(
      expect.arrayContaining([
        ['requester', 'OPS', 'Tomas Admin'],
        ['approver', null, 'Tomas Admin'],
      ]),
    );

    const events = await auditOf(userId);
    expect(events).toEqual([
      expect.objectContaining({
        action: 'user.provisioned',
        actor: adminA,
        changes: { email: [null, 'rina.new@example.com'], name: [null, 'Rina Requester'], departmentCode: [null, 'OPS'] },
      }),
    ]);
    const grants = await t.pool.query(
      "SELECT count(*)::int AS n FROM audit_events WHERE action = 'role.granted' AND actor_user_id = $1 AND changes->'userId'->>1 = $2",
      [adminA, userId],
    );
    expect(grants.rows[0].n).toBe(2);

    const issued = data(await link(userId));
    const token = new URL(issued.url).searchParams.get('token') ?? '';
    expect(issued.url.startsWith(`${BASE_URL}/set-password?token=`)).toBe(true);
    const expiry = await t.pool.query(
      'SELECT extract(epoch FROM (expires_at - now()))::int AS seconds FROM verifications WHERE identifier = $1',
      [`reset-password:${token}`],
    );
    expect(expiry.rows[0].seconds).toBeGreaterThan(24 * 3600 - 120);
    expect(expiry.rows[0].seconds).toBeLessThanOrEqual(24 * 3600);

    expect(await setPassword(issued.url)).toBe(200);
    expect(await setPassword(issued.url, 'a different passphrase')).toBe(400);
    expect((await signIn('rina.new@example.com')).status).toBe(200);
    expect(data(await run(adminA, getUser, { userId })).passwordSet).toBe(true);

    // The token is a credential: it is never written to the audit trail.
    const leaked = await t.pool.query(
      "SELECT count(*)::int AS n FROM audit_events WHERE changes::text LIKE '%' || $1 || '%' OR coalesce(reason, '') LIKE '%' || $1 || '%'",
      [token],
    );
    expect(leaked.rows[0].n).toBe(0);
  });

  it('rejects a taken email (any case), unknown or inactive departments, and scoped org-wide roles, writing nothing', async () => {
    const before = await countUsers();
    const base = { name: 'Someone', departmentCode: null, roles: [] };
    expect(await run(adminA, createUser, { ...base, email: 'TOMAS@example.com' })).toMatchObject({
      ok: false,
      error: { code: 'BUSINESS_RULE', rule: 'EMAIL_TAKEN' },
    });
    expect(await run(adminA, createUser, { ...base, email: 'x1@example.com', departmentCode: 'NOPE' })).toMatchObject({
      ok: false,
      error: { rule: 'UNKNOWN_DEPARTMENT' },
    });
    expect(await run(adminA, createUser, { ...base, email: 'x2@example.com', departmentCode: 'OLD' })).toMatchObject({
      ok: false,
      error: { rule: 'UNKNOWN_DEPARTMENT' },
    });
    expect(
      await run(adminA, createUser, { ...base, email: 'x3@example.com', roles: [{ role: 'finance', departmentCode: 'OPS' }] }),
    ).toMatchObject({ ok: false, error: { rule: 'ROLE_NOT_SCOPABLE' } });
    expect(await countUsers()).toBe(before);
  });

  it('rejects unknown fields, tampered values, and duplicate roles before touching the database', async () => {
    const base = { email: 'x4@example.com', name: 'Someone', departmentCode: null, roles: [] };
    for (const input of [
      { ...base, isAdmin: true },
      { ...base, id: randomUUID() },
      { ...base, roles: [{ role: 'superuser', departmentCode: null }] },
      { ...base, roles: [{ role: 'auditor', departmentCode: null, grantedBy: 'system:seed' }] },
      {
        ...base,
        roles: [
          { role: 'auditor', departmentCode: null },
          { role: 'auditor', departmentCode: null },
        ],
      },
      { ...base, email: 'not-an-email' },
      { ...base, name: '   ' },
    ]) {
      expect(await run(adminA, createUser, input)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    }
  });

  it('is refused to anonymous callers', async () => {
    const result = await runCommand(createRequestContext({ actor: null }), createUser, {}, { db: t.appDb });
    expect(result).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
  });
});

describe('P3b-AC2: admin.user.update', () => {
  it('changes the name and department with a version check, audited before and after', async () => {
    const user = await newUser();
    const version = await versionOf(user.id);
    const result = await run(adminA, updateUser, { userId: user.id, name: 'Renamed User', departmentCode: 'FIN', expectedVersion: version });
    expect(data(result).version).toBe(version + 1);
    expect(data(await run(adminA, getUser, { userId: user.id }))).toMatchObject({ name: 'Renamed User', department: { code: 'FIN' } });
    expect((await auditOf(user.id)).at(-1)).toMatchObject({
      action: 'user.updated',
      actor: adminA,
      changes: { name: [expect.any(String), 'Renamed User'], departmentCode: ['OPS', 'FIN'] },
    });

    // The old version is now stale.
    expect(await run(adminB, updateUser, { userId: user.id, name: 'Other', departmentCode: 'FIN', expectedVersion: version })).toMatchObject({
      ok: false,
      error: { code: 'CONFLICT' },
    });
  });

  it('records nothing for a no-op, rejects inactive departments, self-edits, unknown users, and email changes', async () => {
    const user = await newUser();
    const version = await versionOf(user.id);
    const name = data(await run(adminA, getUser, { userId: user.id })).name;
    const eventsBefore = (await auditOf(user.id)).length;
    expect(data(await run(adminA, updateUser, { userId: user.id, name, departmentCode: 'OPS', expectedVersion: version })).version).toBe(version);
    expect((await auditOf(user.id)).length).toBe(eventsBefore);

    expect(await run(adminA, updateUser, { userId: user.id, name, departmentCode: 'OLD', expectedVersion: version })).toMatchObject({
      ok: false,
      error: { rule: 'UNKNOWN_DEPARTMENT' },
    });
    expect(
      await run(adminA, updateUser, { userId: adminA, name: 'Me', departmentCode: null, expectedVersion: await versionOf(adminA) }),
    ).toMatchObject({ ok: false, error: { code: 'BUSINESS_RULE', rule: 'SELF_ADMINISTRATION' } });
    expect(await run(adminA, updateUser, { userId: randomUUID(), name, departmentCode: null, expectedVersion: 1 })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    expect(
      await run(adminA, updateUser, { userId: user.id, name, departmentCode: 'OPS', expectedVersion: version, email: 'new@example.com' }),
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
  });
});

describe('P3b-AC3: deactivation revokes sessions and links in the same transaction', () => {
  it("ends every session at once: the user's next request is rejected", async () => {
    const user = await newUser({ roles: [{ role: 'receiver', departmentCode: null }], withPassword: true });
    const cookies = [sessionCookie(await signIn(user.email)) ?? '', sessionCookie(await signIn(user.email)) ?? ''];
    for (const cookie of cookies) expect(await sessionUserId(cookie)).toBe(user.id);

    const result = await run(adminA, deactivateUser, { userId: user.id, reason: 'Left the company', expectedVersion: await versionOf(user.id) });
    expect(data(result).revokedSessions).toBe(2);
    for (const cookie of cookies) expect(await sessionUserId(cookie)).toBeNull();
    expect((await t.pool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1', [user.id])).rows[0].n).toBe(0);
    expect(await resolveActor(t.appDb, user.id)).toBeNull();

    expect((await auditOf(user.id)).at(-1)).toMatchObject({
      action: 'user.deactivated',
      actor: adminA,
      reason: 'Left the company',
      changes: { status: ['active', 'deactivated'], revokedSessions: [null, 2], invalidatedSetupLinks: [null, 0] },
    });
    const profile = await t.pool.query('SELECT deactivated_by_user_id AS by FROM user_profiles WHERE user_id = $1', [user.id]);
    expect(profile.rows[0].by).toBe(adminA);

    expect(
      await run(adminA, deactivateUser, { userId: user.id, reason: 'Again', expectedVersion: await versionOf(user.id) }),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_TRANSITION' } });
  });

  it('invalidates an unused setup link', async () => {
    const user = await newUser();
    const issued = data(await link(user.id));
    data(await run(adminA, deactivateUser, { userId: user.id, reason: 'Hired by mistake', expectedVersion: await versionOf(user.id) }));
    expect(await setPassword(issued.url)).toBe(400);
    expect(await link(user.id)).toMatchObject({ ok: false, error: { rule: 'USER_DEACTIVATED' } });
  });

  it('requires a reason and the current version, and refuses self-deactivation', async () => {
    const user = await newUser();
    const version = await versionOf(user.id);
    expect(await run(adminA, deactivateUser, { userId: user.id, reason: '  ', expectedVersion: version })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    });
    expect(await run(adminA, deactivateUser, { userId: user.id, reason: 'x', expectedVersion: version + 5 })).toMatchObject({
      ok: false,
      error: { code: 'CONFLICT' },
    });
    expect(await run(adminA, deactivateUser, { userId: adminA, reason: 'x', expectedVersion: await versionOf(adminA) })).toMatchObject({
      ok: false,
      error: { rule: 'SELF_ADMINISTRATION' },
    });
    expect(await resolveActor(t.appDb, user.id)).not.toBeNull();
  });
});

describe('P3b-AC4: deactivated users cannot sign in; reactivation restores access', () => {
  it('answers exactly like a wrong password, creates no session, and audits the attempt', async () => {
    const user = await newUser({ withPassword: true });
    data(await run(adminA, deactivateUser, { userId: user.id, reason: 'Leave of absence', expectedVersion: await versionOf(user.id) }));

    const wrong = await signIn(user.email, 'not the password at all');
    const rejected = await signIn(user.email);
    expect(rejected.status).toBe(wrong.status);
    expect(await rejected.json()).toEqual(await wrong.json());
    expect(sessionCookie(rejected)).toBeNull();
    expect((await t.pool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1', [user.id])).rows[0].n).toBe(0);
    expect((await auditOf(user.id)).map((e) => e.action)).toContain('auth.signInRejected');
    expect((await auditOf(user.id)).map((e) => e.action)).not.toContain('auth.signedIn');

    expect(await run(adminB, reactivateUser, { userId: user.id, expectedVersion: (await versionOf(user.id)) - 1 })).toMatchObject({
      ok: false,
      error: { code: 'CONFLICT' },
    });
    data(await run(adminB, reactivateUser, { userId: user.id, expectedVersion: await versionOf(user.id) }));
    expect((await auditOf(user.id)).at(-1)).toMatchObject({
      action: 'user.reactivated',
      actor: adminB,
      changes: { status: ['deactivated', 'active'] },
    });
    expect((await signIn(user.email)).status).toBe(200);
    expect(await run(adminB, reactivateUser, { userId: user.id, expectedVersion: await versionOf(user.id) })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_TRANSITION' },
    });
  });
});

describe('P3b-AC5: new setup links only before the first password', () => {
  it('a new link invalidates the previous one, and is refused once a password is set', async () => {
    const user = await newUser();
    const first = data(await link(user.id));
    const second = data(await link(user.id, adminB));
    expect(await setPassword(first.url)).toBe(400);
    expect((await auditOf(user.id)).at(-1)).toMatchObject({
      action: 'user.setupLinkIssued',
      actor: adminB,
      changes: { invalidatedSetupLinks: [null, 1] },
    });
    expect(await setPassword(second.url)).toBe(200);
    expect(await link(user.id)).toMatchObject({ ok: false, error: { code: 'BUSINESS_RULE', rule: 'PASSWORD_ALREADY_SET' } });
  });

  it('refuses admins issuing a link for themselves, unknown users, and extra fields', async () => {
    expect(await link(adminA)).toMatchObject({ ok: false, error: { rule: 'SELF_ADMINISTRATION' } });
    expect(await link(randomUUID())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await run(adminA, prepareSetupLink, { userId: adminB, email: 'x@example.com' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    });
  });
});

describe('P3b-AC6: granting and revoking roles', () => {
  it('grants with scope, takes effect on the next request, and revokes into history', async () => {
    const user = await newUser();
    expect((await resolveActor(t.appDb, user.id))?.permissions.has('approval.decide')).toBe(false);

    const { assignmentId } = data(await run(adminA, grantRole, { userId: user.id, role: 'approver', departmentCode: 'OPS' }));
    const actor = await resolveActor(t.appDb, user.id);
    expect(actor?.permissions.has('approval.decide')).toBe(true);
    expect(actor?.assignments).toEqual([{ role: 'approver', departmentId: expect.any(String) }]);
    expect(await auditOf(assignmentId)).toEqual([
      expect.objectContaining({
        action: 'role.granted',
        actor: adminA,
        changes: { userId: [null, user.id], role: [null, 'approver'], departmentCode: [null, 'OPS'] },
      }),
    ]);

    // Same role, other department: a separate assignment. Same scope twice: refused.
    data(await run(adminA, grantRole, { userId: user.id, role: 'approver', departmentCode: 'FIN' }));
    expect(await run(adminB, grantRole, { userId: user.id, role: 'approver', departmentCode: 'OPS' })).toMatchObject({
      ok: false,
      error: { rule: 'ROLE_ALREADY_ASSIGNED' },
    });

    data(await run(adminB, revokeRole, { assignmentId, reason: 'Moved to another team' }));
    const row = await t.pool.query('SELECT revoked_by, revoke_reason FROM role_assignments WHERE id = $1', [assignmentId]);
    expect(row.rows[0]).toEqual({ revoked_by: adminB, revoke_reason: 'Moved to another team' });
    expect((await auditOf(assignmentId)).at(-1)).toMatchObject({
      action: 'role.revoked',
      actor: adminB,
      reason: 'Moved to another team',
      changes: { userId: [user.id, null], role: ['approver', null], departmentCode: ['OPS', null] },
    });
    const history = data(await run(adminA, getUser, { userId: user.id })).assignments;
    expect(history.map((a) => [a.departmentCode, a.revokedBy])).toEqual([
      ['FIN', null],
      ['OPS', 'Tia Admin'],
    ]);

    expect(await run(adminA, revokeRole, { assignmentId, reason: 'Again' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_TRANSITION' },
    });
    // After revocation the same scope can be granted again.
    data(await run(adminA, grantRole, { userId: user.id, role: 'approver', departmentCode: 'OPS' }));
  });

  it('enforces scope rules, active targets, and input rules', async () => {
    const user = await newUser();
    const grant = (input: Record<string, unknown>) => run(adminA, grantRole, { userId: user.id, ...input });
    expect(await grant({ role: 'finance', departmentCode: 'OPS' })).toMatchObject({ ok: false, error: { rule: 'ROLE_NOT_SCOPABLE' } });
    expect(await grant({ role: 'requester', departmentCode: 'OLD' })).toMatchObject({ ok: false, error: { rule: 'UNKNOWN_DEPARTMENT' } });
    expect(await grant({ role: 'root', departmentCode: null })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    expect(await grant({ role: 'auditor', departmentCode: null, grantedBy: adminB })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    });
    expect(await run(adminA, grantRole, { userId: randomUUID(), role: 'auditor', departmentCode: null })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    expect(await run(adminA, revokeRole, { assignmentId: randomUUID(), reason: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });

    const { assignmentId } = data(await grant({ role: 'auditor', departmentCode: null }));
    expect(await run(adminA, revokeRole, { assignmentId, reason: '' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });

    data(await run(adminA, deactivateUser, { userId: user.id, reason: 'Leaving', expectedVersion: await versionOf(user.id) }));
    expect(await grant({ role: 'receiver', departmentCode: null })).toMatchObject({ ok: false, error: { rule: 'USER_DEACTIVATED' } });
  });
});

describe('P3b-AC7: SOD-05 and LAST_ADMIN', () => {
  it('refuses every self-administration command', async () => {
    const own = (await t.pool.query("SELECT id FROM role_assignments WHERE user_id = $1 AND role = 'admin'", [adminA])).rows[0].id as string;
    const version = await versionOf(adminA);
    for (const result of [
      await run(adminA, grantRole, { userId: adminA, role: 'procurement', departmentCode: null }),
      await run(adminA, revokeRole, { assignmentId: own, reason: 'Stepping down' }),
      await run(adminA, deactivateUser, { userId: adminA, reason: 'x', expectedVersion: version }),
      await run(adminA, reactivateUser, { userId: adminA, expectedVersion: version }),
      await run(adminA, updateUser, { userId: adminA, name: 'Me', departmentCode: null, expectedVersion: version }),
      await link(adminA),
    ]) {
      expect(result).toMatchObject({ ok: false, error: { code: 'BUSINESS_RULE', rule: 'SELF_ADMINISTRATION' } });
    }
  });

  it('is backed by database CHECKs the runtime role cannot get around', async () => {
    const user = await newUser();
    const selfGrant = t.appPool.query("INSERT INTO role_assignments (user_id, role, granted_by) VALUES ($1::uuid, 'auditor', $2::text)", [
      user.id,
      user.id,
    ]);
    await expect(selfGrant).rejects.toMatchObject({ code: '23514' });

    const { assignmentId } = data(await run(adminA, grantRole, { userId: user.id, role: 'auditor', departmentCode: null }));
    const selfRevoke = t.appPool.query('UPDATE role_assignments SET revoked_at = now(), revoked_by = user_id::text WHERE id = $1', [assignmentId]);
    await expect(selfRevoke).rejects.toMatchObject({ code: '23514' });

    const selfDeactivate = t.appPool.query(
      "UPDATE user_profiles SET status = 'deactivated', deactivated_at = now(), deactivated_by_user_id = user_id WHERE user_id = $1",
      [user.id],
    );
    await expect(selfDeactivate).rejects.toMatchObject({ code: '23514' });
  });

  it('keeps one admin: the guard refuses to remove the last one, and a removed admin loses rights mid-request', async () => {
    const staleB = await contextFor(adminB); // resolved while Tia is still an admin
    const bAdmin = (await t.pool.query("SELECT id FROM role_assignments WHERE user_id = $1 AND role = 'admin' AND revoked_at IS NULL", [adminB]))
      .rows[0].id as string;
    data(await run(adminA, revokeRole, { assignmentId: bAdmin, reason: 'Rotation' }));

    // Tomas is now the only admin. The guard itself refuses to remove him...
    const guard = t.appDb.transaction((tx) => assertAnotherAdminRemains(tx, adminA));
    await expect(guard).rejects.toBeInstanceOf(AppFailure);
    await expect(t.appDb.transaction((tx) => assertAnotherAdminRemains(tx, adminA))).rejects.toMatchObject({
      error: { code: 'BUSINESS_RULE', rule: 'LAST_ADMIN' },
    });
    // ...he cannot remove himself (SOD-05)...
    expect(await run(adminA, deactivateUser, { userId: adminA, reason: 'x', expectedVersion: await versionOf(adminA) })).toMatchObject({
      ok: false,
      error: { rule: 'SELF_ADMINISTRATION' },
    });
    // ...and Tia's request, authorized before her role was revoked, is re-checked under the lock.
    expect(await run(staleB, deactivateUser, { userId: adminA, reason: 'x', expectedVersion: await versionOf(adminA) })).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    expect(await resolveActor(t.appDb, adminA)).not.toBeNull();

    data(await run(adminA, grantRole, { userId: adminB, role: 'admin', departmentCode: null }));
  });
});

describe('P3b-AC8: role assignments change only by one revocation', () => {
  it('rejects edits of granted fields and of revoked rows, for the app role and the owner alike', async () => {
    const user = await newUser();
    const { assignmentId } = data(await run(adminA, grantRole, { userId: user.id, role: 'auditor', departmentCode: null }));
    for (const pool of [t.appPool, t.pool]) {
      for (const statement of [
        "UPDATE role_assignments SET role = 'admin' WHERE id = $1",
        "UPDATE role_assignments SET granted_by = 'system:seed' WHERE id = $1",
        'UPDATE role_assignments SET granted_at = now() WHERE id = $1',
        'UPDATE role_assignments SET user_id = (SELECT id FROM users WHERE email = $2) WHERE id = $1',
      ]) {
        const params = statement.includes('$2') ? [assignmentId, 'tomas@example.com'] : [assignmentId];
        expect(await sqlStateOf(() => pool.query(statement, params))).toBe('PFR01');
      }
    }
    data(await run(adminA, revokeRole, { assignmentId, reason: 'Done' }));
    for (const statement of [
      "UPDATE role_assignments SET revoke_reason = 'rewritten' WHERE id = $1",
      'UPDATE role_assignments SET revoked_at = NULL, revoked_by = NULL WHERE id = $1',
    ]) {
      expect(await sqlStateOf(() => t.appPool.query(statement, [assignmentId]))).toBe('PFR01');
    }
    expect(await sqlStateOf(() => t.appPool.query('DELETE FROM role_assignments WHERE id = $1', [assignmentId]))).toBe('42501');
  });
});

describe('P3b-AC9: departments', () => {
  it('creates with a fixed code, updates name and status with a version check, all audited', async () => {
    const { departmentId } = data(await run(adminA, createDepartment, { code: 'WH-2', name: 'Warehouse Two' }));
    expect(await auditOf(departmentId)).toEqual([
      expect.objectContaining({
        action: 'department.created',
        actor: adminA,
        changes: { code: [null, 'WH-2'], name: [null, 'Warehouse Two'], isActive: [null, true] },
      }),
    ]);
    expect(await run(adminA, createDepartment, { code: 'WH-2', name: 'Again' })).toMatchObject({
      ok: false,
      error: { rule: 'DEPARTMENT_CODE_TAKEN' },
    });
    for (const code of ['wh', 'W', 'TOO-LONG-CODE-123', 'WH 3']) {
      expect(await run(adminA, createDepartment, { code, name: 'Bad' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    }

    const { version } = data(await run(adminA, updateDepartment, { departmentId, name: 'Warehouse 2', isActive: false, expectedVersion: 1 }));
    expect(version).toBe(2);
    expect((await auditOf(departmentId)).at(-1)).toMatchObject({
      action: 'department.updated',
      changes: { name: ['Warehouse Two', 'Warehouse 2'], isActive: [true, false] },
    });
    expect(await run(adminA, updateDepartment, { departmentId, name: 'X', isActive: true, expectedVersion: 1 })).toMatchObject({
      ok: false,
      error: { code: 'CONFLICT' },
    });
    expect(await run(adminA, updateDepartment, { departmentId, code: 'WH-3', name: 'X', isActive: true, expectedVersion: 2 })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    });
    expect(data(await run(adminA, updateDepartment, { departmentId, name: 'Warehouse 2', isActive: false, expectedVersion: 2 })).version).toBe(2);
    expect((await auditOf(departmentId)).length).toBe(2);
    expect(await run(adminA, updateDepartment, { departmentId: randomUUID(), name: 'X', isActive: true, expectedVersion: 1 })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });

    // Inactive: not available for new users or roles.
    expect(
      await run(adminA, createUser, { email: 'wh2@example.com', name: 'Someone', departmentCode: 'WH-2', roles: [] }),
    ).toMatchObject({ ok: false, error: { rule: 'UNKNOWN_DEPARTMENT' } });

    const list = data(await run(adminA, listDepartments, {}));
    expect(list.map((d) => d.code)).toEqual(['FIN', 'OLD', 'OPS', 'WH-2']);
    for (const item of list) expect(Object.keys(item).sort()).toEqual([...DEPARTMENT_DTO_KEYS].sort());
  });
});

describe('P3b-AC12: admin read models expose only allowlisted fields', () => {
  it('lists users page by page with a cursor and filters by status', async () => {
    const all: string[] = [];
    let cursor: string | undefined;
    do {
      const page = data(await run(adminA, listUsers, cursor ? { limit: 2, cursor } : { limit: 2 }));
      expect(page.items.length).toBeLessThanOrEqual(2);
      for (const item of page.items) expect(Object.keys(item).sort()).toEqual([...ADMIN_USER_SUMMARY_KEYS].sort());
      all.push(...page.items.map((i) => i.email));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(all).toEqual([...all].sort());
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(await countUsers());

    const deactivated = data(await run(adminA, listUsers, { status: 'deactivated', limit: 100 })).items;
    expect(deactivated.length).toBeGreaterThan(0);
    expect(deactivated.every((u) => u.status === 'deactivated')).toBe(true);

    for (const input of [{ cursor: 'not base64!' }, { cursor: Buffer.from('nope').toString('base64url') }, { limit: 101 }, { status: 'pending' }]) {
      expect(await run(adminA, listUsers, input)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    }
  });

  it('returns user details with no credentials, tokens, or session data anywhere', async () => {
    const user = await newUser({ roles: [{ role: 'requester', departmentCode: 'OPS' }], withPassword: true });
    const cookie = sessionCookie(await signIn(user.email)) ?? '';
    const detail = data(await run(adminA, getUser, { userId: user.id }));
    expect(Object.keys(detail).sort()).toEqual([...ADMIN_USER_DETAIL_KEYS].sort());
    for (const a of detail.assignments) expect(Object.keys(a).sort()).toEqual([...ADMIN_ASSIGNMENT_KEYS].sort());

    const secrets = [
      cookie.split('=')[1]?.split('.')[0] ?? '',
      ...(await t.pool.query('SELECT token FROM sessions WHERE user_id = $1', [user.id])).rows.map((r: { token: string }) => r.token),
      ...(await t.pool.query('SELECT password FROM accounts WHERE user_id = $1', [user.id])).rows.map((r: { password: string }) => r.password),
    ].filter((s) => s.length > 8);
    expect(secrets.length).toBeGreaterThanOrEqual(2);
    const serialized = JSON.stringify([detail, data(await run(adminA, listUsers, { limit: 100 }))]);
    for (const secret of secrets) expect(serialized).not.toContain(secret);
    expect(serialized).not.toMatch(/"(password|hash|token|session\w*|accountId|providerId)"\s*:/i);

    expect(await run(adminA, getUser, { userId: randomUUID() })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });
});
