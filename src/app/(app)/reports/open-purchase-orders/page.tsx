import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDate, formatMoney } from '@/lib/format';
import { openPurchaseOrders } from '@/modules/reporting';
import { getRequestContext } from '@/server/request-context';
import { runQuery } from '@/shared/application/runner';
import { PoStatusBadge } from '../../purchase-orders/_components/po-status';
import { AccessDenied, EmptyReport, ReportError, ReportHeader, defaultRange, param, type SearchParams } from '../_components/report-page';
import type { PurchaseOrderStatus } from '@/modules/purchasing';

export const metadata: Metadata = { title: 'Open purchase orders' };

export default async function OpenPurchaseOrdersPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const request = await getRequestContext();
  if (!request.actor?.permissions.has('report.view')) return <AccessDenied />;
  const { timezone } = await defaultRange();
  const supplierId = param(params, 'supplierId');
  const input = supplierId ? { supplierId } : {};
  const result = await runQuery(request, openPurchaseOrders, input);

  return (
    <div className="grid gap-6">
      <ReportHeader
        title="Open purchase orders"
        description="Issued orders still waiting for goods: what is outstanding on each line and what it is worth at the order price, tax included."
        asOf={result.ok ? result.data.asOf : null}
        timezone={timezone}
        exportReport="openPurchaseOrders"
        exportParams={input}
      />
      <form method="get" className="flex flex-wrap items-end gap-3">
        <div className="grid gap-2">
          <Label htmlFor="open-supplier">Supplier</Label>
          <NativeSelect id="open-supplier" name="supplierId" defaultValue={supplierId ?? ''} className="w-72">
            <option value="">All suppliers</option>
            {(result.ok ? result.data.suppliers : []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.code})
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button type="submit" variant="outline">
          Show
        </Button>
      </form>
      {!result.ok ? (
        <ReportError message={result.error.message} fieldErrors={result.error.fieldErrors} />
      ) : result.data.rows.length === 0 ? (
        <EmptyReport>No purchase order is waiting for goods.</EmptyReport>
      ) : (
        <Table aria-label="Open purchase orders">
          <TableHeader>
            <TableRow>
              <TableHead>Purchase order</TableHead>
              <TableHead>Supplier</TableHead>
              <TableHead>Issued</TableHead>
              <TableHead>Expected</TableHead>
              <TableHead>Outstanding</TableHead>
              <TableHead className="text-right">Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.data.rows.map((po) => (
              <TableRow key={po.purchaseOrderId} className="align-top">
                <TableCell className="whitespace-normal">
                  <Link href={`/purchase-orders/${po.purchaseOrderId}`} className="font-mono underline-offset-4 hover:underline">
                    {po.number}
                  </Link>
                  <span className="mt-1 block">
                    <PoStatusBadge status={po.status as PurchaseOrderStatus} />
                  </span>
                </TableCell>
                <TableCell className="whitespace-normal">
                  {po.supplierName}
                  <span className="block text-xs text-muted-foreground">{po.departmentName}</span>
                </TableCell>
                <TableCell>{formatDate(po.issuedOn)}</TableCell>
                <TableCell>{po.expectedDeliveryDate ? formatDate(po.expectedDeliveryDate) : '—'}</TableCell>
                <TableCell className="whitespace-normal text-xs">
                  <span className="block text-muted-foreground">
                    {po.openLines} of {po.lineCount} lines open
                  </span>
                  <ul>
                    {po.lines
                      .filter((l) => l.outstandingQty !== '0')
                      .map((l) => (
                        <li key={l.lineNo}>
                          {l.outstandingQty} {l.uom} {l.description}
                        </li>
                      ))}
                  </ul>
                </TableCell>
                <TableCell className="text-right font-mono">{formatMoney(po.outstandingAmount, po.currencyCode, po.currencyScale)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            {result.data.totals.map((t) => (
              <TableRow key={t.currencyCode}>
                <TableCell colSpan={5}>Total outstanding</TableCell>
                <TableCell className="text-right font-mono">{formatMoney(t.total, t.currencyCode, t.currencyScale)}</TableCell>
              </TableRow>
            ))}
          </TableFooter>
        </Table>
      )}
    </div>
  );
}
