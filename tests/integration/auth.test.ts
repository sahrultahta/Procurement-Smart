import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveActor } from '@/modules/identity';
import { issuePasswordSetupToken, passwordSetupPath, SIGN_IN_RATE_LIMIT, type Auth } from '@/server/auth';
import { emailFingerprint } from '@/server/auth-audit';
import { BASE_URL, callAuth, makeAuth, provisionWithPassword, sessionCookie } from '../support/auth';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

let t: TestDatabase;
let auth: Auth;
const PASSWORD = 'correct horse battery staple';

beforeAll(async () => {
  t = await createTestDatabase();
  auth = makeAuth(t.appDb);
  await provisionWithPassword(t.appDb, auth, { email: 'rina@example.com', name: 'Rina Requester', password: PASSWORD, roles: ['requester'] });
});

afterAll(async () => {
  await t?.drop();
});

const signIn = (email: string, password: string, ip = '198.51.100.10', target = auth) =>
  callAuth(target, '/sign-in/email', { body: { email, password }, ip });

describe('P3a-AC1: sign-up closed, sign-in works, failures are indistinguishable', () => {
  it('rejects public sign-up and creates no user', async () => {
    const response = await callAuth(auth, '/sign-up/email', {
      body: { email: 'intruder@example.com', password: 'a-long-enough-password', name: 'Intruder' },
      ip: '198.51.100.2',
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    const { rows } = await t.pool.query("SELECT count(*)::int AS n FROM users WHERE email = 'intruder@example.com'");
    expect(rows[0].n).toBe(0);
  });

  it('signs in with the right password and sets a session cookie', async () => {
    const response = await signIn('rina@example.com', PASSWORD);
    expect(response.status).toBe(200);
    expect(sessionCookie(response)).not.toBeNull();
  });

  it('accepts the email case-insensitively', async () => {
    expect((await signIn('RINA@Example.com', PASSWORD, '198.51.100.11')).status).toBe(200);
  });

  it('returns the same status and message for a wrong password and an unknown email', async () => {
    const wrongPassword = await signIn('rina@example.com', 'definitely-not-it', '198.51.100.12');
    const unknownEmail = await signIn('nobody@example.com', 'definitely-not-it', '198.51.100.13');
    expect(wrongPassword.status).toBe(unknownEmail.status);
    expect(wrongPassword.status).toBe(401);
    const a = (await wrongPassword.json()) as { message?: string; code?: string };
    const b = (await unknownEmail.json()) as { message?: string; code?: string };
    expect(a).toEqual(b);
    expect(sessionCookie(wrongPassword)).toBeNull();
  });
});

describe('P3a-AC2: sign-in rate limit', () => {
  it(`allows ${SIGN_IN_RATE_LIMIT.max} attempts per ${SIGN_IN_RATE_LIMIT.window}s per client, then answers 429`, async () => {
    const ip = '203.0.113.50';
    const statuses: number[] = [];
    for (let i = 0; i < SIGN_IN_RATE_LIMIT.max + 1; i++) statuses.push((await signIn('rina@example.com', 'wrong-password', ip)).status);
    expect(statuses.slice(0, SIGN_IN_RATE_LIMIT.max).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    // Even the correct password is refused while limited.
    expect((await signIn('rina@example.com', PASSWORD, ip)).status).toBe(429);
    // Another client is unaffected.
    expect((await signIn('rina@example.com', PASSWORD, '203.0.113.51')).status).toBe(200);
    const { rows } = await t.pool.query('SELECT count(*)::int AS n FROM rate_limits');
    expect(rows[0].n).toBeGreaterThan(0); // stored in PostgreSQL, not memory
  });
});

describe('P10-AC7: behind trusted reverse proxies (TRUSTED_PROXIES, ADR 0014)', () => {
  // Two proxy hops (10.0.0.2 and 10.0.0.3); the client is the first address from the right that is not one.
  const proxied = (target: Auth, header: string, password = 'wrong-password') => signIn('rina@example.com', password, header, target);

  it('limits the real client, whatever a client writes at the left of X-Forwarded-For', async () => {
    const behind = makeAuth(t.appDb, { trustedProxies: ['10.0.0.0/8'] });
    const statuses: number[] = [];
    for (let i = 0; i < SIGN_IN_RATE_LIMIT.max + 1; i++) {
      // A different forged address every time: the client is still 203.0.113.60.
      statuses.push((await proxied(behind, `192.0.2.${i + 1}, 203.0.113.60, 10.0.0.3, 10.0.0.2`)).status);
    }
    expect(statuses.slice(0, SIGN_IN_RATE_LIMIT.max).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    // Another client behind the same proxies is unaffected.
    expect((await proxied(behind, '203.0.113.61, 10.0.0.2', PASSWORD)).status).toBe(200);
  });

  it('records that same client in the audit trail', async () => {
    const behind = makeAuth(t.appDb, { trustedProxies: ['10.0.0.0/8'] });
    expect((await proxied(behind, '192.0.2.99, 203.0.113.62, 10.0.0.2', PASSWORD)).status).toBe(200);
    const { rows } = await t.pool.query("SELECT host(ip) AS ip FROM audit_events WHERE action = 'auth.signedIn' ORDER BY id DESC LIMIT 1");
    expect(rows[0].ip).toBe('203.0.113.62');
  });
});

describe('P3a-AC3: session cookie attributes', () => {
  it('development: HttpOnly and SameSite=Lax', async () => {
    const response = await signIn('rina@example.com', PASSWORD, '198.51.100.20');
    const cookie = response.headers.getSetCookie().find((c) => /session_token=/.test(c)) ?? '';
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it('production (https): additionally Secure with the __Secure- prefix', async () => {
    const httpsBase = 'https://procureflow.example.test';
    const production = makeAuth(t.appDb, { secureCookies: true, baseURL: httpsBase });
    const response = await callAuth(production, '/sign-in/email', {
      body: { email: 'rina@example.com', password: PASSWORD },
      ip: '198.51.100.21',
      baseURL: httpsBase,
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.getSetCookie().find((c) => /session_token=/.test(c)) ?? '';
    expect(cookie).toMatch(/^__Secure-/);
    expect(cookie).toMatch(/;\s*Secure/i);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });
});

describe('P3a-AC4: sign-out ends the session on the server', () => {
  it('a replayed cookie no longer has a session after sign-out', async () => {
    const cookie = sessionCookie(await signIn('rina@example.com', PASSWORD, '198.51.100.30')) ?? '';
    const before = await callAuth(auth, '/get-session', { method: 'GET', cookie, ip: '198.51.100.30' });
    expect(((await before.json()) as { user?: { email: string } } | null)?.user?.email).toBe('rina@example.com');

    const out = await callAuth(auth, '/sign-out', { body: {}, cookie, ip: '198.51.100.30' });
    expect(out.status).toBe(200);

    const after = await callAuth(auth, '/get-session', { method: 'GET', cookie, ip: '198.51.100.30' });
    expect(await after.json()).toBeNull();
  });
});

describe('P3a-AC5: a deactivated profile is refused even with a live session', () => {
  it('resolveActor returns null once the profile is deactivated', async () => {
    const userId = await provisionWithPassword(t.appDb, auth, {
      email: 'agus@example.com',
      name: 'Agus Receiver',
      password: PASSWORD,
      roles: ['receiver'],
    });
    const cookie = sessionCookie(await signIn('agus@example.com', PASSWORD, '198.51.100.40')) ?? '';
    expect((await resolveActor(t.appDb, userId))?.roles).toEqual(['receiver']);

    // Raw SQL on purpose: no session revocation, to prove the profile check alone suffices.
    await t.pool.query(
      `UPDATE user_profiles SET status = 'deactivated', deactivated_at = now(),
         deactivated_by_user_id = (SELECT id FROM users WHERE email = 'rina@example.com') WHERE user_id = $1`,
      [userId],
    );
    // The session row still exists...
    const session = await callAuth(auth, '/get-session', { method: 'GET', cookie, ip: '198.51.100.40' });
    expect(((await session.json()) as { user?: { id: string } } | null)?.user?.id).toBe(userId);
    // ...but the application no longer accepts the user.
    expect(await resolveActor(t.appDb, userId)).toBeNull();
  });
});

describe('P3a-AC8: cross-origin requests are rejected', () => {
  it('refuses a sign-in POST from another origin and creates no session', async () => {
    const before = await t.pool.query('SELECT count(*)::int AS n FROM sessions');
    const response = await callAuth(auth, '/sign-in/email', {
      body: { email: 'rina@example.com', password: PASSWORD },
      origin: 'https://evil.example',
      ip: '198.51.100.60',
    });
    expect(response.status).toBe(403);
    expect(sessionCookie(response)).toBeNull();
    const after = await t.pool.query('SELECT count(*)::int AS n FROM sessions');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe('P3a-AC10: one-time password setup links', () => {
  it('expire after 24 hours, work once, and enforce the minimum length', async () => {
    await provisionWithPassword(t.appDb, auth, { email: 'sari@example.com', name: 'Sari Finance', password: PASSWORD });
    const token = await issuePasswordSetupToken(auth, 'sari@example.com');
    expect(token).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(passwordSetupPath(token ?? '')).toBe(`/set-password?token=${token}`);

    const { rows } = await t.pool.query(
      "SELECT extract(epoch FROM (expires_at - now()))::int AS seconds FROM verifications WHERE identifier = $1",
      [`reset-password:${token}`],
    );
    expect(rows[0].seconds).toBeGreaterThan(24 * 3600 - 120);
    expect(rows[0].seconds).toBeLessThanOrEqual(24 * 3600);

    const tooShort = await callAuth(auth, '/reset-password', { body: { newPassword: 'short', token }, ip: '198.51.100.70' });
    expect(tooShort.status).toBe(400);
    const first = await callAuth(auth, '/reset-password', { body: { newPassword: 'another long passphrase', token }, ip: '198.51.100.70' });
    expect(first.status).toBe(200);
    const second = await callAuth(auth, '/reset-password', { body: { newPassword: 'yet another passphrase', token }, ip: '198.51.100.70' });
    expect(second.status).toBe(400);
  });

  it('issues no token for an unknown email', async () => {
    expect(await issuePasswordSetupToken(auth, 'ghost@example.com')).toBeNull();
  });
});

describe('P3a-AC12: authentication events are audited without secrets', () => {
  it('records password setup, sign-in, failed sign-in, and sign-out', async () => {
    const userId = await provisionWithPassword(t.appDb, auth, { email: 'dewi@example.com', name: 'Dewi Procurement', password: PASSWORD });
    const cookie = sessionCookie(await signIn('dewi@example.com', PASSWORD, '198.51.100.80')) ?? '';
    await signIn('dewi@example.com', 'wrong-password-123', '198.51.100.81');
    await callAuth(auth, '/sign-out', { body: {}, cookie, ip: '198.51.100.80' });

    const { rows } = await t.pool.query(
      `SELECT action, entity_type, entity_id, actor_user_id, host(ip) AS ip, user_agent FROM audit_events
        WHERE entity_id = $1 OR entity_id = $2 ORDER BY id`,
      [userId, `email:${emailFingerprint('dewi@example.com')}`],
    );
    expect(rows.map((r) => r.action)).toEqual([
      'user.provisioned',
      'auth.passwordSet',
      'auth.signedIn',
      'auth.signInFailed',
      'auth.signedOut',
    ]);
    const failed = rows.find((r) => r.action === 'auth.signInFailed');
    expect(failed).toMatchObject({ entity_type: 'sign_in', actor_user_id: null, ip: '198.51.100.81', user_agent: 'vitest' });

    const dump = await t.pool.query('SELECT row_to_json(a)::text AS j FROM audit_events a');
    const all = dump.rows.map((r) => r.j).join('\n');
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain('wrong-password-123');
    // A failed sign-in stores only a fingerprint of the attempted email, never the email.
    const failedRows = await t.pool.query("SELECT row_to_json(a)::text AS j FROM audit_events a WHERE action = 'auth.signInFailed'");
    expect(failedRows.rows.length).toBeGreaterThan(0);
    for (const row of failedRows.rows) expect(row.j).not.toMatch(/@example\.com/);
  });
});

describe('provisioning rules', () => {
  it('rejects a duplicate email, an unknown department, and a scope on an org-wide role', async () => {
    const { provisionUser, provisionUserInput } = await import('@/modules/identity');
    const { createRequestContext } = await import('@/shared/application/context');
    const ctx = createRequestContext({ actor: null });
    const attempt = (input: unknown) =>
      t.appDb.transaction((tx) => provisionUser(tx, ctx, provisionUserInput.parse(input), 'system:test'));
    await expect(attempt({ email: 'rina@example.com', name: 'Dup', departmentCode: null, roles: [] })).rejects.toMatchObject({
      error: { rule: 'EMAIL_TAKEN' },
    });
    await expect(attempt({ email: 'new1@example.com', name: 'N', departmentCode: 'NOPE', roles: [] })).rejects.toMatchObject({
      error: { rule: 'UNKNOWN_DEPARTMENT' },
    });
    await t.pool.query("INSERT INTO departments (code, name) VALUES ('OPS', 'Operations')");
    await expect(
      attempt({ email: 'new2@example.com', name: 'N', departmentCode: 'OPS', roles: [{ role: 'admin', departmentCode: 'OPS' }] }),
    ).rejects.toMatchObject({ error: { rule: 'ROLE_NOT_SCOPABLE' } });
    const { rows } = await t.pool.query("SELECT count(*)::int AS n FROM users WHERE email LIKE 'new%@example.com'");
    expect(rows[0].n).toBe(0);
  });

  it('enforces SOD-05 and one active assignment per role at the database', async () => {
    const userId = (await t.pool.query("SELECT id FROM users WHERE email = 'rina@example.com'")).rows[0].id as string;
    const selfGrant = t.appPool.query(
      "INSERT INTO role_assignments (user_id, role, granted_by) VALUES ($1::uuid, 'auditor', $2::text)",
      [userId, userId],
    );
    await expect(selfGrant).rejects.toMatchObject({ code: '23514' });
    const duplicate = t.appPool.query(
      "INSERT INTO role_assignments (user_id, role, granted_by) VALUES ($1::uuid, 'requester', 'system:test')",
      [userId],
    );
    await expect(duplicate).rejects.toMatchObject({ code: '23505' });
  });

  it('never lets the runtime role delete identity rows', async () => {
    for (const table of ['users', 'accounts', 'user_profiles', 'role_assignments', 'departments']) {
      await expect(t.appDb.execute(sql.raw(`DELETE FROM ${table}`))).rejects.toMatchObject({ cause: { code: '42501' } });
    }
  });

  it('uses the configured base URL', () => {
    expect(BASE_URL).toBe('http://localhost:3000');
  });
});
