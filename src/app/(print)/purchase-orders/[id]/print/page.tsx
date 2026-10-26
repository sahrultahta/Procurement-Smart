import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { formatDate, formatMoney, formatTimestamp, formatUnitPrice } from '@/lib/format';
import { getPurchaseOrder } from '@/modules/purchasing';
import { getOrganization } from '@/server/organization-profile';
import { getRequestContext } from '@/server/request-context';
import { runQuery } from '@/shared/application/runner';
import { PrintButton } from './print-button';

export const metadata: Metadata = { title: 'Purchase order (print)' };

/**
 * P7-AC9: the purchase order as a printable document, for whoever may read it (po.get decides;
 * anyone else gets the same "not found" as for an order that does not exist).
 */
export default async function PurchaseOrderPrintPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const result = await runQuery(await getRequestContext(), getPurchaseOrder, { purchaseOrderId: id });
  if (!result.ok) {
    if (result.error.code === 'NOT_FOUND' || result.error.code === 'VALIDATION_FAILED' || result.error.code === 'FORBIDDEN') notFound();
    return <p className="text-muted-foreground">{result.error.message}</p>;
  }
  const po = result.data;
  const org = await getOrganization();
  const money = (value: string) => formatMoney(value, po.currencyCode, po.currencyScale);
  const sendable = po.status === 'issued' || po.status === 'partially_received' || po.status === 'received' || po.status === 'closed';
  const approvers = po.approvalHistory
    .filter((round) => round.status === 'approved')
    .flatMap((round) => round.steps.filter((s) => s.decidedBy).map((s) => `${s.label}: ${s.decidedBy}${s.decidedAt ? `, ${formatTimestamp(s.decidedAt, org.timezone)}` : ''}`));

  return (
    <article className="grid gap-6 text-sm" aria-labelledby="po-title">
      <div className="flex items-center justify-between gap-4 print:hidden">
        <Link href={`/purchase-orders/${po.id}`} className="underline-offset-4 hover:underline">
          Back to {po.number}
        </Link>
        <PrintButton />
      </div>

      {!sendable ? (
        <p role="note" className="rounded-md border border-destructive p-3 font-medium text-destructive">
          Not issued: this purchase order is {po.status.replace('_', ' ')} and must not be sent to the supplier.
        </p>
      ) : null}
      {po.status === 'cancelled' ? <p className="font-medium">Cancelled{po.cancelReason ? `: ${po.cancelReason}` : ''}</p> : null}

      <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
        <div>
          <p className="text-lg font-semibold">{org.orgName}</p>
          <h1 id="po-title" className="text-2xl font-semibold">
            Purchase order <span className="font-mono">{po.number}</span>
          </h1>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">Issued</dt>
          <dd>{po.issuedAt ? formatTimestamp(po.issuedAt, org.timezone) : '—'}</dd>
          <dt className="text-muted-foreground">Requisition</dt>
          <dd className="font-mono">{po.requisitionNumber}</dd>
          {po.quotation ? (
            <>
              <dt className="text-muted-foreground">Your quotation</dt>
              <dd>
                {po.quotation.supplierReference ?? '—'} ({po.quotation.rfqNumber})
              </dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Buyer</dt>
          <dd>{po.createdBy}</dd>
        </dl>
      </header>

      <section className="grid gap-6 sm:grid-cols-2" aria-label="Parties">
        <div>
          <h2 className="mb-1 font-semibold">Supplier</h2>
          <p>{po.supplier.legalName}</p>
          {po.supplier.addressLines.map((line) => (
            <p key={line}>{line}</p>
          ))}
          <p>{po.supplier.countryCode}</p>
          {po.supplier.taxId ? <p>Tax ID {po.supplier.taxId}</p> : null}
          {po.supplier.email ? <p>{po.supplier.email}</p> : null}
          {po.supplier.phone ? <p>{po.supplier.phone}</p> : null}
        </div>
        <div>
          <h2 className="mb-1 font-semibold">Deliver to</h2>
          <p className="whitespace-pre-line">{po.deliveryAddress ?? org.orgName}</p>
          <p className="mt-2">
            <span className="text-muted-foreground">Expected delivery:</span> {po.expectedDeliveryDate ? formatDate(po.expectedDeliveryDate) : '—'}
          </p>
          <p>
            <span className="text-muted-foreground">Payment terms:</span> {po.paymentTerms ?? '—'}
          </p>
        </div>
      </section>

      <table className="w-full border-collapse" aria-label="Order lines">
        <thead>
          <tr className="border-b text-left">
            <th className="py-1 pr-2">#</th>
            <th className="py-1 pr-2">Item</th>
            <th className="py-1 pr-2 text-right">Quantity</th>
            <th className="py-1 pr-2 text-right">Unit price</th>
            <th className="py-1 pr-2 text-right">Tax</th>
            <th className="py-1 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {po.lines.map((l) => (
            <tr key={l.id} className="border-b align-top">
              <td className="py-1 pr-2">{l.lineNo}</td>
              <td className="py-1 pr-2">{l.description}</td>
              <td className="py-1 pr-2 text-right">
                {l.quantity} {l.uom}
              </td>
              <td className="py-1 pr-2 text-right">{formatUnitPrice(l.unitPrice, po.currencyScale)}</td>
              <td className="py-1 pr-2 text-right">
                {l.taxRatePct}% ({money(l.lineTax)})
              </td>
              <td className="py-1 text-right">{money(l.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="ml-auto grid w-full max-w-xs grid-cols-2 gap-y-1" aria-label="Totals">
        <dt className="text-muted-foreground">Subtotal</dt>
        <dd className="text-right">{money(po.subtotal)}</dd>
        <dt className="text-muted-foreground">Tax</dt>
        <dd className="text-right">{money(po.taxTotal)}</dd>
        <dt className="font-semibold">Total ({po.currencyCode})</dt>
        <dd className="text-right font-semibold">{money(po.total)}</dd>
      </dl>

      <footer className="grid gap-1 border-t pt-4 text-muted-foreground">
        {approvers.length > 0 ? (
          <p>Approved by {approvers.join('; ')}.</p>
        ) : po.approvedAt ? (
          <p>Approved on submission: below the approval threshold.</p>
        ) : null}
        <p>Please quote {po.number} on every delivery note and invoice.</p>
      </footer>
    </article>
  );
}
