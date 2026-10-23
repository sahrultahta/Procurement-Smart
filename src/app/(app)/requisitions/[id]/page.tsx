import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatAmount, formatDate, formatMoney, formatTimestamp } from '@/lib/format';
import { getRequisition } from '@/modules/requisitions';
import { getOrganization } from '@/server/organization-profile';
import { getRequestContext } from '@/server/request-context';
import { runQuery } from '@/shared/application/runner';
import { CancelRequisitionForm } from '../_components/cancel-form';
import { RequisitionStatusBadge, requisitionNotice } from '../_components/requisition-status';

export const metadata: Metadata = { title: 'Requisition' };

export default async function RequisitionPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await props.params;
  const notice = requisitionNotice((await props.searchParams).notice);
  const result = await runQuery(await getRequestContext(), getRequisition, { requisitionId: id });
  if (!result.ok) {
    // Someone else's requisition looks exactly like one that does not exist (US-PR-05).
    if (result.error.code === 'NOT_FOUND' || result.error.code === 'VALIDATION_FAILED') notFound();
    return (
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold">{result.error.code === 'FORBIDDEN' ? 'Access denied' : 'Requisition'}</h1>
        <p className="text-muted-foreground">{result.error.message}</p>
      </div>
    );
  }
  const r = result.data;
  const { timezone } = await getOrganization();

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{r.title}</h1>
          <RequisitionStatusBadge status={r.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          <span className="font-mono">{r.number}</span> · {r.requester}, {r.departmentName} ({r.departmentCode}) · created{' '}
          {formatTimestamp(r.createdAt, timezone)}
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
          <dl className="grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
            <dt className="text-muted-foreground">Needed by</dt>
            <dd>{formatDate(r.neededBy)}</dd>
            <dt className="text-muted-foreground">Justification</dt>
            <dd className="whitespace-pre-line">{r.justification ?? '—'}</dd>
            {r.cancelledAt ? (
              <>
                <dt className="text-muted-foreground">Cancelled</dt>
                <dd>
                  {formatTimestamp(r.cancelledAt, timezone)}
                  {r.cancelReason ? `: ${r.cancelReason}` : ''}
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
                <TableHead className="text-right">Quantity</TableHead>
                <TableHead className="text-right">Unit price</TableHead>
                <TableHead className="text-right">Line total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.lines.map((l) => (
                <TableRow key={l.lineNo}>
                  <TableCell>{l.lineNo}</TableCell>
                  <TableCell className="whitespace-normal">{l.description}</TableCell>
                  <TableCell className="text-right">
                    {l.quantity} {l.uom}
                  </TableCell>
                  <TableCell className="text-right">{formatAmount(l.estimatedUnitPrice, Math.max(r.currencyScale, l.estimatedUnitPrice.split('.')[1]?.length ?? 0))}</TableCell>
                  <TableCell className="text-right">{formatMoney(l.lineTotal, r.currencyCode, r.currencyScale)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={4} className="text-right">
                  Estimated total
                </TableCell>
                <TableCell className="text-right font-semibold" data-testid="estimated-total">
                  {formatMoney(r.estimatedTotal, r.currencyCode, r.currencyScale)}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </CardContent>
      </Card>

      {r.callerCanEdit ? (
        <Card>
          <CardHeader>
            <h2 className="font-semibold">Actions</h2>
          </CardHeader>
          <CardContent className="grid gap-6">
            <div>
              <Button asChild variant="outline">
                <Link href={`/requisitions/${r.id}/edit`}>Edit requisition</Link>
              </Button>
            </div>
            <CancelRequisitionForm requisitionId={r.id} version={r.version} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
