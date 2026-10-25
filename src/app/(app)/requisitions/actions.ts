'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { failed, integer, text, type ActionState } from '@/lib/action-state';
import { cancelRequisition, closeRequisition, createRequisition, submitRequisition, updateRequisitionDraft } from '@/modules/requisitions';
import { decideApproval } from '@/server/approvals';
import { getRequestContext } from '@/server/request-context';
import { runCommand } from '@/shared/application/runner';

/*
 * Requisition Server Actions. Totals, department, currency, and number are decided by the
 * commands; whatever the form sends for lines is parsed here and validated strictly there.
 * Redirects go only to ids the commands accepted (or returned), never to raw form text.
 */

const UNREADABLE: ActionState = {
  status: 'error',
  code: 'VALIDATION_FAILED',
  message: 'The lines could not be read. Reload the page and try again.',
};

function fields(form: FormData): { ok: true; value: Record<string, unknown> } | { ok: false } {
  let lines: unknown;
  try {
    lines = JSON.parse(text(form, 'lines'));
  } catch {
    return { ok: false };
  }
  return {
    ok: true,
    value: { title: text(form, 'title'), justification: text(form, 'justification'), neededBy: text(form, 'neededBy'), lines },
  };
}

function refresh(): void {
  revalidatePath('/requisitions', 'layout');
  revalidatePath('/approvals');
}

export async function createRequisitionAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const input = fields(form);
  if (!input.ok) return UNREADABLE;
  const key = text(form, 'idempotencyKey');
  const result = await runCommand(await getRequestContext(), createRequisition, { ...input.value, ...(key ? { idempotencyKey: key } : {}) });
  if (!result.ok) return failed(result.error);
  revalidatePath('/requisitions');
  redirect(`/requisitions/${result.data.requisitionId}?notice=created`);
}

export async function updateRequisitionAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const input = fields(form);
  if (!input.ok) return UNREADABLE;
  const requisitionId = text(form, 'requisitionId');
  const result = await runCommand(await getRequestContext(), updateRequisitionDraft, {
    requisitionId,
    expectedVersion: integer(form, 'expectedVersion'),
    ...input.value,
  });
  if (!result.ok) return failed(result.error);
  refresh();
  // Only reached on success, so the id passed the command's uuid validation.
  redirect(`/requisitions/${requisitionId}?notice=saved`);
}

export async function submitRequisitionAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const requisitionId = text(form, 'requisitionId');
  const result = await runCommand(await getRequestContext(), submitRequisition, { requisitionId, expectedVersion: integer(form, 'expectedVersion') });
  if (!result.ok) return failed(result.error);
  refresh();
  redirect(`/requisitions/${requisitionId}?notice=submitted`);
}

export async function cancelRequisitionAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const requisitionId = text(form, 'requisitionId');
  const result = await runCommand(await getRequestContext(), cancelRequisition, {
    requisitionId,
    expectedVersion: integer(form, 'expectedVersion'),
    reason: text(form, 'reason'),
  });
  if (!result.ok) return failed(result.error);
  refresh();
  redirect(`/requisitions/${requisitionId}?notice=${text(form, 'mode') === 'withdraw' ? 'withdrawn' : 'cancelled'}`);
}

export async function closeRequisitionAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const requisitionId = text(form, 'requisitionId');
  const result = await runCommand(await getRequestContext(), closeRequisition, {
    requisitionId,
    expectedVersion: integer(form, 'expectedVersion'),
    reason: text(form, 'reason'),
  });
  if (!result.ok) return failed(result.error);
  refresh();
  redirect(`/requisitions/${requisitionId}?notice=closed`);
}

export async function decideApprovalAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const result = await runCommand(await getRequestContext(), decideApproval, {
    approvalRequestId: text(form, 'approvalRequestId'),
    stepNo: integer(form, 'stepNo'),
    expectedVersion: integer(form, 'expectedVersion'),
    decision: text(form, 'decision'),
    comment: text(form, 'comment'),
  });
  if (!result.ok) return failed(result.error);
  refresh();
  const notice = result.data.requestStatus === 'pending' ? 'step-approved' : `decided-${result.data.requestStatus}`;
  redirect(`/requisitions/${result.data.documentId}?notice=${notice}`);
}
