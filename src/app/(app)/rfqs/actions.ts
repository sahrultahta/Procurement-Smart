'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { failed, integer, text, type ActionState } from '@/lib/action-state';
import { cancelRfq, closeRfq, createRfq, issueRfq, updateRfqDraft } from '@/modules/sourcing';
import { getRequestContext } from '@/server/request-context';
import { runCommand } from '@/shared/application/runner';

/*
 * RFQ Server Actions. Descriptions, units, numbers, and who did what are decided by the
 * commands; the lines and invitations the form sends are parsed here and validated strictly
 * there. Redirects go only to ids the commands accepted or returned.
 */

const UNREADABLE: ActionState = {
  status: 'error',
  code: 'VALIDATION_FAILED',
  message: 'The lines or suppliers could not be read. Reload the page and try again.',
};

function fields(form: FormData): { ok: true; value: Record<string, unknown> } | { ok: false } {
  try {
    return {
      ok: true,
      value: {
        title: text(form, 'title'),
        responseDueAt: text(form, 'responseDueAt'),
        lines: JSON.parse(text(form, 'lines')),
        supplierIds: JSON.parse(text(form, 'supplierIds')),
      },
    };
  } catch {
    return { ok: false };
  }
}

function refresh(): void {
  revalidatePath('/rfqs', 'layout');
  revalidatePath('/requisitions', 'layout');
}

export async function createRfqAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const input = fields(form);
  if (!input.ok) return UNREADABLE;
  const key = text(form, 'idempotencyKey');
  const result = await runCommand(await getRequestContext(), createRfq, {
    requisitionId: text(form, 'requisitionId'),
    ...input.value,
    ...(key ? { idempotencyKey: key } : {}),
  });
  if (!result.ok) return failed(result.error);
  refresh();
  redirect(`/rfqs/${result.data.rfqId}?notice=created`);
}

export async function updateRfqAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const input = fields(form);
  if (!input.ok) return UNREADABLE;
  const rfqId = text(form, 'rfqId');
  const result = await runCommand(await getRequestContext(), updateRfqDraft, { rfqId, expectedVersion: integer(form, 'expectedVersion'), ...input.value });
  if (!result.ok) return failed(result.error);
  refresh();
  // Only reached on success, so the id passed the command's uuid validation.
  redirect(`/rfqs/${rfqId}?notice=saved`);
}

export async function issueRfqAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const rfqId = text(form, 'rfqId');
  const result = await runCommand(await getRequestContext(), issueRfq, { rfqId, expectedVersion: integer(form, 'expectedVersion') });
  if (!result.ok) return failed(result.error);
  refresh();
  redirect(`/rfqs/${rfqId}?notice=issued`);
}

export async function closeRfqAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const rfqId = text(form, 'rfqId');
  const result = await runCommand(await getRequestContext(), closeRfq, { rfqId, expectedVersion: integer(form, 'expectedVersion') });
  if (!result.ok) return failed(result.error);
  refresh();
  redirect(`/rfqs/${rfqId}?notice=closed`);
}

export async function cancelRfqAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const rfqId = text(form, 'rfqId');
  const result = await runCommand(await getRequestContext(), cancelRfq, {
    rfqId,
    expectedVersion: integer(form, 'expectedVersion'),
    reason: text(form, 'reason'),
  });
  if (!result.ok) return failed(result.error);
  refresh();
  redirect(`/rfqs/${rfqId}?notice=cancelled`);
}
