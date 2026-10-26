import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatMoney, formatTimestamp } from '@/lib/format';
import { PURCHASE_ORDER_STATUSES, listPurchaseOrders } from '@/modules/purchasing';
import { getOrganization } from '@/server/organization-profile';
import { getRequestContext } from '@/server/request-context';
import { runQuery } from '@/shared/application/runner';
import { PoStatusBadge, poStatusLabel } from './_components/po-status';

export const metadata: Metadata = { title: 'Purchase orders' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function PurchaseOrdersPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const q = typeof params.q === 'string' ? params.q.slice(0, 100) : '';
  const status = PURCHASE_ORDER_STATUSES.find((s) => s === params.status);
  const cursor = typeof params.cursor === 'string' ? params.cursor : undefined;
  const result = await runQuery(await getRequestContext(), listPurchaseOrders, {
    ...(q.trim() ? { q } : {}),
    ...(status ? { status } : {}),
    ...(cursor ? { cursor } : {}),
  });

  if (!result.ok) {
    return (
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold">{result.error.code === 'FORBIDDEN' ? 'Access denied' : 'Purchase orders'}</h1>
        <p className="text-muted-foreground">{result.error.code === 'FORBIDDEN' ? 'You have no role that can see purchase orders.' : result.error.message}</p>
      </div>
    );
  }
  const { timezone } = await getOrganization();
  const next = result.data.nextCursor
    ? `/purchase-orders?${new URLSearchParams({ ...(q ? { q } : {}), ...(status ? { status } : {}), cursor: result.data.nextCursor })}`
    : null;

  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">Purchase orders</h1>
        <p className="text-sm text-muted-foreground">Procurement creates a purchase order from an approved requisition, directly or from an awarded quotation.</p>
      </div>
      <form role="search" method="get" className="grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
        <div className="grid gap-2">
          <Label htmlFor="po-search">Search</Label>
          <Input id="po-search" name="q" defaultValue={q} maxLength={100} placeholder="PO number" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="po-status-filter">Status</Label>
          <NativeSelect id="po-status-filter" name="status" defaultValue={status ?? ''}>
            <option value="">Any status</option>
            {PURCHASE_ORDER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {poStatusLabel(s)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>
      <Table aria-label="Purchase orders">
        <TableHeader>
          <TableRow>
            <TableHead>Number</TableHead>
            <TableHead>Supplier</TableHead>
            <TableHead>Requisition</TableHead>
            <TableHead className="text-right">Total</TableHead>
            <TableHead>Created</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {result.data.items.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="text-muted-foreground">
                No purchase orders to show.
              </TableCell>
            </TableRow>
          ) : (
            result.data.items.map((po) => (
              <TableRow key={po.id}>
                <TableCell className="font-mono">
                  <Link href={`/purchase-orders/${po.id}`} className="underline-offset-4 hover:underline">
                    {po.number}
                  </Link>
                </TableCell>
                <TableCell className="whitespace-normal">{po.supplierName}</TableCell>
                <TableCell className="font-mono">{po.requisitionNumber}</TableCell>
                <TableCell className="text-right">{formatMoney(po.total, po.currencyCode, po.currencyScale)}</TableCell>
                <TableCell>{formatTimestamp(po.createdAt, timezone)}</TableCell>
                <TableCell>
                  <PoStatusBadge status={po.status} />
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      {next ? (
        <div>
          <Button asChild variant="outline">
            <Link href={next}>Next page</Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
