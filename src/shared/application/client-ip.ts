import { BlockList, isIP } from 'node:net';

/**
 * The client IP from `X-Forwarded-For`, by the rule Better Auth's rate limiter uses (ADR 0014), so
 * the address in the audit trail is the one sign-ins are limited by:
 *
 * - With trusted proxies (IPs or CIDR ranges, `TRUSTED_PROXIES`): walk the list from the right,
 *   skip the proxies, and take the first address that is not one. Whatever a client put at the
 *   left of the header is never reached.
 * - Without: only a header holding exactly one address counts (a proxy that overwrites it).
 *
 * Null when no trustworthy address is found.
 */
export function clientIpFrom(forwardedFor: string | null | undefined, trustedProxies: readonly string[]): string | null {
  const hops = (forwardedFor ?? '').split(',').map((part) => part.trim()).filter(Boolean);
  if (hops.length === 0) return null;
  if (trustedProxies.length === 0) {
    const only = hops.length === 1 ? (hops[0] as string) : '';
    return isIP(only) === 0 ? null : only;
  }
  const proxies = proxyList(trustedProxies);
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i] as string;
    const family = isIP(hop);
    if (family === 0) return null;
    if (!proxies.check(hop, family === 4 ? 'ipv4' : 'ipv6')) return hop;
  }
  return null;
}

/** An IP address or CIDR range (`10.0.0.0/8`, `2001:db8::/32`), as `TRUSTED_PROXIES` accepts. */
export function isProxyEntry(entry: string): boolean {
  const [address = '', prefix, ...rest] = entry.split('/');
  if (rest.length > 0) return false;
  const family = isIP(address);
  if (family === 0) return false;
  if (prefix === undefined) return true;
  return /^[0-9]{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128);
}

function proxyList(entries: readonly string[]): BlockList {
  const list = new BlockList();
  for (const entry of entries) {
    if (!isProxyEntry(entry)) throw new Error(`Invalid trusted proxy entry: ${entry}`);
    const [address = '', prefix] = entry.split('/');
    const type = isIP(address) === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) list.addAddress(address, type);
    else list.addSubnet(address, Number(prefix), type);
  }
  return list;
}
