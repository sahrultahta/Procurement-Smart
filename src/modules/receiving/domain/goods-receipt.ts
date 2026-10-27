import { Dec, dec } from '@/shared/decimal/decimal';

/**
 * Goods receipt rules with no I/O (docs/state-machines.md §6).
 */
export const GOODS_RECEIPT_STATUSES = ['draft', 'posted', 'cancelled'] as const;
export type GoodsReceiptStatus = (typeof GOODS_RECEIPT_STATUSES)[number];

/** A receipt records goods that arrived; a reversal undoes one posted receipt, line for line. */
export const GOODS_RECEIPT_KINDS = ['receipt', 'reversal'] as const;
export type GoodsReceiptKind = (typeof GOODS_RECEIPT_KINDS)[number];

/** Everything that can happen to an existing goods receipt (`create`, GR-T01, starts in draft). */
export const GOODS_RECEIPT_COMMANDS = ['post', 'cancel', 'reverse'] as const;
export type GoodsReceiptCommand = (typeof GOODS_RECEIPT_COMMANDS)[number];

/**
 * GR-T02 to T04. Any (kind, status, command) not listed is an invalid transition. A posted receipt
 * stays posted when it is reversed: the reversal is a separate document. A reversal is created and
 * posted by one command, so it is never cancelled or reversed itself.
 */
const TRANSITIONS: Readonly<Record<GoodsReceiptKind, Record<GoodsReceiptStatus, Partial<Record<GoodsReceiptCommand, GoodsReceiptStatus>>>>> = {
  receipt: {
    draft: {
      post: 'posted', // GR-T02
      cancel: 'cancelled', // GR-T03
    },
    posted: {
      reverse: 'posted', // GR-T04 (once: ALREADY_REVERSED)
    },
    cancelled: {},
  },
  reversal: {
    draft: {
      post: 'posted', // GR-T04, in the same transaction that creates it
    },
    posted: {},
    cancelled: {},
  },
};

export function nextGoodsReceiptStatus(kind: GoodsReceiptKind, from: GoodsReceiptStatus, command: GoodsReceiptCommand): GoodsReceiptStatus | null {
  return TRANSITIONS[kind][from][command] ?? null;
}

export function isGoodsReceiptStatus(value: string): value is GoodsReceiptStatus {
  return (GOODS_RECEIPT_STATUSES as readonly string[]).includes(value);
}

export function isGoodsReceiptKind(value: string): value is GoodsReceiptKind {
  return (GOODS_RECEIPT_KINDS as readonly string[]).includes(value);
}

/** What a purchase order line can still take: max_receivable_qty − received_qty, never below 0. */
export function remainingReceivable(maxReceivableQty: string, receivedQty: string): string {
  return Dec.max(dec(maxReceivableQty).sub(dec(receivedQty)), 0).toString();
}

/**
 * OVER_RECEIPT (GR-T02): every line whose quantity is more than its order line can still take,
 * with what it can still take. Exact decimal comparison: receiving exactly the remainder is fine.
 */
export function overReceivedLines(
  lines: readonly { lineNo: number; quantity: string; receivedQty: string; maxReceivableQty: string }[],
): { lineNo: number; remaining: string }[] {
  return lines.flatMap((line) => {
    const remaining = remainingReceivable(line.maxReceivableQty, line.receivedQty);
    return dec(line.quantity).gt(dec(remaining)) ? [{ lineNo: line.lineNo, remaining }] : [];
  });
}

export const MAX_GR_LINES = 200;
export const MAX_DELIVERY_NOTE_REF = 100;
export const MAX_NOTES = 1000;
export const MAX_LINE_NOTE = 500;
export const MAX_REASON = 500;
