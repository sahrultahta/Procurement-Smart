import { randomBytes } from 'node:crypto';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { provisionUser, provisionUserInput, type Role } from '@/modules/identity';
import { createRequestContext } from '@/shared/application/context';
import { createAuth, issuePasswordSetupToken, type Auth } from '@/server/auth';

export const BASE_URL = 'http://localhost:3000';
const TEST_SECRET = randomBytes(32).toString('base64url');

export function makeAuth(db: NodePgDatabase, options: { secureCookies?: boolean; baseURL?: string } = {}): Auth {
  return createAuth({ db, baseURL: options.baseURL ?? BASE_URL, secret: TEST_SECRET, secureCookies: options.secureCookies ?? false });
}

/** Calls Better Auth's HTTP handler the way a browser would (Origin header, JSON body). */
export async function callAuth(
  auth: Auth,
  path: string,
  options: { method?: 'GET' | 'POST'; body?: unknown; cookie?: string; origin?: string | null; ip?: string; baseURL?: string } = {},
): Promise<Response> {
  const base = options.baseURL ?? BASE_URL;
  const headers = new Headers({ 'x-forwarded-for': options.ip ?? '198.51.100.1', 'user-agent': 'vitest' });
  if (options.origin !== null) headers.set('origin', options.origin ?? base);
  if (options.cookie) headers.set('cookie', options.cookie);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  const init: RequestInit = { method: options.method ?? 'POST', headers };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  return auth.handler(new Request(`${base}/api/auth${path}`, init));
}

/** "name=value" of the session cookie from a Set-Cookie response, or null. */
export function sessionCookie(response: Response): string | null {
  const cookie = response.headers.getSetCookie().find((c) => /session_token=/.test(c));
  return cookie ? (cookie.split(';')[0] ?? null) : null;
}

export async function provisionWithPassword(
  db: NodePgDatabase,
  auth: Auth,
  user: { email: string; name: string; password: string; roles?: Role[] },
): Promise<string> {
  const input = provisionUserInput.parse({
    email: user.email,
    name: user.name,
    departmentCode: null,
    roles: (user.roles ?? []).map((role) => ({ role, departmentCode: null })),
  });
  const { userId } = await db.transaction((tx) => provisionUser(tx, createRequestContext({ actor: null }), input, 'system:test'));
  const token = await issuePasswordSetupToken(auth, input.email);
  if (!token) throw new Error('no setup token issued');
  const response = await callAuth(auth, '/reset-password', { body: { newPassword: user.password, token } });
  if (response.status !== 200) throw new Error(`password setup failed: ${response.status} ${await response.text()}`);
  return userId;
}
