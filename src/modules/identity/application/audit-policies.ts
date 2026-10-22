import { defineAuditPolicy } from '@/modules/audit';

/** Which identity fields may appear in audit `changes` (ADR 0009). Credentials and tokens never do. */
export const userAudit = defineAuditPolicy<{ email: string; name: string; departmentCode: string | null }>({
  entityType: 'user',
  fields: ['email', 'name', 'departmentCode'],
});

export const userStatusAudit = defineAuditPolicy<{
  status: string;
  revokedSessions: number;
  invalidatedSetupLinks: number;
}>({
  entityType: 'user',
  fields: ['status', 'revokedSessions', 'invalidatedSetupLinks'],
});

export const roleAudit = defineAuditPolicy<{ userId: string; role: string; departmentCode: string | null }>({
  entityType: 'role_assignment',
  fields: ['userId', 'role', 'departmentCode'],
});

export const departmentAudit = defineAuditPolicy<{ code: string; name: string; isActive: boolean }>({
  entityType: 'department',
  fields: ['code', 'name', 'isActive'],
});
