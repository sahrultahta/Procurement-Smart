'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { failed, integer, optional, text, type ActionState } from '@/lib/action-state';
import {
  cancelPurchaseOrder,
  closePurchaseOrder,
  createPurchaseOrder,
  issuePurchaseOrder,
  submitPurchaseOrder,
  updatePurchaseOrderDraft,
} from '@/modules/purchasing';
import { getRequestContext } from '@/server/request-context';
import { runCommand } from '@/shared/application/runner';

/*
 * Purchase-order Server Actions. Descriptions, units, prices from quotations, totals, numbers, and
 * who did what are decided by the commands; the lines the form sends are parsed here and validated
 * strictly there. Redirects go only to ids the commands accepted or returned.
 */

const UNREADABLE: ActionState = {
  status: 'error',
  code: 'VALIDATION_FAILED',
  message: 'The lines could not be read. Reload the page and try again.',
};

/**
 * The form sends one `include` per ordered requisition line, and for each its quantity, tax rate,
 * and either the quoted line or a unit price, named after the line.
 */
function orderFields(form: FormData): { ok: true; value: Record<string, unknown> } | { ok: false } {
  const included = form.getAll('include');
  if (!included.every((value) => typeof value === 'string')) return { ok: false };
  return {
    ok: true,
    value: {
      paymentTerms: optional(form, 'paymentTerms'),
      deliveryAddress: optional(form, 'deliveryAddress'),
      expectedDeliveryDate: optional(form, 'expectedDeliveryDate'),
      lines: (included as string[]).map((id) => {
        const quotationLineId = optional(form, `quotationLineId-${id}`);
        return {
          requisitionLineId: id,
          quantity: text(form, `quantity-${id}`).trim(),
          taxRatePct: text(form, `taxRatePct-${id}`).trim(),
          ...(quotationLineId ? { quotationLineId } : { unitPrice: text(form, `unitPrice-${id}`).trim() }),
        };
      }),
    },
  };
}

function refresh(): void {
  revalidatePath('/purchase-orders', 'layout');
  revalidatePath('/requisitions', 'layout');
  revalidatePath('/approvals');
}

export async function createPurchaseOrderAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const input = orderFields(form);
  if (!input.ok) return UNREADABLE;
  const key = text(form, 'idempotencyKey');
  const quotationId = optional(form, 'quotationId');
  const result = await runCommand(await getRequestContext(), createPurchaseOrder, {
    requisitionId: text(form, 'requisitionId'),
    supplierId: text(form, 'supplierId'),
    ...(quotationId ? { quotationId } : {}),
    ...input.value,
    ...(key ? { idempotencyKey: key } : {}),
  });
  if (!result.ok) return failed(result.error);
  refresh();
  redirect(`/purchase-orders/${result.data.purchaseOrderId}?notice=created`);
}

export async function updatePurchaseOrderAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const input = orderFields(form);
  if (!input.ok) return UNREADABLE;
  const purchaseOrderId = text(form, 'purchaseOrderId');
  const result = await runCommand(await getRequestContext(), updatePurchaseOrderDraft, {
    purchaseOrderId,
    expectedVersion: integer(form, 'expectedVersion'),
    ...input.value,
  });
  if (!result.ok) return failed(result.error);
  refresh();
  // Only reached on success, so the id passed the command's uuid validation.
  redirect(`/purchase-orders/${purchaseOrderId}?notice=saved`);
}

export async function submitPurchaseOrderAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const purchaseOrderId = text(form, 'purchaseOrderId');
  const result = await runCommand(await getRequestContext(), submitPurchaseOrder, { purchaseOrderId, expectedVersion: integer(form, 'expectedVersion') });
  if (!result.ok) return failed(result.error);
  refresh();
  redirect(`/purchase-orders/${purchaseOrderId}?notice=${result.data.status === 'approved' ? 'submitted-approved' : 'submitted-approval'}`);
}

export async function issuePurchaseOrderAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const purchaseOrderId = text(form, 'purchaseOrderId');
  const result = await runCommand(await getRequestContext(), issuePurchaseOrder, { purchaseOrderId, expectedVersion: integer(form, 'expectedVersion') });
  if (!result.ok) return failed(result.error);
  refresh();
  redirect(`/purchase-orders/${purchaseOrderId}?notice=issued`);
}

export async function cancelPurchaseOrderAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const purchaseOrderId = text(form, 'purchaseOrderId');
  const result = await runCommand(await getRequestContext(), cancelPurchaseOrder, {
    purchaseOrderId,
    expectedVersion: integer(form, 'expectedVersion'),
    reason: text(form, 'reason'),
  });
  if (!result.ok) return failed(result.error);
  refresh();
  redirect(`/purchase-orders/${purchaseOrderId}?notice=cancelled`);
}

export async function closePurchaseOrderAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const purchaseOrderId = text(form, 'purchaseOrderId');
  const result = await runCommand(await getRequestContext(), closePurchaseOrder, {
    purchaseOrderId,
    expectedVersion: integer(form, 'expectedVersion'),
    reason: text(form, 'reason'),
  });
  if (!result.ok) return failed(result.error);
  refresh();
  redirect(`/purchase-orders/${purchaseOrderId}?notice=closed`);
}
