import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDate, formatTimestamp } from '@/lib/format';
import { requisitionCycleTime } from '@/modules/reporting';
import { getRequestContext } from '@/server/request-context';
import { runQuery } from '@/shared/application/runner';
import { AccessDenied, EmptyReport, ReportError, ReportHeader, defaultRange, param, type SearchParams } from '../_components/report-page';

export const metadata: Metadata = { title: 'Requisition cycle time' };

export default async function CycleTimePage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const request = await getRequestContext();
  if (!request.actor?.permissions.has('report.view')) return <AccessDenied />;
  const defaults = await defaultRange();
  const departmentId = param(params, 'departmentId');
  const input = { from: param(params, 'from') ?? defaults.from, to: param(params, 'to') ?? defaults.to, ...(departmentId ? { departmentId } : {}) };
  const result = await runQuery(request, requisitionCycleTime, input);

  return (
    <div className="grid gap-6">
      <ReportHeader
        title="Requisition cycle time"
        description="Hours from a requisition's first submission to its final approval, for requisitions approved in the range."
        asOf={result.ok ? result.data.asOf : null}
        timezone={defaults.timezone}
        exportReport="requisitionCycleTime"
        exportParams={input}
      />
      <form method="get" className="grid gap-3 sm:grid-cols-[10rem_10rem_1fr_auto] sm:items-end">
        <div className="grid gap-2">
          <Label htmlFor="cycle-from">Approved from</Label>
          <Input id="cycle-from" name="from" type="date" defaultValue={input.from} required />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="cycle-to">Approved to</Label>
          <Input id="cycle-to" name="to" type="date" defaultValue={input.to} required />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="cycle-department">Department</Label>
          <NativeSelect id="cycle-department" name="departmentId" defaultValue={departmentId ?? ''}>
            <option value="">All departments</option>
            {(result.ok ? result.data.departments : []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.code})
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
      ) : result.data.count === 0 ? (
        <EmptyReport>
          No requisition was approved between {formatDate(result.data.from)} and {formatDate(result.data.to)}.
        </EmptyReport>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Card>
              <CardHeader className="text-sm text-muted-foreground">Requisitions approved</CardHeader>
              <CardContent className="text-2xl font-semibold" data-testid="cycle-count">
                {result.data.count}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="text-sm text-muted-foreground">Median, hours</CardHeader>
              <CardContent className="text-2xl font-semibold" data-testid="cycle-median">
                {result.data.medianHours}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="text-sm text-muted-foreground">90th percentile, hours</CardHeader>
              <CardContent className="text-2xl font-semibold" data-testid="cycle-p90">
                {result.data.p90Hours}
              </CardContent>
            </Card>
          </div>
          <Table aria-label="Approved requisitions">
            <TableHeader>
              <TableRow>
                <TableHead>Requisition</TableHead>
                <TableHead>Department</TableHead>
                <TableHead>First submitted</TableHead>
                <TableHead>Approved</TableHead>
                <TableHead className="text-right">Hours</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.data.rows.map((row) => (
                <TableRow key={row.requisitionId}>
                  <TableCell className="font-mono">
                    <Link href={`/requisitions/${row.requisitionId}`} className="underline-offset-4 hover:underline">
                      {row.number}
                    </Link>
                  </TableCell>
                  <TableCell>{row.departmentName}</TableCell>
                  <TableCell>{formatTimestamp(row.submittedAt, defaults.timezone)}</TableCell>
                  <TableCell>{formatTimestamp(row.approvedAt, defaults.timezone)}</TableCell>
                  <TableCell className="text-right font-mono">{row.hours}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </div>
  );
}
