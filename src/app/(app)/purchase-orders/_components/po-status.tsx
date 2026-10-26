import { Badge } from '@/components/ui/badge';
import type { ApprovalReason, PurchaseOrderStatus } from '@/modules/purchasing';

const LABELS: Record<PurchaseOrderStatus, string> = {
  draft: 'Draft',
  pending_approval: 'Pending approval',
  approved: 'Approved',
  issued: 'Issued',
  partially_received: 'Partially received',
  received: 'Received',
  closed: 'Closed',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

export function poStatusLabel(status: PurchaseOrderStatus): string {
  return LABELS[status];
}

export function PoStatusBadge({ status }: { status: PurchaseOrderStatus }) {
  const variant = status === 'approved' || status === 'issued' || status === 'received' ? 'secondary' : status === 'rejected' || status === 'cancelled' ? 'destructive' : 'outline';
  return <Badge variant={variant}>{LABELS[status]}</Badge>;
}

/** Why approval was needed (PO-T03), in words; amounts are formatted by the caller. */
export function approvalReasonLabel(reason: ApprovalReason, rule: { threshold: string | null; tolerancePct: string | null }): string {
  switch (reason) {
    case 'NO_THRESHOLD':
      return 'Every purchase order needs approval (no approval threshold is set).';
    case 'AMOUNT_THRESHOLD':
      return `The total is at or above the approval threshold of ${rule.threshold ?? ''}.`;
    case 'PRICE_VARIANCE':
      return `A unit price is more than ${rule.tolerancePct ?? '0'}% above the requisition estimate.`;
    case 'TOTAL_VARIANCE':
      return `The subtotal is more than ${rule.tolerancePct ?? '0'}% above the requisition estimate for these quantities.`;
  }
}

export const PO_NOTICES = {
  created: 'Draft purchase order created. You can still change it.',
  saved: 'Changes saved. The totals were recalculated.',
  'submitted-approval': 'Submitted for approval. The approval route is fixed until the approvers decide.',
  'submitted-approved': 'Approved without an approval round: the total is below the approval threshold and every price is within the tolerance.',
  issued: 'Purchase order issued. It can no longer change. ProcureFlow does not send it: print it and send it to the supplier.',
  cancelled: 'Purchase order cancelled. Its quantities can be ordered again.',
  closed: 'Purchase order closed. What was not received can be ordered again.',
  'step-approved': 'Your approval was recorded. The next step is now open.',
  'decided-approved': 'Your approval was recorded. The purchase order is approved.',
  'decided-rejected': 'Purchase order rejected. Its quantities can be ordered again.',
  'decided-returned': 'Purchase order returned to the buyer for changes.',
} as const;

export function poNotice(value: unknown): string | null {
  return typeof value === 'string' && Object.hasOwn(PO_NOTICES, value) ? PO_NOTICES[value as keyof typeof PO_NOTICES] : null;
}
