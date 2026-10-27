import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { formatDate } from '@/lib/format';
import { goodsReceiptFormOptions } from '@/modules/receiving';
import { getRequestContext } from '@/server/request-context';
import { runQuery } from '@/shared/application/runner';
import { dec } from '@/shared/decimal/decimal';
import { poStatusLabel } from '../../purchase-orders/_components/po-status';
import { GoodsReceiptForm } from '../_components/receipt-form';

export const metadata: Metadata = { title: 'Receive goods' };

export default async function NewGoodsReceiptPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await props.searchParams;
  const purchaseOrderId = typeof params.purchaseOrderId === 'string' ? params.purchaseOrderId : '';
  const result = await runQuery(await getRequestContext(), goodsReceiptFormOptions, { purchaseOrderId });
  if (!result.ok) {
    if (result.error.code === 'NOT_FOUND' || result.error.code === 'VALIDATION_FAILED') notFound();
    return (
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold">{result.error.code === 'FORBIDDEN' ? 'Access denied' : 'Receive goods'}</h1>
        <p className="text-muted-foreground">{result.error.code === 'FORBIDDEN' ? 'Goods are received by receivers.' : result.error.message}</p>
      </div>
    );
  }
  const o = result.data;
  const heading = (
    <div className="grid gap-1">
      <h1 className="text-2xl font-semibold">Receive goods</h1>
      <p className="text-sm text-muted-foreground">
        For{' '}
        <Link href={`/purchase-orders/${o.purchaseOrder.id}`} className="font-mono underline-offset-4 hover:underline">
          {o.purchaseOrder.number}
        </Link>{' '}
        from {o.purchaseOrder.supplierName}, issued on {formatDate(o.purchaseOrder.issuedOn)}
        {o.purchaseOrder.expectedDeliveryDate ? `, expected ${formatDate(o.purchaseOrder.expectedDeliveryDate)}` : ''}
      </p>
    </div>
  );
  const stop = (message: string) => (
    <div className="grid gap-4">
      {heading}
      <p role="note" className="text-sm">
        {message}
      </p>
    </div>
  );
  if (o.orderReceiveConflict) return stop(`You created ${o.purchaseOrder.number}, so someone else must receive its goods (separation of duties).`);
  if (!o.receivable) return stop(`${o.purchaseOrder.number} is ${poStatusLabel(o.purchaseOrder.status).toLowerCase()}, so it takes no more goods receipts.`);
  const open = o.lines.filter((l) => dec(l.remainingQty).gt(0));
  if (open.length === 0) return stop('Every line has received all it can take.');

  return (
    <div className="grid gap-4">
      {heading}
      <Card>
        <CardContent>
          <GoodsReceiptForm purchaseOrderId={o.purchaseOrder.id} issuedOn={o.purchaseOrder.issuedOn} today={o.today} lines={open} />
        </CardContent>
      </Card>
    </div>
  );
}
