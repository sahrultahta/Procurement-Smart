import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatMoney, formatTimestamp } from '@/lib/format';
import { approvalAging } from '@/modules/reporting';
import { getRequestContext } from '@/server/request-context';
import { runQuery } from '@/shared/application/runner';
import { AccessDenied, EmptyReport, ReportError, ReportHeader, defaultRange, intParam, type SearchParams } from '../_components/report-page';

export const metadata: Metadata = { title: 'Approval aging' };

const DOCUMENT_PATHS = { requisition: '/requisitions', purchase_order: '/purchase-orders' } as const;

export default async function ApprovalAgingPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const request = await getRequestContext();
  if (!request.actor?.permissions.has('report.view')) return <AccessDenied />;
  const { timezone } = await defaultRange();
  const olderThanDays = intParam(params, 'olderThanDays');
  const input = olderThanDays === undefined ? {} : { olderThanDays };
  const result = await runQuery(request, approvalAging, input);

  return (
    <div className="grid gap-6">
      <ReportHeader
        title="Approval aging"
        description="Approval steps waiting for a decision, oldest first, with how long each has waited."
        asOf={result.ok ? result.data.asOf : null}
        timezone={timezone}
        exportReport="approvalAging"
        exportParams={input}
      />
      <form method="get" className="flex flex-wrap items-end gap-3">
        <div className="grid gap-2">
          <Label htmlFor="aging-days">Waiting at least (days)</Label>
          <Input id="aging-days" name="olderThanDays" type="number" min={0} max={365} step={1} defaultValue={result.ok ? result.data.olderThanDays : ''} className="w-40" />
        </div>
        <Button type="submit" variant="outline">
          Show
        </Button>
      </form>
      {!result.ok ? (
        <ReportError message={result.error.message} fieldErrors={result.error.fieldErrors} />
      ) : result.data.rows.length === 0 ? (
        <EmptyReport>No approval step has been waiting that long.</EmptyReport>
      ) : (
        <Table aria-label="Pending approval steps">
          <TableHeader>
            <TableRow>
              <TableHead>Document</TableHead>
              <TableHead>Department</TableHead>
              <TableHead>Step</TableHead>
              <TableHead>Waiting since</TableHead>
              <TableHead className="text-right">Days</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.data.rows.map((row) => (
              <TableRow key={`${row.documentId}-${row.stepNo}`}>
                <TableCell className="whitespace-normal">
                  <Link href={`${DOCUMENT_PATHS[row.documentType]}/${row.documentId}`} className="font-mono underline-offset-4 hover:underline">
                    {row.documentNumber}
                  </Link>
                  <span className="block text-xs text-muted-foreground">{row.documentTitle}</span>
                </TableCell>
                <TableCell>{row.departmentName}</TableCell>
                <TableCell>
                  {row.stepNo} ({row.requiredRole})
                </TableCell>
                <TableCell>{formatTimestamp(row.pendingSince, timezone)}</TableCell>
                <TableCell className="text-right">{row.ageDays}</TableCell>
                <TableCell className="text-right font-mono">{formatMoney(row.amount, row.currencyCode, row.currencyScale)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
