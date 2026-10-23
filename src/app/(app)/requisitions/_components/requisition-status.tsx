import { Badge } from '@/components/ui/badge';
import type { RequisitionStatus } from '@/modules/requisitions';

const LABELS: Record<RequisitionStatus, string> = {
  draft: 'Draft',
  pending_approval: 'Pending approval',
  returned: 'Returned',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  closed: 'Closed',
};

export function requisitionStatusLabel(status: RequisitionStatus): string {
  return LABELS[status];
}

export function RequisitionStatusBadge({ status }: { status: RequisitionStatus }) {
  const variant = status === 'approved' ? 'secondary' : status === 'rejected' || status === 'cancelled' ? 'destructive' : 'outline';
  return <Badge variant={variant}>{LABELS[status]}</Badge>;
}

export const REQUISITION_NOTICES = {
  created: 'Draft created. You can still edit it.',
  saved: 'Changes saved. The total was recalculated.',
  cancelled: 'Requisition cancelled.',
} as const;

export function requisitionNotice(value: unknown): string | null {
  return typeof value === 'string' && Object.hasOwn(REQUISITION_NOTICES, value) ? REQUISITION_NOTICES[value as keyof typeof REQUISITION_NOTICES] : null;
}
