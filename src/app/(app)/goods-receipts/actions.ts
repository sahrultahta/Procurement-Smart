'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { failed, integer, optional, text, type ActionState } from '@/lib/action-state';
import { cancelGoodsReceipt, createGoodsReceipt, postGoodsReceipt, reverseGoodsReceipt } from '@/modules/receiving';
import { getRequestContext } from '@/server/request-context';
import { runCommand } from '@/shared/application/runner';

/*
 * Goods-receipt Server Actions. What the order line ordered or received before, numbers, and who
 * did what are decided by the commands; the lines the form sends are parsed here and validated
 * strictly there. Redirects go only to ids the commands accepted or returned.
 */

const UNREADABLE: ActionState = {
  status: 'error',
  code: 'VALIDATION_FAILED',
  message: 'The lines could not be read. Reload the page and try again.',
};

function refresh(): void {
  revalidatePath('/goods-receipts', 'layout');
  revalidatePath('/purchase-orders', 'layout');
}

/** The form sends one `include` per received order line, and for each its quantity and note, named after the line. */
export async function createGoodsReceiptAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const included = form.getAll('include');
  if (!included.every((value) => typeof value === 'string')) return UNREADABLE;
  const key = text(form, 'idempotencyKey');
  const result = await runCommand(await getRequestContext(), createGoodsReceipt, {
    purchaseOrderId: text(form, 'purchaseOrderId'),
    receivedOn: text(form, 'receivedOn').trim(),
    deliveryNoteRef: optional(form, 'deliveryNoteRef'),
    notes: optional(form, 'notes'),
    lines: (included as string[]).map((id) => ({
      purchaseOrderLineId: id,
      quantity: text(form, `quantity-${id}`).trim(),
      note: optional(form, `note-${id}`),
    })),
    ...(key ? { idempotencyKey: key } : {}),
  });
  if (!result.ok) return failed(result.error);
  refresh();
  redirect(`/goods-receipts/${result.data.goodsReceiptId}?notice=created`);
}

export async function postGoodsReceiptAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const goodsReceiptId = text(form, 'goodsReceiptId');
  const result = await runCommand(await getRequestContext(), postGoodsReceipt, { goodsReceiptId, expectedVersion: integer(form, 'expectedVersion') });
  if (!result.ok) return failed(result.error);
  refresh();
  // Only reached on success, so the id passed the command's uuid validation.
  redirect(`/goods-receipts/${goodsReceiptId}?notice=posted`);
}

export async function cancelGoodsReceiptAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const goodsReceiptId = text(form, 'goodsReceiptId');
  const result = await runCommand(await getRequestContext(), cancelGoodsReceipt, {
    goodsReceiptId,
    expectedVersion: integer(form, 'expectedVersion'),
    reason: text(form, 'reason'),
  });
  if (!result.ok) return failed(result.error);
  refresh();
  redirect(`/goods-receipts/${goodsReceiptId}?notice=cancelled`);
}

export async function reverseGoodsReceiptAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const result = await runCommand(await getRequestContext(), reverseGoodsReceipt, {
    goodsReceiptId: text(form, 'goodsReceiptId'),
    expectedVersion: integer(form, 'expectedVersion'),
    reason: text(form, 'reason'),
  });
  if (!result.ok) return failed(result.error);
  refresh();
  redirect(`/goods-receipts/${result.data.goodsReceiptId}?notice=reversed`);
}
