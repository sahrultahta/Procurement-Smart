import { Badge } from '@/components/ui/badge';
import type { GoodsReceiptKind, GoodsReceiptStatus } from '@/modules/receiving';

const LABELS: Record<GoodsReceiptStatus, string> = {
  draft: 'Draft',
  posted: 'Posted',
  cancelled: 'Cancelled',
};

export function receiptStatusLabel(status: GoodsReceiptStatus): string {
  return LABELS[status];
}

export function receiptKindLabel(kind: GoodsReceiptKind): string {
  return kind === 'reversal' ? 'Reversal' : 'Receipt';
}

export function ReceiptStatusBadge({ status }: { status: GoodsReceiptStatus }) {
  return <Badge variant={status === 'posted' ? 'secondary' : status === 'cancelled' ? 'destructive' : 'outline'}>{LABELS[status]}</Badge>;
}

export const RECEIPT_NOTICES = {
  created: 'Draft receipt recorded. Nothing is received until you post it.',
  posted: 'Receipt posted. The purchase order’s received quantities and status were updated.',
  cancelled: 'Draft cancelled. Nothing was received.',
  reversed: 'Reversal posted. The received quantities were taken back; the original receipt is unchanged.',
} as const;

export function receiptNotice(value: unknown): string | null {
  return typeof value === 'string' && Object.hasOwn(RECEIPT_NOTICES, value) ? RECEIPT_NOTICES[value as keyof typeof RECEIPT_NOTICES] : null;
}
