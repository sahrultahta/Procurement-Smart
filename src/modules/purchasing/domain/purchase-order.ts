import { Dec, dec } from '@/shared/decimal/decimal';

/**
 * Purchase order rules with no I/O (docs/state-machines.md §5).
 */
export const PURCHASE_ORDER_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'issued',
  'partially_received',
  'received',
  'closed',
  'rejected',
  'cancelled',
] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

/**
 * Everything that can happen to an existing purchase order (`create`, PO-T01, starts in draft).
 * Submitting has two outcomes (PO-T03): `submit` sends it to approval, `auto_approve` approves it
 * at once when no approval is required. Receipts move an issued order between issued, partially
 * received, and received (PO-T06): see `receiptStatus`.
 */
export const PURCHASE_ORDER_COMMANDS = ['update', 'submit', 'auto_approve', 'approve', 'return', 'reject', 'issue', 'close', 'cancel'] as const;
export type PurchaseOrderCommand = (typeof PURCHASE_ORDER_COMMANDS)[number];

/** PO-T02 to T05 and T07 to T09. Any (status, command) pair not listed is an invalid transition. */
const TRANSITIONS: Readonly<Record<PurchaseOrderStatus, Partial<Record<PurchaseOrderCommand, PurchaseOrderStatus>>>> = {
  draft: {
    update: 'draft', // PO-T02
    submit: 'pending_approval', // PO-T03, approval required
    auto_approve: 'approved', // PO-T03, no approval required (audited as BELOW_THRESHOLD)
    cancel: 'cancelled', // PO-T08
  },
  pending_approval: {
    approve: 'approved', // PO-T04 (system, from the last approved step)
    return: 'draft', // PO-T04 (system)
    reject: 'rejected', // PO-T04 (system); releases every reserved quantity
    cancel: 'cancelled', // PO-T08 (withdraws the approval round)
  },
  approved: {
    issue: 'issued', // PO-T05
    cancel: 'cancelled', // PO-T08
  },
  issued: {
    close: 'closed', // PO-T07
    cancel: 'cancelled', // PO-T09 (no receipts)
  },
  partially_received: {
    close: 'closed', // PO-T07 (short-close)
  },
  received: {
    close: 'closed', // PO-T07
  },
  closed: {},
  rejected: {},
  cancelled: {},
};

export function nextPurchaseOrderStatus(from: PurchaseOrderStatus, command: PurchaseOrderCommand): PurchaseOrderStatus | null {
  return TRANSITIONS[from][command] ?? null;
}

export function isPurchaseOrderStatus(value: string): value is PurchaseOrderStatus {
  return (PURCHASE_ORDER_STATUSES as readonly string[]).includes(value);
}

/** PO-T07: a reason is required unless everything was received. */
export function closeNeedsReason(status: PurchaseOrderStatus): boolean {
  return status !== 'received';
}

/** The statuses whose lines still hold what they order against the requisition (PO-I1). */
export function holdsOrderedQuantity(status: PurchaseOrderStatus): boolean {
  return status !== 'cancelled' && status !== 'rejected';
}

/**
 * PO-T06, after every posted goods receipt or reversal: every line received in full → received;
 * anything received → partially received; nothing → issued.
 */
export function receiptStatus(lines: readonly { quantity: string; receivedQty: string }[]): 'issued' | 'partially_received' | 'received' {
  if (lines.length > 0 && lines.every((l) => dec(l.receivedQty).gte(dec(l.quantity)))) return 'received';
  return lines.some((l) => dec(l.receivedQty).gt(0)) ? 'partially_received' : 'issued';
}

/** Issued orders, whatever was received since: what receivers read (ADR 0006, `po.read.issued`). */
export const ISSUED_ORDER_STATUSES = ['issued', 'partially_received', 'received', 'closed'] as const;

/** GR-T01 / T02: only an issued or partially received order takes goods receipts (else `PO_NOT_RECEIVABLE`). */
export const RECEIVING_ORDER_STATUSES = ['issued', 'partially_received'] as const;

export function takesReceipts(status: PurchaseOrderStatus): boolean {
  return (RECEIVING_ORDER_STATUSES as readonly string[]).includes(status);
}

/** GR-T04: a receipt is reversed only while its order is not closed or cancelled (else `PO_CLOSED`). */
export function takesReversals(status: PurchaseOrderStatus): boolean {
  return status === 'issued' || status === 'partially_received' || status === 'received';
}

/** PO-T07: what a closed line gives back to its requisition line, max(0, quantity − received). */
export function quantityReleasedOnClose(quantity: string, receivedQty: string): string {
  return Dec.max(dec(quantity).sub(dec(receivedQty)), 0).toString();
}

/** PO-T05: floor3(quantity × (1 + tolerance / 100)), fixed per line when the order is issued. */
export function maxReceivableQuantity(quantity: string, tolerancePct: string): string {
  return dec(quantity)
    .mul(new Dec(1).add(dec(tolerancePct).div(100)))
    .toDecimalPlaces(3, Dec.ROUND_DOWN)
    .toString();
}

export const APPROVAL_REASONS = ['NO_THRESHOLD', 'AMOUNT_THRESHOLD', 'PRICE_VARIANCE', 'TOTAL_VARIANCE'] as const;
export type ApprovalReason = (typeof APPROVAL_REASONS)[number];

export type ApprovalRule = {
  /** `po_approval_threshold`; null means every purchase order needs approval. */
  threshold: string | null;
  /** `po_price_tolerance_pct`, e.g. '5' for 5 %. */
  tolerancePct: string;
};

/**
 * PO-T03: why a purchase order needs approval; none means it is approved on submit. Amount: the
 * total (tax included) is at or above the threshold. Unit price: a line's price is above the
 * requisition estimate × (1 + tolerance). Total: the subtotal (tax excluded, like the estimate)
 * is above Σ round(quantity × estimate) × (1 + tolerance). Exact decimal comparisons (ADR 0007).
 */
export function approvalReasons(
  order: { subtotal: string; total: string; lines: readonly { quantity: string; unitPrice: string; estimatedUnitPrice: string }[] },
  rule: ApprovalRule,
  currencyScale: number,
): ApprovalReason[] {
  const reasons: ApprovalReason[] = [];
  if (rule.threshold === null) reasons.push('NO_THRESHOLD');
  else if (dec(order.total).gte(dec(rule.threshold))) reasons.push('AMOUNT_THRESHOLD');
  const factor = new Dec(1).add(dec(rule.tolerancePct).div(100));
  if (order.lines.some((l) => dec(l.unitPrice).gt(dec(l.estimatedUnitPrice).mul(factor)))) reasons.push('PRICE_VARIANCE');
  const estimate = order.lines.reduce(
    (sum, l) => sum.add(dec(l.quantity).mul(dec(l.estimatedUnitPrice)).toDecimalPlaces(currencyScale, Dec.ROUND_HALF_UP)),
    new Dec(0),
  );
  if (dec(order.subtotal).gt(estimate.mul(factor))) reasons.push('TOTAL_VARIANCE');
  return reasons;
}

export const MAX_PO_LINES = 200;
export const MAX_TERMS = 500;
export const MAX_REASON = 500;
