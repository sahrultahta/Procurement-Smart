'use server';

import { revalidatePath } from 'next/cache';
import {
  createDepartment,
  createUser,
  deactivateUser,
  grantRole,
  reactivateUser,
  revokeRole,
  updateDepartment,
  updateUser,
} from '@/modules/identity';
import { issueSetupLink } from '@/server/admin-links';
import { getRequestContext } from '@/server/request-context';
import { runCommand } from '@/shared/application/runner';
import { failed, integer, optional, outcome, text, type ActionState } from './action-state';

/*
 * Admin Server Actions: thin adapters from form fields to commands. Every check
 * (session, permission, validation, SoD, versions) happens in runCommand, so a direct
 * POST that skips the page gets exactly the same answers (P3b-AC11). Next.js rejects
 * cross-origin calls before any of this runs.
 */

const SCOPED = ['requester', 'approver'];

export async function createUserAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const request = await getRequestContext();
  const roles = form
    .getAll('role')
    .filter((role): role is string => typeof role === 'string')
    .map((role) => ({ role, departmentCode: SCOPED.includes(role) ? optional(form, `scope.${role}`) : null }));
  const created = await runCommand(request, createUser, {
    email: text(form, 'email'),
    name: text(form, 'name'),
    departmentCode: optional(form, 'departmentCode'),
    roles,
  });
  if (!created.ok) return failed(created.error);
  revalidatePath('/admin/users');

  const { userId } = created.data;
  const link = await issueSetupLink(request, userId);
  if (!link.ok) {
    return {
      status: 'ok',
      userId,
      message: 'User created, but the setup link could not be created. Open the user and issue a new link.',
    };
  }
  return { status: 'ok', userId, link: link.data.url, message: 'User created. Give them this one-time link.' };
}

export async function updateUserAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const userId = text(form, 'userId');
  const result = await runCommand(await getRequestContext(), updateUser, {
    userId,
    name: text(form, 'name'),
    departmentCode: optional(form, 'departmentCode'),
    expectedVersion: integer(form, 'expectedVersion'),
  });
  if (result.ok) revalidatePath('/admin/users', 'layout');
  return outcome(result, 'Profile saved.');
}

export async function deactivateUserAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const userId = text(form, 'userId');
  const result = await runCommand(await getRequestContext(), deactivateUser, {
    userId,
    reason: text(form, 'reason'),
    expectedVersion: integer(form, 'expectedVersion'),
  });
  if (result.ok) revalidatePath('/admin/users', 'layout');
  return outcome(result, 'User deactivated. All their sessions have ended.');
}

export async function reactivateUserAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const userId = text(form, 'userId');
  const result = await runCommand(await getRequestContext(), reactivateUser, {
    userId,
    expectedVersion: integer(form, 'expectedVersion'),
  });
  if (result.ok) revalidatePath('/admin/users', 'layout');
  return outcome(result, 'User reactivated. They can sign in again.');
}

export async function issueSetupLinkAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const userId = text(form, 'userId');
  const result = await issueSetupLink(await getRequestContext(), userId);
  if (!result.ok) return failed(result.error);
  revalidatePath('/admin/users', 'layout');
  return { status: 'ok', link: result.data.url, message: 'New one-time link created. Earlier links no longer work.' };
}

export async function grantRoleAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const userId = text(form, 'userId');
  const result = await runCommand(await getRequestContext(), grantRole, {
    userId,
    role: text(form, 'role'),
    departmentCode: optional(form, 'departmentCode'),
  });
  if (result.ok) revalidatePath('/admin/users', 'layout');
  return outcome(result, 'Role granted.');
}

export async function revokeRoleAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const result = await runCommand(await getRequestContext(), revokeRole, {
    assignmentId: text(form, 'assignmentId'),
    reason: text(form, 'reason'),
  });
  if (result.ok) revalidatePath('/admin/users', 'layout');
  return outcome(result, 'Role revoked.');
}

export async function createDepartmentAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const result = await runCommand(await getRequestContext(), createDepartment, {
    code: text(form, 'code').trim().toUpperCase(),
    name: text(form, 'name'),
  });
  if (result.ok) revalidatePath('/admin/departments');
  return outcome(result, 'Department created.');
}

export async function updateDepartmentAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const result = await runCommand(await getRequestContext(), updateDepartment, {
    departmentId: text(form, 'departmentId'),
    name: text(form, 'name'),
    isActive: text(form, 'isActive') === 'on',
    expectedVersion: integer(form, 'expectedVersion'),
  });
  if (result.ok) revalidatePath('/admin/departments');
  return outcome(result, 'Department saved.');
}
