import { DEPARTMENT_SCOPED_ROLES, ROLES, ROLE_LABELS } from '@/modules/identity';
import type { RoleOption } from './_components/create-user-form';

/** Role choices for the admin forms, from the code-defined roles (ADR 0006). */
export const ROLE_OPTIONS: RoleOption[] = ROLES.map((role) => ({
  value: role,
  label: ROLE_LABELS[role],
  scopable: DEPARTMENT_SCOPED_ROLES.includes(role),
}));
