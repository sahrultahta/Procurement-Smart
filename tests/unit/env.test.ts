import { describe, expect, it } from 'vitest';
import { EnvError, parseEnv } from '@/shared/env';

describe('parseEnv (P1-AC6)', () => {
  it('accepts a valid configuration and applies defaults', () => {
    const env = parseEnv({ DATABASE_URL: 'postgres://app:pw@127.0.0.1:5432/procureflow' });
    expect(env).toEqual({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://app:pw@127.0.0.1:5432/procureflow',
      LOG_LEVEL: 'info',
    });
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
