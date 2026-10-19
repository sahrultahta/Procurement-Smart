import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

// P1-AC7: GET /api/health returns 200 with the database up, 503 without it, and leaks nothing.
let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t?.drop();
});

afterEach(async () => {
  const { closeDb } = await import('@/shared/db/client');
  await closeDb();
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function callHealth(databaseUrl: string): Promise<Response> {
  vi.resetModules();
  vi.stubEnv('DATABASE_URL', databaseUrl);
  const { GET } = await import('@/app/api/health/route');
  return GET();
}

describe('GET /api/health', () => {
  it('returns 200 when the database is reachable', async () => {
    const response = await callHealth(t.url);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'ok', checks: { database: 'ok' } });
  });

  it('returns 503 without error details when the database is unreachable', async () => {
    const silence = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await callHealth('postgres://nobody:wrong-password@127.0.0.1:1/none');
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ status: 'unavailable', checks: { database: 'unavailable' } });
    expect(body).not.toContain('wrong-password');
    expect(body).not.toContain('127.0.0.1');
    expect(silence).toHaveBeenCalled();
    silence.mockRestore();
  });
});
