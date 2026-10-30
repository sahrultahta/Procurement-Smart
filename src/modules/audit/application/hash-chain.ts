import { createHash } from 'node:crypto';

/**
 * Hash-chained audit export (Phase 10, docs/operations.md). An export is JSON Lines:
 *
 *   {"format":"procureflow-audit-export/1","afterId":"0","previousHash":"000…0","exportedAt":"…"}
 *   {"event":{…},"hash":"…"}            one line per audit event, by id
 *   {"count":2,"lastId":"42","lastHash":"…"}
 *
 * hash = sha256(previous hash + "\n" + canonical JSON of the event). The first event chains to
 * `previousHash`: all zeros for a first export, the last hash of the previous export otherwise.
 * Changing, removing, adding, or reordering a line breaks the chain from there on. Someone who
 * rewrites the whole file can recompute every hash, so the operator keeps each export's last hash
 * somewhere else (ADR 0009 limits); `verify` can be told which last hash to expect.
 */
export const AUDIT_EXPORT_FORMAT = 'procureflow-audit-export/1';
export const GENESIS_HASH = '0'.repeat(64);

/** An audit event as exported: every value is text, so nothing is lost (bigint ids, microseconds). */
export type ExportedAuditEvent = {
  id: string;
  occurredAt: string;
  actorUserId: string | null;
  actorRoles: string[];
  action: string;
  entityType: string;
  entityId: string;
  changes: unknown;
  reason: string | null;
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
};

const HASH = /^[0-9a-f]{64}$/;
const ID = /^(0|[1-9][0-9]{0,18})$/;

/** JSON with object keys sorted at every level: the same event always gives the same text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function chainHash(previousHash: string, event: ExportedAuditEvent): string {
  return createHash('sha256').update(`${previousHash}\n${canonicalJson(event)}`).digest('hex');
}

export type ExportHeader = { format: string; afterId: string; previousHash: string; exportedAt: string };
export type ExportFooter = { count: number; lastId: string; lastHash: string };

export function headerLine(header: ExportHeader): string {
  return canonicalJson(header);
}

export function eventLine(event: ExportedAuditEvent, hash: string): string {
  return canonicalJson({ event, hash });
}

export function footerLine(footer: ExportFooter): string {
  return canonicalJson(footer);
}

export type VerifyResult =
  | { ok: true; count: number; afterId: string; previousHash: string; lastId: string; lastHash: string }
  | { ok: false; line: number; problem: string };

/**
 * Checks an export line by line (1-based line numbers in problems). `expectLastHash`, when given,
 * must equal the footer's last hash (the copy kept elsewhere).
 */
export function verifyExport(lines: readonly string[], options: { expectLastHash?: string } = {}): VerifyResult {
  const content = lines.at(-1) === '' ? lines.slice(0, -1) : lines;
  if (content.length < 2) return { ok: false, line: content.length + 1, problem: 'the file needs a header and a footer' };
  const parse = (index: number): Record<string, unknown> | null => {
    try {
      const value: unknown = JSON.parse(content[index] as string);
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };

  const header = parse(0);
  if (!header || header.format !== AUDIT_EXPORT_FORMAT) return { ok: false, line: 1, problem: `not a ${AUDIT_EXPORT_FORMAT} header` };
  if (typeof header.previousHash !== 'string' || !HASH.test(header.previousHash)) return { ok: false, line: 1, problem: 'invalid previousHash' };
  if (typeof header.afterId !== 'string' || !ID.test(header.afterId)) return { ok: false, line: 1, problem: 'invalid afterId' };

  let previousHash = header.previousHash;
  let lastId = BigInt(header.afterId);
  for (let i = 1; i < content.length - 1; i++) {
    const line = parse(i);
    const event = line?.event as ExportedAuditEvent | undefined;
    if (!line || !event || typeof event !== 'object' || typeof line.hash !== 'string') return { ok: false, line: i + 1, problem: 'not an event line' };
    if (typeof event.id !== 'string' || !ID.test(event.id)) return { ok: false, line: i + 1, problem: 'invalid event id' };
    if (BigInt(event.id) <= lastId) return { ok: false, line: i + 1, problem: `event ${event.id} is out of order (after ${lastId})` };
    if (chainHash(previousHash, event) !== line.hash) return { ok: false, line: i + 1, problem: `event ${event.id}: the hash does not match its content and the line before` };
    previousHash = line.hash;
    lastId = BigInt(event.id);
  }

  const footer = parse(content.length - 1);
  const count = content.length - 2;
  if (!footer || footer.count !== count || footer.lastId !== String(lastId) || footer.lastHash !== previousHash) {
    return { ok: false, line: content.length, problem: `the footer does not match the ${count} event lines above it` };
  }
  if (options.expectLastHash !== undefined && options.expectLastHash !== previousHash) {
    return { ok: false, line: content.length, problem: 'the last hash is not the one kept for this export' };
  }
  return { ok: true, count, afterId: header.afterId, previousHash: header.previousHash, lastId: String(lastId), lastHash: previousHash };
}
