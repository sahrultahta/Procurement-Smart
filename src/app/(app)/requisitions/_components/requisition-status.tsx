import { Badge } from '@/components/ui/badge';
import type { StepStatus } from '@/modules/approvals';
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

const STEP_LABELS: Record<StepStatus, string> = {
  waiting: 'Waiting',
  pending: 'Awaiting decision',
  approved: 'Approved',
  rejected: 'Rejected',
  returned: 'Returned for changes',
  cancelled: 'Cancelled',
};

export function stepStatusLabel(status: StepStatus): string {
  return STEP_LABELS[status];
}

export const REQUISITION_NOTICES = {
  created: 'Draft created. You can still edit it.',
  saved: 'Changes saved. The total was recalculated.',
  cancelled: 'Requisition cancelled.',
  submitted: 'Submitted for approval. The approval route is fixed until the approvers decide.',
  withdrawn: 'Requisition withdrawn. Its approval was cancelled.',
  closed: 'Requisition closed. Its remaining quantities can no longer be ordered.',
  'step-approved': 'Your approval was recorded. The next step is now open.',
  'decided-approved': 'Your approval was recorded. The requisition is approved.',
  'decided-rejected': 'Requisition rejected.',
  'decided-returned': 'Requisition returned to the requester for changes.',
} as const;

export function requisitionNotice(value: unknown): string | null {
  return typeof value === 'string' && Object.hasOwn(REQUISITION_NOTICES, value) ? REQUISITION_NOTICES[value as keyof typeof REQUISITION_NOTICES] : null;
}
