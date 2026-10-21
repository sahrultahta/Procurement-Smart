import { describe, expect, it } from 'vitest';
import { REDACTED, auditChanges, defineAuditPolicy } from '@/modules/audit';
import { assertValidAuditEvent } from '@/modules/audit/domain/audit-event';

type Supplier = {
  legalName: string;
  taxId: string | null;
  status: string;
  tags: string[];
  reviewedAt: Date | null;
  apiToken: string | null;
  internalScore: number;
};

const policy = defineAuditPolicy<Supplier>({
  entityType: 'supplier',
  fields: ['legalName', 'taxId', 'status', 'tags', 'reviewedAt'],
  redacted: ['apiToken'],
});

describe('auditChanges (ADR 0009 allowlist)', () => {
  it('records allowlisted fields on create and never records others', () => {
    const changes = auditChanges(policy, null, {
      legalName: 'Acme Office Supplies',
      taxId: null,
      status: 'pending_review',
      tags: ['stationery'],
      apiToken: 'tok_live_123',
      internalScore: 7,
    });
    expect(changes).toEqual({
      legalName: [null, 'Acme Office Supplies'],
      status: [null, 'pending_review'],
      tags: [null, ['stationery']],
      apiToken: [null, REDACTED],
    });
    expect(JSON.stringify(changes)).not.toContain('tok_live_123');
    expect(changes).not.toHaveProperty('internalScore');
  });

  it('records only fields that changed on update', () => {
    const before = { legalName: 'Acme', status: 'pending_review', tags: ['a'], reviewedAt: null, apiToken: 'old' };
    const after = {
      legalName: 'Acme',
      status: 'active',
      tags: ['a'],
      reviewedAt: new Date('2026-10-21T03:00:00Z'),
      apiToken: 'new',
    };
    expect(auditChanges(policy, before, after)).toEqual({
      status: ['pending_review', 'active'],
      reviewedAt: [null, '2026-10-21T03:00:00.000Z'],
      apiToken: [REDACTED, REDACTED],
    });
  });

  it('records removals on delete', () => {
    expect(auditChanges(policy, { status: 'inactive' }, null)).toEqual({ status: ['inactive', null] });
  });

  it('rejects values that are not plain JSON-safe data', () => {
    expect(() => auditChanges(policy, null, { legalName: { nested: true } as unknown as string })).toThrow();
  });

  it('refuses a field that is both recorded and redacted', () => {
    expect(() => defineAuditPolicy<Supplier>({ entityType: 'supplier', fields: ['taxId'], redacted: ['taxId'] })).toThrow();
  });
});

describe('assertValidAuditEvent', () => {
  const valid = { action: 'supplier.reviewed', entityType: 'supplier', entityId: 'b6b0…', changes: {} };

  it('accepts a well-formed event', () => {
    expect(() => assertValidAuditEvent(valid)).not.toThrow();
    expect(() => assertValidAuditEvent({ ...valid, action: 'admin.role.granted' })).not.toThrow();
  });

  it.each(['Supplier.Reviewed', 'reviewed', 'supplier.', 'supplier reviewed', 'supplier.reviewed;drop'])(
    'rejects action %j',
    (action) => {
      expect(() => assertValidAuditEvent({ ...valid, action })).toThrow(/action/);
    },
  );

  it('rejects bad entity types, ids, reasons, and change pairs', () => {
    expect(() => assertValidAuditEvent({ ...valid, entityType: 'Supplier' })).toThrow();
    expect(() => assertValidAuditEvent({ ...valid, entityId: '' })).toThrow();
    expect(() => assertValidAuditEvent({ ...valid, entityId: 'x'.repeat(129) })).toThrow();
    expect(() => assertValidAuditEvent({ ...valid, reason: 'x'.repeat(2001) })).toThrow();
    const badPair = { status: ['a'] } as unknown as Record<string, readonly [string, string]>;
    expect(() => assertValidAuditEvent({ ...valid, changes: badPair })).toThrow();
    const nan = { score: [1, Number.NaN] } as const;
    expect(() => assertValidAuditEvent({ ...valid, changes: nan })).toThrow();
  });
});
