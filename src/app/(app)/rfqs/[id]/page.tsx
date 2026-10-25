import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatTimestamp } from '@/lib/format';
import { getRfq } from '@/modules/sourcing';
import { getOrganization } from '@/server/organization-profile';
import { getRequestContext } from '@/server/request-context';
import { runQuery } from '@/shared/application/runner';
import { CancelRfqForm, CloseRfqForm, IssueRfqForm } from '../_components/rfq-actions';
import { RfqStatusBadge, rfqNotice } from '../_components/rfq-status';

export const metadata: Metadata = { title: 'RFQ' };

export default async function RfqPage(props: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await props.params;
  const notice = rfqNotice((await props.searchParams).notice);
  const result = await runQuery(await getRequestContext(), getRfq, { rfqId: id });
  if (!result.ok) {
    if (result.error.code === 'NOT_FOUND' || result.error.code === 'VALIDATION_FAILED') notFound();
    return (
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold">{result.error.code === 'FORBIDDEN' ? 'Access denied' : 'RFQ'}</h1>
        <p className="text-muted-foreground">{result.error.message}</p>
      </div>
    );
  }
  const r = result.data;
  const { timezone } = await getOrganization();
  const can = new Set(r.callerActions);

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{r.title}</h1>
          <RfqStatusBadge status={r.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          <span className="font-mono">{r.number}</span> · for{' '}
          <Link href={`/requisitions/${r.requisitionId}`} className="font-mono underline-offset-4 hover:underline">
            {r.requisitionNumber}
          </Link>{' '}
          ({r.requisitionTitle}) · created by {r.createdBy} on {formatTimestamp(r.createdAt, timezone)}
        </p>
      </div>

      {notice ? (
        <Alert role="status">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      {r.requisitionStatus !== 'approved' && (r.status === 'draft' || r.status === 'issued' || r.status === 'closed') ? (
        <Alert>
          <AlertDescription>Requisition {r.requisitionNumber} is no longer approved, so this RFQ cannot be issued or awarded.</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <h2 className="font-semibold">Details</h2>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
            <dt className="text-muted-foreground">Quotations due</dt>
            <dd>{formatTimestamp(r.responseDueAt, timezone)}</dd>
            {r.issuedAt ? (
              <>
                <dt className="text-muted-foreground">Issued</dt>
                <dd>
                  {formatTimestamp(r.issuedAt, timezone)} by {r.issuedBy}
                </dd>
              </>
            ) : null}
            {r.closedAt ? (
              <>
                <dt className="text-muted-foreground">Closed</dt>
                <dd>
                  {formatTimestamp(r.closedAt, timezone)} by {r.closedBy}
                </dd>
              </>
            ) : null}
            {r.cancelledAt ? (
              <>
                <dt className="text-muted-foreground">Cancelled</dt>
                <dd>
                  {formatTimestamp(r.cancelledAt, timezone)} by {r.cancelledBy}: {r.cancelReason}
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
                <TableHead>Requisition line</TableHead>
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
                  <TableCell>{l.requisitionLineNo}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="font-semibold">Invited suppliers</h2>
        </CardHeader>
        <CardContent>
          {r.suppliers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No supplier invited yet.</p>
          ) : (
            <Table aria-label="Invited suppliers">
              <TableHeader>
                <TableRow>
                  <TableHead>Supplier</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>Supplier status</TableHead>
                  <TableHead>Invited</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.suppliers.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>{s.legalName}</TableCell>
                    <TableCell className="font-mono">{s.code}</TableCell>
                    <TableCell>{s.status === 'active' ? 'Active' : `Not active (${s.status.replace('_', ' ')})`}</TableCell>
                    <TableCell>{formatTimestamp(s.invitedAt, timezone)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {can.size > 0 ? (
        <Card>
          <CardHeader>
            <h2 className="font-semibold">Actions</h2>
          </CardHeader>
          <CardContent className="grid gap-6">
            {can.has('edit') ? (
              <div>
                <Button asChild variant="outline">
                  <Link href={`/rfqs/${r.id}/edit`}>Edit RFQ</Link>
                </Button>
              </div>
            ) : null}
            {can.has('issue') ? <IssueRfqForm rfqId={r.id} version={r.version} /> : null}
            {can.has('close') ? <CloseRfqForm rfqId={r.id} version={r.version} /> : null}
            {can.has('cancel') ? <CancelRfqForm rfqId={r.id} version={r.version} /> : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
