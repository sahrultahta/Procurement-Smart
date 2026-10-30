import { describe, expect, it } from 'vitest';
import {
  AUDIT_EXPORT_FORMAT,
  GENESIS_HASH,
  canonicalJson,
  chainHash,
  eventLine,
  footerLine,
  headerLine,
  verifyExport,
  type ExportedAuditEvent,
} from '@/modules/audit/application/hash-chain';

/* P10-AC5: the hash-chained audit export detects any change to the file. */

function event(id: number, overrides: Partial<ExportedAuditEvent> = {}): ExportedAuditEvent {
  return {
    id: String(id),
    occurredAt: `2026-10-28T10:00:0${id % 10}.123456Z`,
    actorUserId: 'b5c1c0de-0000-4000-8000-000000000001',
    actorRoles: ['procurement'],
    action: 'po.issued',
    entityType: 'purchase_order',
    entityId: `po-${id}`,
    changes: { status: ['approved', 'issued'] },
    reason: null,
    requestId: null,
    ip: '203.0.113.7',
    userAgent: 'Test/1.0',
    ...overrides,
  };
}

function build(events: ExportedAuditEvent[], previousHash = GENESIS_HASH, afterId = '0'): { lines: string[]; lastHash: string } {
  const lines = [headerLine({ format: AUDIT_EXPORT_FORMAT, afterId, previousHash, exportedAt: '2026-10-29T00:00:00.000Z' })];
  let hash = previousHash;
  for (const e of events) {
    hash = chainHash(hash, e);
    lines.push(eventLine(e, hash));
  }
  lines.push(footerLine({ count: events.length, lastId: events.at(-1)?.id ?? afterId, lastHash: hash }), '');
  return { lines, lastHash: hash };
}

const replaceLine = (lines: string[], index: number, line: string) => lines.map((l, i) => (i === index ? line : l));

describe('canonical JSON', () => {
  it('sorts keys at every level and keeps arrays in order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: null } })).toBe('{"a":{"c":null,"d":[3,1]},"b":1}');
    expect(canonicalJson({ a: undefined, b: 'x' })).toBe('{"b":"x"}');
  });

  it('gives the same hash whatever order the keys came in', () => {
    const a = event(1, { changes: { qty: ['1', '2'], status: ['draft', 'posted'] } });
    const b = event(1, { changes: { status: ['draft', 'posted'], qty: ['1', '2'] } });
    expect(chainHash(GENESIS_HASH, a)).toBe(chainHash(GENESIS_HASH, b));
  });
});

describe('P10-AC5: verifying an export', () => {
  const events = [event(3), event(7), event(8, { reason: 'Wrong delivery', changes: { note: ['a', 'b'] } })];

  it('accepts an intact export, also an empty one and a continued chain', () => {
    const { lines, lastHash } = build(events);
    expect(verifyExport(lines)).toEqual({ ok: true, count: 3, afterId: '0', previousHash: GENESIS_HASH, lastId: '8', lastHash });
    expect(verifyExport(lines, { expectLastHash: lastHash }).ok).toBe(true);
    expect(verifyExport(build([]).lines)).toMatchObject({ ok: true, count: 0, lastId: '0', lastHash: GENESIS_HASH });
    const next = build([event(9), event(12)], lastHash, '8');
    expect(verifyExport(next.lines)).toMatchObject({ ok: true, count: 2, afterId: '8', previousHash: lastHash, lastId: '12' });
  });

  it('detects a changed event, even a single character', () => {
    const { lines } = build(events);
    const tampered = (lines[2] as string).replace('"po-7"', '"po-6"');
    expect(verifyExport(replaceLine(lines, 2, tampered))).toEqual({ ok: false, line: 3, problem: 'event 7: the hash does not match its content and the line before' });
  });

  it('detects a removed, an added, and a reordered line', () => {
    const { lines } = build(events);
    expect(verifyExport([...lines.slice(0, 2), ...lines.slice(3)])).toMatchObject({ ok: false, line: 3 });
    const fake = eventLine(event(5), chainHash(GENESIS_HASH, event(5)));
    expect(verifyExport([lines[0] as string, lines[1] as string, fake, ...lines.slice(2)])).toMatchObject({ ok: false, line: 3 });
    expect(verifyExport([lines[0] as string, lines[2] as string, lines[1] as string, ...lines.slice(3)])).toMatchObject({ ok: false, line: 2 });
  });

  it('detects a cut-off file and a footer that does not match', () => {
    const { lines } = build(events);
    expect(verifyExport(lines.slice(0, 3))).toMatchObject({ ok: false, line: 3, problem: expect.stringContaining('footer') });
    const footer = footerLine({ count: 3, lastId: '8', lastHash: GENESIS_HASH });
    expect(verifyExport(replaceLine(lines, 4, footer))).toMatchObject({ ok: false, line: 5 });
  });

  it('detects a file rewritten from scratch only through the last hash kept elsewhere', () => {
    const original = build(events);
    const rewritten = build([event(3), event(7, { action: 'po.cancelled' }), event(8)]);
    expect(verifyExport(rewritten.lines).ok).toBe(true);
    expect(verifyExport(rewritten.lines, { expectLastHash: original.lastHash })).toMatchObject({ ok: false, problem: expect.stringContaining('kept') });
  });

  it('refuses something that is not an export', () => {
    expect(verifyExport(['{}', '{}'])).toMatchObject({ ok: false, line: 1 });
    expect(verifyExport(['not json', '{}'])).toMatchObject({ ok: false, line: 1 });
    expect(verifyExport([])).toMatchObject({ ok: false });
    const { lines } = build(events);
    expect(verifyExport(replaceLine(lines, 0, headerLine({ format: AUDIT_EXPORT_FORMAT, afterId: '0', previousHash: 'abc', exportedAt: '' })))).toMatchObject({ ok: false, line: 1 });
    expect(verifyExport(replaceLine(lines, 2, '[1,2]'))).toMatchObject({ ok: false, line: 3, problem: 'not an event line' });
  });
});
