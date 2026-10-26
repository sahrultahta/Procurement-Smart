import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatAmount, formatDate, formatMoney, formatTimestamp } from '@/lib/format';
import { PO_READ_PERMISSIONS, listPurchaseOrders } from '@/modules/purchasing';
import { getRequisition, type RequisitionDetailDto } from '@/modules/requisitions';
import { listRfqs } from '@/modules/sourcing';
import { getOrganization } from '@/server/organization-profile';
import { getRequestContext } from '@/server/request-context';
import { runQuery } from '@/shared/application/runner';
import { ApprovalHistory } from '../_components/approval-history';
import { CancelRequisitionForm, type CancelMode } from '../_components/cancel-form';
import { PoStatusBadge } from '../../purchase-orders/_components/po-status';
import { RfqStatusBadge } from '../../rfqs/_components/rfq-status';
import { RequisitionStatusBadge, requisitionNotice } from '../_components/requisition-status';
import { CloseRequisitionForm, DecisionForm, SubmitRequisitionForm } from '../_components/workflow-forms';

export const metadata: Metadata = { title: 'Requisition' };

function cancelMode(status: RequisitionDetailDto['status']): CancelMode {
  return status === 'pending_approval' ? 'withdraw' : status === 'approved' ? 'approved' : 'draft';
}

/** The approver's comment from the step that sent it back, in the latest round. */
function returnComment(r: RequisitionDetailDto): { by: string; comment: string } | null {
  const latest = r.approvalHistory.at(-1);
  const step = latest?.status === 'returned' ? latest.steps.find((s) => s.status === 'returned') : undefined;
  return step?.decidedBy && step.comment ? { by: step.decidedBy, comment: step.comment } : null;
}

