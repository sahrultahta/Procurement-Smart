import { describe, expect, it } from 'vitest';
import { EnvError, parseEnv } from '@/shared/env';

const VALID = {
  DATABASE_URL: 'postgres://app:pw@127.0.0.1:5432/procureflow',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  BETTER_AUTH_URL: 'http://localhost:3000',
};

describe('parseEnv (P1-AC6)', () => {
  it('accepts a valid configuration and applies defaults', () => {
    expect(parseEnv(VALID)).toEqual({ ...VALID, NODE_ENV: 'development', LOG_LEVEL: 'info', TRUSTED_PROXIES: [], DATABASE_POOL_MAX: 10 });
  });

  it('takes a database pool size from 1 to 50', () => {
    expect(parseEnv({ ...VALID, DATABASE_POOL_MAX: '2' }).DATABASE_POOL_MAX).toBe(2);
    for (const value of ['0', '51', 'many', '1.5']) {
      expect(() => parseEnv({ ...VALID, DATABASE_POOL_MAX: value })).toThrowError(/DATABASE_POOL_MAX/);
    }
  });

  it('requires an auth secret of at least 32 characters and an http(s) base URL (Phase 3a)', () => {
    expect(() => parseEnv({ ...VALID, BETTER_AUTH_SECRET: 'too-short-secret-value' })).toThrowError(/BETTER_AUTH_SECRET/);
    expect(() => parseEnv({ ...VALID, BETTER_AUTH_URL: 'ftp://example.com' })).toThrowError(/BETTER_AUTH_URL/);
    expect(() => parseEnv({ DATABASE_URL: VALID.DATABASE_URL })).toThrowError(/BETTER_AUTH_SECRET, BETTER_AUTH_URL/);
  });

  it('never echoes the auth secret in the error', () => {
    let message = '';
    try {
      parseEnv({ ...VALID, BETTER_AUTH_SECRET: 'short-but-secret-789' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('BETTER_AUTH_SECRET');
    expect(message).not.toContain('short-but-secret-789');
  });

  it('rejects a missing DATABASE_URL and names it', () => {
    expect(() => parseEnv({})).toThrowError(EnvError);
    expect(() => parseEnv({})).toThrowError(/DATABASE_URL/);
  });

  it('rejects a non-PostgreSQL URL', () => {
    expect(() => parseEnv({ DATABASE_URL: 'mysql://app:pw@127.0.0.1/db' })).toThrowError(/DATABASE_URL/);
  });

  it('never echoes variable values in the error', () => {
    let message = '';
    try {
      parseEnv({ DATABASE_URL: 'not a url but-super-secret-123', NODE_ENV: 'staging-secret-456' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('NODE_ENV');
    expect(message).not.toContain('super-secret-123');
    expect(message).not.toContain('staging-secret-456');
  });
});
