import 'server-only';
import { z } from 'zod';
import { auditChanges, recordAuditEvent } from '@/modules/audit';
import { defineCommand, defineQuery } from '@/shared/application/runner';
import { fail, failBusinessRule } from '@/shared/result';
import {
  findDepartmentIdByCode,
  insertDepartment,
  listDepartments as listDepartmentRows,
  lockDepartment,
  updateDepartment as updateDepartmentRow,
} from '../infrastructure/admin-repository';
import { versionField } from './admin-users';
import { departmentAudit } from './audit-policies';
import { departmentCode } from './provision-user';

/*
 * Departments. The code is fixed once created: audit events and role scopes refer to
 * it. A deactivated department keeps its existing members and assignments, but cannot
 * be given to anyone new.
 */

const departmentName = z.string().trim().min(1, 'Enter a name').max(120);

export const createDepartment = defineCommand({
  name: 'admin.department.create',
  permission: 'admin.settings',
  input: z.strictObject({ code: departmentCode, name: departmentName }),
  handler: async ({ tx, request }, input): Promise<{ departmentId: string }> => {
    if (await findDepartmentIdByCode(tx, input.code)) {
      failBusinessRule('DEPARTMENT_CODE_TAKEN', `A department with code ${input.code} already exists.`);
    }
    const departmentId = await insertDepartment(tx, { code: input.code, name: input.name });
    await recordAuditEvent(tx, request, {
      action: 'department.created',
      entityType: 'department',
      entityId: departmentId,
      changes: auditChanges(departmentAudit, null, { code: input.code, name: input.name, isActive: true }),
    });
    return { departmentId };
  },
});

export const updateDepartment = defineCommand({
  name: 'admin.department.update',
  permission: 'admin.settings',
  input: z.strictObject({
    departmentId: z.uuid(),
    name: departmentName,
    isActive: z.boolean(),
    expectedVersion: versionField,
  }),
  handler: async ({ tx, request }, input): Promise<{ version: number }> => {
    const department = await lockDepartment(tx, input.departmentId);
    if (!department) fail('NOT_FOUND', 'Department not found.');
    if (department.version !== input.expectedVersion) {
      fail('CONFLICT', 'This department was changed by someone else. Reload the page and try again.');
    }
    const changes = auditChanges(
      departmentAudit,
      { name: department.name, isActive: department.isActive },
      { name: input.name, isActive: input.isActive },
    );
    if (Object.keys(changes).length === 0) return { version: department.version };

    const version = await updateDepartmentRow(tx, department.id, department.version, {
      name: input.name,
      isActive: input.isActive,
    });
    await recordAuditEvent(tx, request, { action: 'department.updated', entityType: 'department', entityId: department.id, changes });
    return { version };
  },
});

export type DepartmentDto = { id: string; code: string; name: string; isActive: boolean; version: number };
export const DEPARTMENT_DTO_KEYS = ['id', 'code', 'name', 'isActive', 'version'] as const;

export const listDepartments = defineQuery({
  name: 'admin.department.list',
  permission: 'admin.settings',
  input: z.strictObject({}),
  handler: async ({ tx }): Promise<DepartmentDto[]> =>
    (await listDepartmentRows(tx)).map((d) => ({
      id: d.id,
      code: d.code,
      name: d.name,
      isActive: d.isActive,
      version: d.version,
    })),
});
