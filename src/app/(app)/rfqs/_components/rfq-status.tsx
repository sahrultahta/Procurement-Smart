import { Badge } from '@/components/ui/badge';
import type { QuotationStatus, RfqStatus, Validity } from '@/modules/sourcing';

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

const QUOTATION_LABELS: Record<QuotationStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  withdrawn: 'Withdrawn',
  awarded: 'Awarded',
  not_awarded: 'Not awarded',
};

export function quotationStatusLabel(status: QuotationStatus): string {
  return QUOTATION_LABELS[status];
}

const VALIDITY_LABELS: Record<Validity, string> = {
  valid: 'Valid',
  draft: 'Not submitted',
  withdrawn: 'Withdrawn',
  expired: 'Expired',
  supplier_not_active: 'Supplier not active',
};

export function validityLabel(validity: Validity): string {
  return VALIDITY_LABELS[validity];
}

export const RFQ_NOTICES = {
  created: 'Draft RFQ created. You can still change it.',
  saved: 'Changes saved.',
  issued: 'RFQ issued. ProcureFlow does not contact suppliers: send the RFQ to each invited supplier yourself.',
  closed: 'RFQ closed. No more quotations will be accepted.',
  cancelled: 'RFQ cancelled. Its requisition lines can be put on a new RFQ.',
  'quotation-recorded': 'Quotation saved as a draft. Submit it once it is complete.',
  'quotation-saved': 'Quotation saved.',
  'quotation-submitted': 'Quotation submitted. It now counts in the comparison.',
  'quotation-submitted-late': 'Quotation submitted after the due time. It counts in the comparison and is marked late.',
  'quotation-withdrawn': 'Quotation withdrawn. The supplier can send a new one while the RFQ is issued.',
  'quotation-discarded': 'Draft quotation discarded.',
  awarded: 'RFQ awarded. The other submitted quotations are marked not awarded.',
} as const;

export function rfqNotice(value: unknown): string | null {
  return typeof value === 'string' && Object.hasOwn(RFQ_NOTICES, value) ? RFQ_NOTICES[value as keyof typeof RFQ_NOTICES] : null;
}
