import { Badge } from '@/components/ui/badge';
import type { RfqStatus } from '@/modules/sourcing';

const LABELS: Record<RfqStatus, string> = {
  draft: 'Draft',
  issued: 'Issued',
  closed: 'Closed',
  awarded: 'Awarded',
  cancelled: 'Cancelled',
};

export function rfqStatusLabel(status: RfqStatus): string {
  return LABELS[status];
}

export function RfqStatusBadge({ status }: { status: RfqStatus }) {
  const variant = status === 'awarded' ? 'secondary' : status === 'cancelled' ? 'destructive' : 'outline';
  return <Badge variant={variant}>{LABELS[status]}</Badge>;
}

export const RFQ_NOTICES = {
  created: 'Draft RFQ created. You can still change it.',
  saved: 'Changes saved.',
  issued: 'RFQ issued. ProcureFlow does not contact suppliers: send the RFQ to each invited supplier yourself.',
  closed: 'RFQ closed. No more quotations will be accepted.',
  cancelled: 'RFQ cancelled. Its requisition lines can be put on a new RFQ.',
} as const;

export function rfqNotice(value: unknown): string | null {
  return typeof value === 'string' && Object.hasOwn(RFQ_NOTICES, value) ? RFQ_NOTICES[value as keyof typeof RFQ_NOTICES] : null;
}
