import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNT_DTO_KEYS, getMyAccount, resolveActor } from '@/modules/identity';
import { createRequestContext } from '@/shared/application/context';
import { runQuery } from '@/shared/application/runner';
import { makeAuth, provisionWithPassword } from '../support/auth';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

let t: TestDatabase;
let requesterId: string;
let multiId: string;

beforeAll(async () => {
  t = await createTestDatabase();
  const auth = makeAuth(t.appDb);
  requesterId = await provisionWithPassword(t.appDb, auth, {
    email: 'rina@example.com',
    name: 'Rina Requester',
    password: 'correct horse battery staple',
    roles: ['requester'],
  });
  multiId = await provisionWithPassword(t.appDb, auth, {
    email: 'multi@example.com',
    name: 'Multi Role',
    password: 'correct horse battery staple',
    roles: ['receiver', 'auditor'],
  });
});

afterAll(async () => {
  await t?.drop();
});

describe('P3a-AC6: queries enforce authentication themselves', () => {
  it('account.me without an actor is UNAUTHENTICATED, with no page involved', async () => {
    const result = await runQuery(createRequestContext({ actor: null }), getMyAccount, {}, { db: t.appDb });
    expect(result).toEqual({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } });
  });

  it('a deactivated user cannot be turned into an actor', async () => {
    const auth = makeAuth(t.appDb);
    const id = await provisionWithPassword(t.appDb, auth, { email: 'gone@example.com', name: 'Gone', password: 'correct horse battery staple' });
    await t.pool.query(
      "UPDATE user_profiles SET status = 'deactivated', deactivated_at = now(), deactivated_by_user_id = $1 WHERE user_id = $2",
      [requesterId, id],
    );
    expect(await resolveActor(t.appDb, id)).toBeNull();
  });
});

describe('actor resolution', () => {
  it('unions the permissions of all active roles, plus the base permission', async () => {
    const actor = await resolveActor(t.appDb, multiId);
    expect(actor?.roles).toEqual(['auditor', 'receiver']);
    expect([...(actor?.permissions ?? [])].sort()).toEqual(
      ['account.read', 'audit.read', 'po.read.all', 'po.read.issued', 'receipt.create', 'receipt.read', 'report.view', 'requisition.read.all', 'supplier.read'].sort(),
    );
  });

  it('ignores revoked role assignments', async () => {
    await t.pool.query(
      "UPDATE role_assignments SET revoked_at = now(), revoked_by = 'system:test', revoke_reason = 'test' WHERE user_id = $1 AND role = 'auditor'",
      [multiId],
    );
    const actor = await resolveActor(t.appDb, multiId);
    expect(actor?.roles).toEqual(['receiver']);
    expect(actor?.permissions.has('audit.read')).toBe(false);
  });
});

describe('P3a-AC11: the account DTO is an allowlist', () => {
  it('returns exactly the allowed fields and nothing secret', async () => {
    const actor = await resolveActor(t.appDb, requesterId);
    expect(actor).not.toBeNull();
    const result = await runQuery(createRequestContext({ actor }), getMyAccount, {}, { db: t.appDb });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(Object.keys(result.data).sort()).toEqual([...ACCOUNT_DTO_KEYS].sort());
    expect(result.data).toEqual({
      name: 'Rina Requester',
      email: 'rina@example.com',
      department: null,
      roles: [{ role: 'requester', label: 'Requester', departmentCode: null }],
      permissions: ['account.read', 'requisition.create', 'requisition.read.own'],
    });

    // Deep scan: no key or value that looks like a credential, token, or internal id.
    const forbiddenKey = /pass|hash|token|secret|session|userId|^id$/i;
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) {
          expect(key).not.toMatch(forbiddenKey);
          walk(inner);
        }
      } else if (typeof value === 'string') {
        expect(value).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/); // no raw UUIDs
        expect(value).not.toContain(':'); // scrypt hashes are salt:hash
      }
    };
    walk(result.data);
  });
});
