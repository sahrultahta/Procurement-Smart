/**
 * Roles and permissions are defined in code (ADR 0006, ADR 0014). Changing them is a
 * reviewed code change. Admins can only assign or revoke roles.
 */
export const ROLES = ['admin', 'requester', 'approver', 'procurement', 'receiver', 'finance', 'auditor'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'account.read',
  'requisition.create',
  'requisition.read.own',
  'requisition.read.department',
  'requisition.read.all',
  'approval.decide',
  'supplier.read',
  'supplier.manage',
  'supplier.review',
  'supplier.block',
  'rfq.read',
  'rfq.manage',
  'quotation.record',
  'quotation.award',
  'po.create',
  'po.read.all',
  'po.read.issued',
  'receipt.create',
  'receipt.read',
  'report.view',
  'audit.read',
  'admin.users',
  'admin.roles',
  'admin.settings',
  'admin.approvalPolicies',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Every signed-in, active user can read their own account, even with no role yet. */
export const BASE_PERMISSIONS: readonly Permission[] = ['account.read'];

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  requester: ['requisition.create', 'requisition.read.own'],
  approver: ['requisition.read.department', 'approval.decide'],
  procurement: [
    'requisition.read.all',
    'supplier.read',
    'supplier.manage',
    'supplier.block',
    'rfq.read',
    'rfq.manage',
    'quotation.record',
    'quotation.award',
    'po.create',
    'po.read.all',
    'receipt.read',
    'report.view',
  ],
  receiver: ['po.read.issued', 'receipt.create', 'receipt.read'],
  finance: [
    'requisition.read.all',
    'approval.decide',
    'supplier.read',
    'supplier.review',
    'supplier.block',
    'rfq.read',
    'po.read.all',
    'receipt.read',
    'report.view',
  ],
  auditor: ['requisition.read.all', 'supplier.read', 'rfq.read', 'po.read.all', 'receipt.read', 'report.view', 'audit.read'],
  // Admin grants no business permissions (ADR 0006).
  admin: ['audit.read', 'admin.users', 'admin.roles', 'admin.settings', 'admin.approvalPolicies'],
};

/** Roles whose assignment can be limited to one department (scope). Others are organization-wide. */
export const DEPARTMENT_SCOPED_ROLES: readonly Role[] = ['requester', 'approver'];

export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  admin: 'Admin',
  requester: 'Requester',
  approver: 'Approver',
  procurement: 'Procurement',
  receiver: 'Receiver',
  finance: 'Finance',
  auditor: 'Auditor',
};

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function permissionsForRoles(roles: readonly Role[]): ReadonlySet<Permission> {
  const permissions = new Set<Permission>(BASE_PERMISSIONS);
  for (const role of roles) for (const permission of ROLE_PERMISSIONS[role]) permissions.add(permission);
  return permissions;
}
