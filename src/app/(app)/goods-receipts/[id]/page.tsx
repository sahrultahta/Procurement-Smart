import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDate, formatTimestamp } from '@/lib/format';
import { getGoodsReceipt } from '@/modules/receiving';
import { getOrganization } from '@/server/organization-profile';
import { getRequestContext } from '@/server/request-context';
import { runQuery } from '@/shared/application/runner';
import { PoStatusBadge } from '../../purchase-orders/_components/po-status';
import { CancelGoodsReceiptForm, PostGoodsReceiptForm, ReverseGoodsReceiptForm } from '../_components/receipt-actions';
import { ReceiptStatusBadge, receiptKindLabel, receiptNotice } from '../_components/receipt-status';

export const metadata: Metadata = { title: 'Goods receipt' };

export default async function GoodsReceiptPage(props: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await props.params;
  const notice = receiptNotice((await props.searchParams).notice);
  const result = await runQuery(await getRequestContext(), getGoodsReceipt, { goodsReceiptId: id });
  if (!result.ok) {
    if (result.error.code === 'NOT_FOUND' || result.error.code === 'VALIDATION_FAILED') notFound();
    return (
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold">{result.error.code === 'FORBIDDEN' ? 'Access denied' : 'Goods receipt'}</h1>
        <p className="text-muted-foreground">{result.error.message}</p>
      </div>
    );
  }
  const gr = result.data;
  const { timezone } = await getOrganization();
  const can = new Set(gr.callerActions);

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">
            {gr.kind === 'reversal' ? 'Reversal' : 'Goods receipt'} <span className="font-mono">{gr.number}</span>
          </h1>
          <ReceiptStatusBadge status={gr.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          {receiptKindLabel(gr.kind)} for{' '}
          <Link href={`/purchase-orders/${gr.purchaseOrder.id}`} className="font-mono underline-offset-4 hover:underline">
            {gr.purchaseOrder.number}
          </Link>{' '}
          from {gr.purchaseOrder.supplierName} · recorded by {gr.createdBy} on {formatTimestamp(gr.createdAt, timezone)}
        </p>
      </div>

      {notice ? (
        <Alert role="status">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <h2 className="font-semibold">Details</h2>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[11rem_1fr] gap-y-2 text-sm">
            <dt className="text-muted-foreground">Purchase order</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{gr.purchaseOrder.number}</span> <PoStatusBadge status={gr.purchaseOrder.status} />
            </dd>
            <dt className="text-muted-foreground">{gr.kind === 'reversal' ? 'Recorded on' : 'Received on'}</dt>
            <dd>{formatDate(gr.receivedOn)}</dd>
            {gr.kind === 'receipt' ? (
              <>
                <dt className="text-muted-foreground">Delivery note</dt>
                <dd>{gr.deliveryNoteRef ?? '—'}</dd>
                <dt className="text-muted-foreground">Notes</dt>
                <dd className="whitespace-pre-line">{gr.notes ?? '—'}</dd>
              </>
            ) : null}
            {gr.reverses ? (
              <>
                <dt className="text-muted-foreground">Reverses</dt>
                <dd>
                  <Link href={`/goods-receipts/${gr.reverses.id}`} className="font-mono underline-offset-4 hover:underline">
                    {gr.reverses.number}
                  </Link>
                  {gr.reason ? `: ${gr.reason}` : ''}
                </dd>
              </>
            ) : null}
            {gr.reversedBy ? (
              <>
                <dt className="text-muted-foreground">Reversed by</dt>
                <dd>
                  <Link href={`/goods-receipts/${gr.reversedBy.id}`} className="font-mono underline-offset-4 hover:underline">
                    {gr.reversedBy.number}
                  </Link>
                </dd>
              </>
            ) : null}
            {gr.postedAt ? (
              <>
                <dt className="text-muted-foreground">Posted</dt>
                <dd>
                  {formatTimestamp(gr.postedAt, timezone)} by {gr.postedBy}
                </dd>
              </>
            ) : null}
            {gr.cancelledAt ? (
              <>
                <dt className="text-muted-foreground">Cancelled</dt>
                <dd>
                  {formatTimestamp(gr.cancelledAt, timezone)} by {gr.cancelledBy}
                  {gr.cancelReason ? `: ${gr.cancelReason}` : ''}
                </dd>
              </>
            ) : null}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="font-semibold">Lines</h2>
        </CardHeader>
        <CardContent>
          <Table aria-label="Lines">
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">{gr.kind === 'reversal' ? 'Quantity taken back' : 'Quantity'}</TableHead>
                <TableHead className="text-right">Ordered</TableHead>
                <TableHead className="text-right">Received on the order now</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {gr.lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>{l.lineNo}</TableCell>
                  <TableCell className="whitespace-normal">
                    {l.description}
                    {l.note ? <span className="block text-xs text-muted-foreground">{l.note}</span> : null}
                  </TableCell>
                  <TableCell className="text-right">
                    {l.quantity} {l.uom}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {l.orderedQty} {l.uom}
                  </TableCell>
                  <TableCell className="text-right">
                    {l.receivedQty} of up to {l.maxReceivableQty ?? '—'} {l.uom}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {can.size > 0 ? (
        <Card>
          <CardHeader>
            <h2 className="font-semibold">Actions</h2>
          </CardHeader>
          <CardContent className="grid gap-6">
            {can.has('post') ? <PostGoodsReceiptForm goodsReceiptId={gr.id} version={gr.version} /> : null}
            {can.has('reverse') ? <ReverseGoodsReceiptForm goodsReceiptId={gr.id} version={gr.version} /> : null}
            {can.has('cancel') ? <CancelGoodsReceiptForm goodsReceiptId={gr.id} version={gr.version} /> : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