export default async function RequisitionPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await props.params;
  const notice = requisitionNotice((await props.searchParams).notice);
  const request = await getRequestContext();
  const result = await runQuery(request, getRequisition, { requisitionId: id });
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
  const returned = r.status === 'returned' ? returnComment(r) : null;
  const can = new Set(r.callerActions);
  // Sourcing is shown to those who may read RFQs; the page composes both modules' queries.
  const rfqs = request.actor?.permissions.has('rfq.read') ? await runQuery(request, listRfqs, { requisitionId: r.id, limit: 100 }) : null;
  const canSource = r.status === 'approved' && (request.actor?.permissions.has('rfq.manage') ?? false);
  // The same for purchase orders (Phase 7): who reads them, and whether something is left to order.
  const orders = PO_READ_PERMISSIONS.some((p) => request.actor?.permissions.has(p)) ? await runQuery(request, listPurchaseOrders, { requisitionId: r.id, limit: 100 }) : null;
  const canOrder = r.status === 'approved' && (request.actor?.permissions.has('po.create') ?? false) && r.lines.some((l) => l.remainingQty !== '0');

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

      {returned ? (
        <Alert>
          <AlertTitle>Returned for changes by {returned.by}</AlertTitle>
          <AlertDescription className="whitespace-pre-line">{returned.comment}</AlertDescription>
        </Alert>
      ) : null}

      {r.openDecision ? (
        <Card>
          <CardHeader>
            <h2 className="font-semibold">Your approval</h2>
          </CardHeader>
          <CardContent>
            <DecisionForm
              approvalRequestId={r.openDecision.approvalRequestId}
              stepNo={r.openDecision.stepNo}
              version={r.openDecision.requestVersion}
              stepLabel={`${r.openDecision.label}, ${r.openDecision.stepNo} of ${r.openDecision.stepCount}`}
            />
          </CardContent>
        </Card>
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
            {r.submittedAt ? (
              <>
                <dt className="text-muted-foreground">Last submitted</dt>
                <dd>{formatTimestamp(r.submittedAt, timezone)}</dd>
              </>
            ) : null}
            {r.approvedAt ? (
              <>
                <dt className="text-muted-foreground">Approved</dt>
                <dd>{formatTimestamp(r.approvedAt, timezone)}</dd>
              </>
            ) : null}
            {r.cancelledAt ? (
              <>
                <dt className="text-muted-foreground">Cancelled</dt>
                <dd>
                  {formatTimestamp(r.cancelledAt, timezone)}
                  {r.cancelReason ? `: ${r.cancelReason}` : ''}
                </dd>
              </>
            ) : null}
            {r.closedAt ? (
              <>
                <dt className="text-muted-foreground">Closed</dt>
                <dd>
                  {formatTimestamp(r.closedAt, timezone)}
                  {r.closeReason ? `: ${r.closeReason}` : ''}
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

      <Card>
        <CardHeader>
          <h2 className="font-semibold">Approval</h2>
        </CardHeader>
        <CardContent>
          <ApprovalHistory rounds={r.approvalHistory} currency={{ code: r.currencyCode, scale: r.currencyScale }} timezone={timezone} />
        </CardContent>
      </Card>

      {rfqs?.ok && (rfqs.data.items.length > 0 || canSource) ? (
        <Card>
          <CardHeader>
            <h2 className="font-semibold">Requests for quotation</h2>
          </CardHeader>
          <CardContent className="grid gap-4">
            {rfqs.data.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">No RFQ for this requisition yet.</p>
            ) : (
              <Table aria-label="Requests for quotation">
                <TableHeader>
                  <TableRow>
                    <TableHead>Number</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>Quotations due</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rfqs.data.items.map((q) => (
                    <TableRow key={q.id}>
                      <TableCell className="font-mono">
                        <Link href={`/rfqs/${q.id}`} className="underline-offset-4 hover:underline">
                          {q.number}
                        </Link>
                      </TableCell>
                      <TableCell className="whitespace-normal">{q.title}</TableCell>
                      <TableCell>{formatTimestamp(q.responseDueAt, timezone)}</TableCell>
                      <TableCell>
                        <RfqStatusBadge status={q.status} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {canSource ? (
              <div>
                <Button asChild variant="outline">
                  <Link href={`/rfqs/new?requisitionId=${r.id}`}>Request quotations</Link>
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {orders?.ok && (orders.data.items.length > 0 || canOrder) ? (
        <Card>
          <CardHeader>
            <h2 className="font-semibold">Purchase orders</h2>
          </CardHeader>
          <CardContent className="grid gap-4">
            {orders.data.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">No purchase order for this requisition yet.</p>
            ) : (
              <Table aria-label="Purchase orders">
                <TableHeader>
                  <TableRow>
                    <TableHead>Number</TableHead>
                    <TableHead>Supplier</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orders.data.items.map((po) => (
                    <TableRow key={po.id}>
                      <TableCell className="font-mono">
                        <Link href={`/purchase-orders/${po.id}`} className="underline-offset-4 hover:underline">
                          {po.number}
                        </Link>
                      </TableCell>
                      <TableCell className="whitespace-normal">{po.supplierName}</TableCell>
                      <TableCell className="text-right">{formatMoney(po.total, po.currencyCode, po.currencyScale)}</TableCell>
                      <TableCell>
                        <PoStatusBadge status={po.status} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {canOrder ? (
              <div>
                <Button asChild variant="outline">
                  <Link href={`/purchase-orders/new?requisitionId=${r.id}`}>Create purchase order</Link>
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {can.size > 0 ? (
        <Card>
          <CardHeader>
            <h2 className="font-semibold">Actions</h2>
          </CardHeader>
          <CardContent className="grid gap-6">
            {can.has('edit') ? (
              <div>
                <Button asChild variant="outline">
                  <Link href={`/requisitions/${r.id}/edit`}>Edit requisition</Link>
                </Button>
              </div>
            ) : null}
            {can.has('submit') ? <SubmitRequisitionForm requisitionId={r.id} version={r.version} /> : null}
            {can.has('close') ? <CloseRequisitionForm requisitionId={r.id} version={r.version} /> : null}
            {can.has('cancel') ? <CancelRequisitionForm requisitionId={r.id} version={r.version} mode={cancelMode(r.status)} /> : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
