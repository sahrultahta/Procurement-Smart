import { Badge } from '@/components/ui/badge';
import type { SupplierStatus } from '@/modules/suppliers';

const LABELS: Record<SupplierStatus, string> = {
  pending_review: 'Pending review',
  active: 'Active',
  blocked: 'Blocked',
  inactive: 'Inactive',
};

export function SupplierStatusBadge({ status }: { status: SupplierStatus }) {
  const variant = status === 'active' ? 'secondary' : status === 'blocked' ? 'destructive' : 'outline';
  return <Badge variant={variant}>{LABELS[status]}</Badge>;
}

export function supplierStatusLabel(status: SupplierStatus): string {
  return LABELS[status];
}
