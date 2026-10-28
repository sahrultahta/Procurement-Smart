import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDate, formatMoney } from '@/lib/format';
import { MAX_WINDOW_DAYS, potentialSplitPurchases, type SplitThreshold } from '@/modules/reporting';
import { getRequestContext } from '@/server/request-context';
import { runQuery } from '@/shared/application/runner';
import { AccessDenied, EmptyReport, ReportError, ReportHeader, defaultRange, intParam, param, type SearchParams } from '../_components/report-page';

export const metadata: Metadata = { title: 'Potential split purchases' };

const THRESHOLD_LABELS: Record<SplitThreshold, { name: string; amount: string }> = {
  po_approval: { name: 'Purchase-order approval threshold', amount: 'order totals, tax included' },
  rfq: { name: 'RFQ threshold', amount: 'order subtotals, tax excluded; orders from an RFQ award do not count' },
};

export default async function SplitPurchasesPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const request = await getRequestContext();
  if (!request.actor?.permissions.has('report.view')) return <AccessDenied />;
  const defaults = await defaultRange();
  const windowDays = intParam(params, 'windowDays');
  const input = {
    from: param(params, 'from') ?? defaults.from,
    to: param(params, 'to') ?? defaults.to,
    ...(windowDays === undefined ? {} : { windowDays }),
  };
  const result = await runQuery(request, potentialSplitPurchases, input);

  return (
    <div className="grid gap-6">
      <ReportHeader
        title="Potential split purchases"
        description="Orders for the same requester and supplier, approved close together, each below a threshold but together at or above it. A lead for review, not a finding."
        asOf={result.ok ? result.data.asOf : null}
        timezone={defaults.timezone}
        exportReport="potentialSplitPurchases"
        exportParams={input}
      />
      <form method="get" className="grid gap-3 sm:grid-cols-[10rem_10rem_10rem_auto] sm:items-end">
        <div className="grid gap-2">
          <Label htmlFor="split-from">Approved from</Label>
          <Input id="split-from" name="from" type="date" defaultValue={input.from} required />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="split-to">Approved to</Label>
          <Input id="split-to" name="to" type="date" defaultValue={input.to} required />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="split-window">Window (days)</Label>
          <Input
            id="split-window"
            name="windowDays"
            type="number"
            min={1}
            max={MAX_WINDOW_DAYS}
            step={1}
            defaultValue={result.ok ? result.data.windowDays : (windowDays ?? '')}
          />
        </div>
        <Button type="submit" variant="outline">
          Show
        </Button>
      </form>
      {!result.ok ? (
        <ReportError message={result.error.message} fieldErrors={result.error.fieldErrors} />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Thresholds now:{' '}
            {(['po_approval', 'rfq'] as const)
              .map((kind) => {
                const amount = kind === 'po_approval' ? result.data.thresholds.poApproval : result.data.thresholds.rfq;
                return `${THRESHOLD_LABELS[kind].name} ${amount ?? 'not set (check off)'}`;
              })
              .join('; ')}
            .
          </p>
          {result.data.groups.length === 0 ? (
            <EmptyReport>
              No potential split purchase among the orders approved between {formatDate(result.data.from)} and {formatDate(result.data.to)}.
            </EmptyReport>
          ) : (
            result.data.groups.map((group) => (
              <Card key={`${group.threshold}-${group.orders.map((o) => o.purchaseOrderId).join('-')}`} data-testid="split-group">
                <CardHeader className="grid gap-1">
                  <h2 className="font-semibold">
                    {group.requesterName} · {group.supplierName}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {THRESHOLD_LABELS[group.threshold].name} {formatMoney(group.thresholdAmount, group.currencyCode, group.currencyScale)} (
                    {THRESHOLD_LABELS[group.threshold].amount}): together {formatMoney(group.combinedAmount, group.currencyCode, group.currencyScale)},
                    approved {formatDate(group.firstOn)} to {formatDate(group.lastOn)}.
                  </p>
                </CardHeader>
                <CardContent>
                  <Table aria-label={`Orders for ${group.requesterName} from ${group.supplierName}`}>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Purchase order</TableHead>
                        <TableHead>Requisition</TableHead>
                        <TableHead>Approved</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {group.orders.map((order) => (
                        <TableRow key={order.purchaseOrderId}>
                          <TableCell className="font-mono">
                            <Link href={`/purchase-orders/${order.purchaseOrderId}`} className="underline-offset-4 hover:underline">
                              {order.number}
                            </Link>
                          </TableCell>
                          <TableCell className="font-mono">{order.requisitionNumber}</TableCell>
                          <TableCell>{formatDate(order.approvedOn)}</TableCell>
                          <TableCell className="text-right font-mono">{formatMoney(order.amount, group.currencyCode, group.currencyScale)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            ))
          )}
        </>
      )}
    </div>
  );
}
