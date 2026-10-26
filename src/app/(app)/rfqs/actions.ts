'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { failed, integer, optional, text, type ActionState } from '@/lib/action-state';
import {
  awardQuotation,
  cancelRfq,
  closeRfq,
  createRfq,
  issueRfq,
  recordQuotation,
  submitQuotation,
  updateQuotationDraft,
  updateRfqDraft,
  withdrawQuotation,
} from '@/modules/sourcing';
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

// --- Quotations (Phase 6b). Quantities, totals, and the currency are decided by the commands,
// and redirects go to the RFQ the command itself returned. ---

const UNREADABLE_PRICES: ActionState = {
  status: 'error',
  code: 'VALIDATION_FAILED',
  message: 'The prices could not be read. Reload the page and try again.',
};

/** The form sends one `rfqLineId` and one `unitPrice` per RFQ line, in the same order. */
function quotationFields(form: FormData): { ok: true; value: Record<string, unknown> } | { ok: false } {
  const ids = form.getAll('rfqLineId');
  const prices = form.getAll('unitPrice');
  if (ids.length !== prices.length || ![...ids, ...prices].every((v) => typeof v === 'string')) return { ok: false };
  return {
    ok: true,
    value: {
      supplierReference: optional(form, 'supplierReference'),
      validUntil: text(form, 'validUntil'),
      leadTimeDays: integer(form, 'leadTimeDays'),
      lines: ids.map((id, i) => ({ rfqLineId: id, unitPrice: String(prices[i]).trim() })),
    },
  };
}

export async function recordQuotationAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const input = quotationFields(form);
  if (!input.ok) return UNREADABLE_PRICES;
  const rfqId = text(form, 'rfqId');
  const key = text(form, 'idempotencyKey');
  const result = await runCommand(await getRequestContext(), recordQuotation, {
    rfqId,
    supplierId: text(form, 'supplierId'),
    ...input.value,
    ...(key ? { idempotencyKey: key } : {}),
  });
  if (!result.ok) return failed(result.error);
  refresh();
  // Only reached on success, so the id passed the command's uuid validation.
  redirect(`/rfqs/${rfqId}?notice=quotation-recorded`);
}

export async function updateQuotationAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const input = quotationFields(form);
  if (!input.ok) return UNREADABLE_PRICES;
  const result = await runCommand(await getRequestContext(), updateQuotationDraft, {
    quotationId: text(form, 'quotationId'),
    expectedVersion: integer(form, 'expectedVersion'),
    ...input.value,
  });
  if (!result.ok) return failed(result.error);
  refresh();
  redirect(`/rfqs/${result.data.rfqId}?notice=quotation-saved`);
}

export async function submitQuotationAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const result = await runCommand(await getRequestContext(), submitQuotation, {
    quotationId: text(form, 'quotationId'),
    expectedVersion: integer(form, 'expectedVersion'),
  });
  if (!result.ok) return failed(result.error);
  refresh();
  redirect(`/rfqs/${result.data.rfqId}?notice=${result.data.late ? 'quotation-submitted-late' : 'quotation-submitted'}`);
}

export async function withdrawQuotationAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  // Only picks the notice: the command decides from the quotation's status what withdrawing means.
  const discarding = text(form, 'mode') === 'discard';
  const result = await runCommand(await getRequestContext(), withdrawQuotation, {
    quotationId: text(form, 'quotationId'),
    expectedVersion: integer(form, 'expectedVersion'),
    reason: text(form, 'reason'),
  });
  if (!result.ok) return failed(result.error);
  refresh();
  redirect(`/rfqs/${result.data.rfqId}?notice=${discarding ? 'quotation-discarded' : 'quotation-withdrawn'}`);
}

export async function awardQuotationAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const rfqId = text(form, 'rfqId');
  const result = await runCommand(await getRequestContext(), awardQuotation, {
    rfqId,
    quotationId: text(form, 'quotationId'),
    expectedVersion: integer(form, 'expectedVersion'),
    justification: optional(form, 'justification'),
  });
  if (!result.ok) return failed(result.error);
  refresh();
  redirect(`/rfqs/${rfqId}?notice=awarded`);
}
