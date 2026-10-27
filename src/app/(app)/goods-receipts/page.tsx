import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDate, formatTimestamp } from '@/lib/format';
import { listReceivableOrders } from '@/modules/purchasing';
import { GOODS_RECEIPT_KINDS, GOODS_RECEIPT_STATUSES, listGoodsReceipts } from '@/modules/receiving';
import { getOrganization } from '@/server/organization-profile';
import { getRequestContext } from '@/server/request-context';
import { runQuery } from '@/shared/application/runner';
import { PoStatusBadge } from '../purchase-orders/_components/po-status';
import { ReceiptStatusBadge, receiptKindLabel, receiptStatusLabel } from './_components/receipt-status';

export const metadata: Metadata = { title: 'Receiving' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ReceivingPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const q = typeof params.q === 'string' ? params.q.slice(0, 100) : '';
  const status = GOODS_RECEIPT_STATUSES.find((s) => s === params.status);
  const kind = GOODS_RECEIPT_KINDS.find((k) => k === params.kind);
  const cursor = typeof params.cursor === 'string' ? params.cursor : undefined;
  const request = await getRequestContext();
  const canReceive = request.actor?.permissions.has('receipt.create') ?? false;
  const canRead = request.actor?.permissions.has('receipt.read') ?? false;
  if (!canReceive && !canRead) {
    return (
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <p className="text-muted-foreground">You have no role that can see goods receipts.</p>
      </div>
    );
  }
  const { timezone } = await getOrganization();
  const waiting = canReceive ? await runQuery(request, listReceivableOrders, {}) : null;
  const receipts = canRead
    ? await runQuery(request, listGoodsReceipts, {
        ...(q.trim() ? { q } : {}),
        ...(status ? { status } : {}),
        ...(kind ? { kind } : {}),
        ...(cursor ? { cursor } : {}),
      })
    : null;
  const next =
    receipts?.ok && receipts.data.nextCursor
      ? `/goods-receipts?${new URLSearchParams({ ...(q ? { q } : {}), ...(status ? { status } : {}), ...(kind ? { kind } : {}), cursor: receipts.data.nextCursor })}`
      : null;

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">Receiving</h1>
        <p className="text-sm text-muted-foreground">
          Receivers record the goods that arrive against issued purchase orders. Whoever created an order cannot receive against it.
        </p>
      </div>

      {waiting ? (
        <Card>
          <CardHeader>
            <h2 className="font-semibold">Purchase orders waiting for goods</h2>
          </CardHeader>
          <CardContent>
            {!waiting.ok ? (
              <p className="text-sm text-muted-foreground">{waiting.error.message}</p>
            ) : (
              <Table aria-label="Purchase orders waiting for goods">
                <TableHeader>
                  <TableRow>
                    <TableHead>Purchase order</TableHead>
                    <TableHead>Supplier</TableHead>
                    <TableHead>Expected</TableHead>
                    <TableHead>Lines open</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>
                      <span className="sr-only">Action</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {waiting.data.items.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-muted-foreground">
                        No purchase order is waiting for goods.
                      </TableCell>
                    </TableRow>
                  ) : (
                    waiting.data.items.map((po) => (
                      <TableRow key={po.id}>
                        <TableCell className="font-mono">
                          <Link href={`/purchase-orders/${po.id}`} className="underline-offset-4 hover:underline">
                            {po.number}
                          </Link>
                        </TableCell>
                        <TableCell className="whitespace-normal">{po.supplierName}</TableCell>
                        <TableCell>{po.expectedDeliveryDate ? formatDate(po.expectedDeliveryDate) : '—'}</TableCell>
                        <TableCell>
                          {po.openLines} of {po.lineCount}
                        </TableCell>
                        <TableCell>
                          <PoStatusBadge status={po.status} />
                        </TableCell>
                        <TableCell>
                          {po.ownOrder ? (
                            <span className="text-xs text-muted-foreground">You created it: someone else receives it</span>
                          ) : (
                            <Link href={`/goods-receipts/new?purchaseOrderId=${po.id}`} className="underline-offset-4 hover:underline" aria-label={`Receive goods for ${po.number}`}>
                              Receive goods
                            </Link>
                          )}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      ) : null}

      {receipts ? (
        <section className="grid gap-4" aria-labelledby="receipts-heading">
          <h2 id="receipts-heading" className="text-lg font-semibold">
            Goods receipts
          </h2>
          <form role="search" method="get" className="grid gap-3 sm:grid-cols-[1fr_10rem_10rem_auto] sm:items-end">
            <div className="grid gap-2">
              <Label htmlFor="gr-search">Search</Label>
              <Input id="gr-search" name="q" defaultValue={q} maxLength={100} placeholder="Receipt number" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="gr-status-filter">Status</Label>
              <NativeSelect id="gr-status-filter" name="status" defaultValue={status ?? ''}>
                <option value="">Any status</option>
                {GOODS_RECEIPT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {receiptStatusLabel(s)}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="gr-kind-filter">Kind</Label>
              <NativeSelect id="gr-kind-filter" name="kind" defaultValue={kind ?? ''}>
                <option value="">Receipts and reversals</option>
                {GOODS_RECEIPT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {receiptKindLabel(k)}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <Button type="submit" variant="outline">
              Search
            </Button>
          </form>
          {!receipts.ok ? (
            <p className="text-sm text-muted-foreground">{receipts.error.message}</p>
          ) : (
            <Table aria-label="Goods receipts">
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Purchase order</TableHead>
                  <TableHead>Supplier</TableHead>
                  <TableHead>Received on</TableHead>
                  <TableHead>Recorded</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {receipts.data.items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-muted-foreground">
                      No goods receipts to show.
                    </TableCell>
                  </TableRow>
                ) : (
                  receipts.data.items.map((gr) => (
                    <TableRow key={gr.id}>
                      <TableCell className="font-mono">
                        <Link href={`/goods-receipts/${gr.id}`} className="underline-offset-4 hover:underline">
                          {gr.number}
                        </Link>
                      </TableCell>
                      <TableCell className="whitespace-normal">
                        {receiptKindLabel(gr.kind)}
                        {gr.reversesNumber ? <span className="block text-xs text-muted-foreground">of {gr.reversesNumber}</span> : null}
                        {gr.reversedByNumber ? <span className="block text-xs text-muted-foreground">reversed by {gr.reversedByNumber}</span> : null}
                      </TableCell>
                      <TableCell className="font-mono">{gr.purchaseOrderNumber}</TableCell>
                      <TableCell className="whitespace-normal">{gr.supplierName}</TableCell>
                      <TableCell>{formatDate(gr.receivedOn)}</TableCell>
                      <TableCell className="whitespace-normal">
                        {formatTimestamp(gr.createdAt, timezone)}
                        <span className="block text-xs text-muted-foreground">by {gr.createdBy}</span>
                      </TableCell>
                      <TableCell>
                        <ReceiptStatusBadge status={gr.status} />
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
          {next ? (
            <div>
              <Button asChild variant="outline">
                <Link href={next}>Next page</Link>
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
