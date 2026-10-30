import { describe, expect, it } from 'vitest';
import { clientIpFrom, isProxyEntry } from '@/shared/application/client-ip';
import { EnvError, parseEnv } from '@/shared/env';

/* P10-AC7: the client IP behind reverse proxies (ADR 0014), the same rule as Better Auth's rate limiter. */

describe('clientIpFrom', () => {
  it('without trusted proxies, trusts a header holding exactly one address', () => {
    expect(clientIpFrom('203.0.113.7', [])).toBe('203.0.113.7');
    expect(clientIpFrom(' 2001:db8::7 ', [])).toBe('2001:db8::7');
    expect(clientIpFrom('192.0.2.1, 203.0.113.7', [])).toBeNull();
    expect(clientIpFrom('not-an-ip', [])).toBeNull();
    expect(clientIpFrom('', [])).toBeNull();
    expect(clientIpFrom(null, [])).toBeNull();
  });

  it('with trusted proxies, takes the first address from the right that is not a proxy', () => {
    const proxies = ['10.0.0.0/8', '2001:db8:ffff::/48', '198.51.100.9'];
    expect(clientIpFrom('203.0.113.7, 10.0.0.3, 10.0.0.2', proxies)).toBe('203.0.113.7');
    expect(clientIpFrom('192.0.2.66, 203.0.113.7, 10.1.2.3', proxies)).toBe('203.0.113.7');
    expect(clientIpFrom('203.0.113.7, 198.51.100.9', proxies)).toBe('203.0.113.7');
    expect(clientIpFrom('2001:db8::7, 2001:db8:ffff::1', proxies)).toBe('2001:db8::7');
    expect(clientIpFrom('203.0.113.7', proxies)).toBe('203.0.113.7');
  });

  it('with trusted proxies, gives up on a malformed hop or a chain of proxies only', () => {
    const proxies = ['10.0.0.0/8'];
    expect(clientIpFrom('203.0.113.7, garbage, 10.0.0.2', proxies)).toBeNull();
    expect(clientIpFrom('10.0.0.5, 10.0.0.2', proxies)).toBeNull();
    // An address just outside the range is a client, not a proxy.
    expect(clientIpFrom('203.0.113.7, 11.0.0.1', proxies)).toBe('11.0.0.1');
  });
});

describe('TRUSTED_PROXIES', () => {
  const base = { DATABASE_URL: 'postgres://u:p@localhost/db', BETTER_AUTH_SECRET: 'x'.repeat(32), BETTER_AUTH_URL: 'https://example.test' };

  it('accepts IPs and CIDR ranges, comma-separated, and defaults to none', () => {
    expect(parseEnv(base).TRUSTED_PROXIES).toEqual([]);
    expect(parseEnv({ ...base, TRUSTED_PROXIES: ' 10.0.0.0/8, 127.0.0.1 ,::1,2001:db8::/32 ' }).TRUSTED_PROXIES).toEqual(['10.0.0.0/8', '127.0.0.1', '::1', '2001:db8::/32']);
  });

  it.each(['10.0.0.0/33', 'proxy.internal', '10.0.0.0/8/1', '2001:db8::/129', '10.0.0.0/x'])('refuses %s, naming only the variable', (entry) => {
    expect(isProxyEntry(entry)).toBe(false);
    expect(() => parseEnv({ ...base, TRUSTED_PROXIES: entry })).toThrow(EnvError);
    expect(() => parseEnv({ ...base, TRUSTED_PROXIES: entry })).toThrow('TRUSTED_PROXIES');
  });
});
