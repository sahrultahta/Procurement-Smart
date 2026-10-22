'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  blockSupplier,
  createSupplier,
  deactivateSupplier,
  reactivateSupplier,
  reviewSupplier,
  unblockSupplier,
  updateSupplierDetails,
} from '@/modules/suppliers';
import { getRequestContext } from '@/server/request-context';
import { runCommand } from '@/shared/application/runner';
import { failed, integer, text, type ActionState } from '@/lib/action-state';
import type { Result } from '@/shared/result';
import type { SupplierNotice } from './notices';

/*
 * Supplier Server Actions: form fields → commands. Permissions, SoD (maker-checker),
 * versions, and transitions are all decided by the command runner (P3b-AC11 pattern).
 */

function supplierFields(form: FormData) {
  return {
    legalName: text(form, 'legalName'),
    taxId: text(form, 'taxId'),
    email: text(form, 'email'),
    phone: text(form, 'phone'),
    addressLine1: text(form, 'addressLine1'),
    addressLine2: text(form, 'addressLine2'),
    city: text(form, 'city'),
    region: text(form, 'region'),
    postalCode: text(form, 'postalCode'),
    countryCode: text(form, 'countryCode'),
  };
}

const target = (form: FormData) => ({ supplierId: text(form, 'supplierId'), expectedVersion: integer(form, 'expectedVersion') });

/**
 * After a status change the form that made it disappears (the new status offers other
 * actions), so the confirmation travels as a notice on the reloaded page instead.
 * Only reached on success, so the id has passed the command's uuid validation.
 */
function done(result: Result<unknown>, form: FormData, notice: SupplierNotice): ActionState {
  if (!result.ok) return failed(result.error);
  revalidatePath('/suppliers', 'layout');
  redirect(`/suppliers/${text(form, 'supplierId')}?notice=${notice}`);
}

export async function createSupplierAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const result = await runCommand(await getRequestContext(), createSupplier, supplierFields(form));
  if (!result.ok) return failed(result.error);
  revalidatePath('/suppliers');
  redirect(`/suppliers/${result.data.supplierId}`);
}

export async function updateSupplierAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const result = await runCommand(await getRequestContext(), updateSupplierDetails, { ...target(form), ...supplierFields(form) });
  if (!result.ok) return failed(result.error);
  revalidatePath('/suppliers', 'layout');
  return {
    status: 'ok',
    message:
      result.data.status === 'pending_review'
        ? 'Saved. The supplier is pending review: someone other than you must approve it.'
        : 'Saved.',
  };
}

export async function reviewSupplierAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const decision = text(form, 'decision');
  const result = await runCommand(await getRequestContext(), reviewSupplier, { ...target(form), decision, note: text(form, 'note') });
  return done(result, form, decision === 'reject' ? 'rejected' : 'approved');
}

export async function blockSupplierAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const result = await runCommand(await getRequestContext(), blockSupplier, { ...target(form), reason: text(form, 'reason') });
  return done(result, form, 'blocked');
}

export async function unblockSupplierAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const result = await runCommand(await getRequestContext(), unblockSupplier, { ...target(form), reason: text(form, 'reason') });
  return done(result, form, 'unblocked');
}

export async function deactivateSupplierAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const result = await runCommand(await getRequestContext(), deactivateSupplier, { ...target(form), reason: text(form, 'reason') });
  return done(result, form, 'deactivated');
}

export async function reactivateSupplierAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const result = await runCommand(await getRequestContext(), reactivateSupplier, target(form));
  return done(result, form, 'reactivated');
}
