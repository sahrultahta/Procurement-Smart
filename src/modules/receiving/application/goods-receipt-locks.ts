import 'server-only';
import { lockOrderForReceiving, PO_STATUS_LABEL, takesReceipts, type OrderForReceiving } from '@/modules/purchasing';
import type { Actor } from '@/shared/application/context';
import type { Tx } from '@/shared/db/transaction';
import { fail, failBusinessRule } from '@/shared/result';
import {
  isGoodsReceiptKind,
  isGoodsReceiptStatus,
  nextGoodsReceiptStatus,
  type GoodsReceiptCommand,
  type GoodsReceiptKind,
  type GoodsReceiptStatus,
} from '../domain/goods-receipt';
import { findGoodsReceipt, lockGoodsReceipt, type GoodsReceiptRow } from '../infrastructure/goods-receipt-repository';

/*
 * Loading and locking goods receipts. Lock order (ADR 0008 C8): the purchase order, then its goods
 * receipt, then the order's lines in ascending id order (inside applyReceivedQuantities).
 */

export type LoadedReceipt = GoodsReceiptRow & { status: GoodsReceiptStatus; kind: GoodsReceiptKind };

export const GR_STATUS_LABEL: Record<GoodsReceiptStatus, string> = {
  draft: 'a draft',
  posted: 'posted',
  cancelled: 'cancelled',
};

function loaded(row: GoodsReceiptRow | null): LoadedReceipt {
  if (!row) fail('NOT_FOUND', 'Goods receipt not found.');
  if (!isGoodsReceiptStatus(row.status) || !isGoodsReceiptKind(row.kind)) throw new Error(`Unknown goods receipt status ${row.status} or kind ${row.kind}`);
  return { ...row, status: row.status, kind: row.kind };
}

/** Only the goods receipt, for commands that change nothing else (cancelling a draft). */
export async function lockReceiptRow(tx: Tx, id: string): Promise<LoadedReceipt> {
  return loaded(await lockGoodsReceipt(tx, id));
}

/** The purchase order first, then the goods receipt (C8). The receipt is read once without a lock to find its order. */
export async function lockReceiptWithOrder(tx: Tx, id: string): Promise<{ row: LoadedReceipt; order: OrderForReceiving }> {
  const found = await findGoodsReceipt(tx, id);
  if (!found) fail('NOT_FOUND', 'Goods receipt not found.');
  const order = await lockOrderForReceiving(tx, found.purchaseOrderId);
  if (!order) throw new Error(`purchase order ${found.purchaseOrderId} of goods receipt ${id} is missing`);
  return { row: loaded(await lockGoodsReceipt(tx, id)), order };
}

export function assertReceiptTransition(row: LoadedReceipt, command: GoodsReceiptCommand, verb: string): GoodsReceiptStatus {
  const status = nextGoodsReceiptStatus(row.kind, row.status, command);
  if (!status) fail('INVALID_TRANSITION', `A ${row.kind === 'reversal' ? 'reversal' : 'goods receipt'} that is ${GR_STATUS_LABEL[row.status]} cannot be ${verb}.`);
  return status;
}

export function assertReceiptVersion(row: GoodsReceiptRow, expectedVersion: number): void {
  if (row.version !== expectedVersion) fail('CONFLICT', 'This goods receipt was changed since you loaded it. Reload the page and try again.');
}

/** SOD-04: whoever created the purchase order never creates, posts, or reverses its receipts. */
export function assertNotOrderCreator(order: OrderForReceiving, actor: Actor): void {
  if (order.createdByUserId === actor.userId) {
    failBusinessRule('ORDER_RECEIVE_CONFLICT', `You created purchase order ${order.number}, so someone else must receive its goods.`);
  }
}

/** GR-T01 / T02 */
export function assertOrderTakesReceipts(order: OrderForReceiving): void {
  if (!takesReceipts(order.status)) {
    failBusinessRule('PO_NOT_RECEIVABLE', `Purchase order ${order.number} is ${PO_STATUS_LABEL[order.status]}, so it takes no more goods receipts.`);
  }
}
