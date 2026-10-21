import { describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLES, ROLE_PERMISSIONS, permissionsForRoles, type Permission, type Role } from '@/modules/identity/domain/roles';

// P3a-AC7: the role → permission map matches ADR 0006 (with buyer renamed procurement, ADR 0014),
// cell by cell. The expected table is written out independently of the implementation.
const R = 'requester';
const A = 'approver';
const P = 'procurement';
const V = 'receiver';
const F = 'finance';
const U = 'auditor';
const D = 'admin';

const EXPECTED: Record<Permission, readonly Role[]> = {
  'account.read': [], // base permission for every active user, not a role permission
  'requisition.create': [R],
  'requisition.read.own': [R],
  'requisition.read.department': [A],
  'requisition.read.all': [P, F, U],
  'approval.decide': [A, F],
  'supplier.read': [P, F, U],
  'supplier.manage': [P],
  'supplier.review': [F],
  'rfq.manage': [P],
  'quotation.record': [P],
  'quotation.award': [P],
  'po.create': [P],
  'po.read.all': [P, F, U],
  'po.read.issued': [V],
  'receipt.create': [V],
  'receipt.read': [P, V, F, U],
  'report.view': [P, F, U],
  'audit.read': [U, D],
  'admin.users': [D],
  'admin.roles': [D],
  'admin.settings': [D],
  'admin.approvalPolicies': [D],
};

describe('role → permission matrix (ADR 0006 / 0014)', () => {
  const cells = ROLES.flatMap((role) => PERMISSIONS.map((permission) => [role, permission] as const));

  it.each(cells)('%s × %s', (role, permission) => {
    expect(ROLE_PERMISSIONS[role].includes(permission)).toBe(EXPECTED[permission].includes(role));
  });

  it('covers exactly the 7 agreed roles', () => {
    expect([...ROLES].sort()).toEqual(['admin', 'approver', 'auditor', 'finance', 'procurement', 'receiver', 'requester']);
  });

  it('gives admin no business permissions', () => {
    const business = ROLE_PERMISSIONS.admin.filter((p) => !p.startsWith('admin.') && p !== 'audit.read');
    expect(business).toEqual([]);
  });

  it('gives every user the base permission and unions role permissions', () => {
    expect([...permissionsForRoles([])]).toEqual(['account.read']);
    const combined = permissionsForRoles(['requester', 'receiver']);
    expect(combined.has('requisition.create')).toBe(true);
    expect(combined.has('receipt.create')).toBe(true);
    expect(combined.has('po.create')).toBe(false);
  });
});
