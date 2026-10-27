import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDate, formatMoney, formatTimestamp, formatUnitPrice } from '@/lib/format';
import { getPurchaseOrder } from '@/modules/purchasing';
import { listGoodsReceipts } from '@/modules/receiving';
import { getOrganization } from '@/server/organization-profile';
import { getRequestContext } from '@/server/request-context';
import { runQuery } from '@/shared/application/runner';
import { ReceiptStatusBadge, receiptKindLabel } from '../../goods-receipts/_components/receipt-status';
import { ApprovalHistory } from '../../requisitions/_components/approval-history';
import { DecisionForm } from '../../requisitions/_components/workflow-forms';
import { CancelPurchaseOrderForm, ClosePurchaseOrderForm, IssuePurchaseOrderForm, SubmitPurchaseOrderForm } from '../_components/po-actions';
import { PoStatusBadge, approvalReasonLabel, poNotice } from '../_components/po-status';

export const metadata: Metadata = { title: 'Purchase order' };

export default async function PurchaseOrderPage(props: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await props.params;
  const notice = poNotice((await props.searchParams).notice);
  const request = await getRequestContext();
  const result = await runQuery(request, getPurchaseOrder, { purchaseOrderId: id });
  if (!result.ok) {
    if (result.error.code === 'NOT_FOUND' || result.error.code === 'VALIDATION_FAILED') notFound();
    return (
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold">{result.error.code === 'FORBIDDEN' ? 'Access denied' : 'Purchase order'}</h1>
        <p className="text-muted-foreground">{result.error.message}</p>
      </div>
    );
  }
  const po = result.data;
  const { timezone } = await getOrganization();
  const can = new Set(po.callerActions);
  const money = (value: string) => formatMoney(value, po.currencyCode, po.currencyScale);
  const issued = po.lines.some((l) => l.maxReceivableQty !== null);
  // Requisitions are readable by procurement, finance, the auditor, and approvers; receivers see the number only.
  const readsRequisitions = (['requisition.read.all', 'requisition.read.department'] as const).some((p) => request.actor?.permissions.has(p) ?? false);
  // The order's goods receipts, for whoever reads receipts (approvers do not).
  const receipts = issued && request.actor?.permissions.has('receipt.read') ? await runQuery(request, listGoodsReceipts, { purchaseOrderId: po.id, limit: 100 }) : null;

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">
            Purchase order <span className="font-mono">{po.number}</span>
          </h1>
          <PoStatusBadge status={po.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          {po.supplier.legalName} · for{' '}
          {readsRequisitions ? (
            <Link href={`/requisitions/${po.requisitionId}`} className="font-mono underline-offset-4 hover:underline">
              {po.requisitionNumber}
            </Link>
          ) : (
            <span className="font-mono">{po.requisitionNumber}</span>
          )}{' '}
          ({po.requisitionTitle}, {po.departmentCode}) · created by {po.createdBy} on {formatTimestamp(po.createdAt, timezone)}
        </p>
      </div>

      {notice ? (
        <Alert role="status">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      {po.openDecision ? (
        <Card>
          <CardHeader>
            <h2 className="font-semibold">Your decision</h2>
          </CardHeader>
          <CardContent>
            <DecisionForm
              approvalRequestId={po.openDecision.approvalRequestId}
              stepNo={po.openDecision.stepNo}
              version={po.openDecision.requestVersion}
              stepLabel={`${po.openDecision.label}, ${po.openDecision.stepNo} of ${po.openDecision.stepCount}`}
            />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <h2 className="font-semibold">Details</h2>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[11rem_1fr] gap-y-2 text-sm">
            <dt className="text-muted-foreground">Supplier</dt>
            <dd>
              {po.supplier.legalName} <span className="font-mono">({po.supplier.code})</span>
              {po.supplier.status !== 'active' ? ` · not active (${po.supplier.status.replace('_', ' ')})` : ''}
            </dd>
            {po.quotation ? (
              <>
                <dt className="text-muted-foreground">Quotation</dt>
                <dd>
                  Awarded on{' '}
                  {request.actor?.permissions.has('rfq.read') ? (
                    <Link href={`/rfqs/${po.quotation.rfqId}`} className="font-mono underline-offset-4 hover:underline">
                      {po.quotation.rfqNumber}
                    </Link>
                  ) : (
                    <span className="font-mono">{po.quotation.rfqNumber}</span>
                  )}
                  {po.quotation.supplierReference ? `, supplier reference ${po.quotation.supplierReference}` : ''}, valid until {formatDate(po.quotation.validUntil)}
                </dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">Payment terms</dt>
            <dd>{po.paymentTerms ?? '—'}</dd>
            <dt className="text-muted-foreground">Delivery address</dt>
            <dd className="whitespace-pre-line">{po.deliveryAddress ?? '—'}</dd>
            <dt className="text-muted-foreground">Expected delivery</dt>
            <dd>{po.expectedDeliveryDate ? formatDate(po.expectedDeliveryDate) : '—'}</dd>
            {po.submittedAt ? (
              <>
                <dt className="text-muted-foreground">Submitted</dt>
                <dd>
                  {formatTimestamp(po.submittedAt, timezone)} by {po.submittedBy}
                </dd>
              </>
            ) : null}
            {po.approvedAt ? (
              <>
                <dt className="text-muted-foreground">Approved</dt>
                <dd>
                  {formatTimestamp(po.approvedAt, timezone)}
                  {po.approvalReasons.length === 0 ? ' (below the approval threshold, no approval round)' : ''}
                </dd>
              </>
            ) : null}
            {po.issuedAt ? (
              <>
                <dt className="text-muted-foreground">Issued</dt>
                <dd>
                  {formatTimestamp(po.issuedAt, timezone)} by {po.issuedBy}, over-receipt tolerance {po.receiptTolerancePct}%
                </dd>
              </>
            ) : null}
            {po.closedAt ? (
              <>
                <dt className="text-muted-foreground">Closed</dt>
                <dd>
                  {formatTimestamp(po.closedAt, timezone)} by {po.closedBy}
                  {po.closeReason ? `: ${po.closeReason}` : ''}
                </dd>
              </>
            ) : null}
            {po.cancelledAt ? (
              <>
                <dt className="text-muted-foreground">Cancelled</dt>
                <dd>
                  {formatTimestamp(po.cancelledAt, timezone)} by {po.cancelledBy}: {po.cancelReason}
                </dd>
              </>
            ) : null}
          </dl>
          {po.approvalReasons.length > 0 ? (
            <div className="mt-4 grid gap-1 text-sm">
              <p className="font-medium">Approval was needed because:</p>
              <ul className="list-disc pl-5">
                {po.approvalReasons.map((reason) => (
                  <li key={reason}>
                    {approvalReasonLabel(reason, { threshold: po.approvalThreshold === null ? null : money(po.approvalThreshold), tolerancePct: po.priceTolerancePct })}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
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
                <TableHead className="text-right">Estimate</TableHead>
                <TableHead className="text-right">Tax</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                {issued ? <TableHead className="text-right">Received</TableHead> : null}
                {issued ? <TableHead className="text-right">Receivable up to</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {po.lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>{l.lineNo}</TableCell>
                  <TableCell className="whitespace-normal">
                    {l.description}
                    <span className="block text-xs text-muted-foreground">Requisition line {l.requisitionLineNo}</span>
                  </TableCell>
                  <TableCell className="text-right">
                    {l.quantity} {l.uom}
                  </TableCell>
                  <TableCell className="text-right">{formatUnitPrice(l.unitPrice, po.currencyScale)}</TableCell>
                  <TableCell className="text-right text-muted-foreground">{formatUnitPrice(l.estimatedUnitPrice, po.currencyScale)}</TableCell>
                  <TableCell className="text-right">
                    {l.taxRatePct}% · {money(l.lineTax)}
                  </TableCell>
                  <TableCell className="text-right">{money(l.lineTotal)}</TableCell>
                  {issued ? (
                    <TableCell className="text-right">
                      {l.receivedQty} {l.uom}
                    </TableCell>
                  ) : null}
                  {issued ? (
                    <TableCell className="text-right">
                      {l.maxReceivableQty} {l.uom}
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <dl className="ml-auto mt-4 grid w-full max-w-xs grid-cols-2 gap-y-1 text-sm" aria-label="Totals">
            <dt className="text-muted-foreground">Subtotal</dt>
            <dd className="text-right">{money(po.subtotal)}</dd>
            <dt className="text-muted-foreground">Tax</dt>
            <dd className="text-right">{money(po.taxTotal)}</dd>
            <dt className="font-medium">Total</dt>
            <dd className="text-right font-medium">{money(po.total)}</dd>
          </dl>
        </CardContent>
      </Card>

      {receipts ? (
        <Card>
          <CardHeader>
            <h2 className="font-semibold">Goods receipts</h2>
          </CardHeader>
          <CardContent>
            {!receipts.ok ? (
              <p className="text-sm text-muted-foreground">{receipts.error.message}</p>
            ) : receipts.data.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">No goods received yet.</p>
            ) : (
              <Table aria-label="Goods receipts">
                <TableHeader>
                  <TableRow>
                    <TableHead>Number</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Received on</TableHead>
                    <TableHead>Recorded by</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {receipts.data.items.map((gr) => (
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
                      <TableCell>{formatDate(gr.receivedOn)}</TableCell>
                      <TableCell>{gr.createdBy}</TableCell>
                      <TableCell>
                        <ReceiptStatusBadge status={gr.status} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <h2 className="font-semibold">Approval history</h2>
        </CardHeader>
        <CardContent>
          {po.approvalHistory.length === 0 && po.approvedAt ? (
            <p className="text-sm text-muted-foreground">No approval round: approved on submission, below the approval threshold.</p>
          ) : (
            <ApprovalHistory rounds={po.approvalHistory} currency={{ code: po.currencyCode, scale: po.currencyScale }} timezone={timezone} />
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-3">
        <Button asChild variant="outline">
          <Link href={`/purchase-orders/${po.id}/print`}>Print view</Link>
        </Button>
        {can.has('edit') ? (
          <Button asChild variant="outline">
            <Link href={`/purchase-orders/${po.id}/edit`}>Edit draft</Link>
          </Button>
        ) : null}
        {can.has('receive') ? (
          <Button asChild>
            <Link href={`/goods-receipts/new?purchaseOrderId=${po.id}`}>Receive goods</Link>
          </Button>
        ) : null}
      </div>

      {can.has('submit') || can.has('issue') || can.has('cancel') || can.has('close') ? (
        <Card>
          <CardHeader>
            <h2 className="font-semibold">Actions</h2>
          </CardHeader>
          <CardContent className="grid gap-6">
            {can.has('submit') ? <SubmitPurchaseOrderForm purchaseOrderId={po.id} version={po.version} /> : null}
            {can.has('issue') ? <IssuePurchaseOrderForm purchaseOrderId={po.id} version={po.version} /> : null}
            {can.has('close') ? <ClosePurchaseOrderForm purchaseOrderId={po.id} version={po.version} reasonRequired={po.status !== 'received'} /> : null}
            {can.has('cancel') ? <CancelPurchaseOrderForm purchaseOrderId={po.id} version={po.version} /> : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
