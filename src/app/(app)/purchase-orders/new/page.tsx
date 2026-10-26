import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { formatDate, formatMoney } from '@/lib/format';
import { purchaseOrderFormOptions } from '@/modules/purchasing';
import { getRequestContext } from '@/server/request-context';
import { runQuery } from '@/shared/application/runner';
import { dec } from '@/shared/decimal/decimal';
import { PurchaseOrderForm, type FormLine } from '../_components/purchase-order-form';

export const metadata: Metadata = { title: 'New purchase order' };

/** The smaller of two decimal strings. */
const least = (a: string, b: string) => (dec(a).lte(dec(b)) ? a : b);

export default async function NewPurchaseOrderPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await props.searchParams;
  const requisitionId = typeof params.requisitionId === 'string' ? params.requisitionId : '';
  const quotationId = typeof params.quotationId === 'string' ? params.quotationId : null;
  const result = await runQuery(await getRequestContext(), purchaseOrderFormOptions, { requisitionId });
  if (!result.ok) {
    if (result.error.code === 'NOT_FOUND' || result.error.code === 'VALIDATION_FAILED') notFound();
    return (
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold">{result.error.code === 'FORBIDDEN' ? 'Access denied' : 'New purchase order'}</h1>
        <p className="text-muted-foreground">{result.error.code === 'FORBIDDEN' ? 'Purchase orders are created by procurement.' : result.error.message}</p>
      </div>
    );
  }
  const o = result.data;
  const quotation = quotationId ? o.quotations.find((q) => q.id === quotationId) : null;
  if (quotationId && !quotation) notFound();
  const money = (value: string) => formatMoney(value, o.requisition.currencyCode, o.requisition.currencyScale);
  const back = (
    <Link href={`/requisitions/${o.requisition.id}`} className="underline-offset-4 hover:underline">
      Back to {o.requisition.number}
    </Link>
  );
  const heading = (
    <div className="grid gap-1">
      <h1 className="text-2xl font-semibold">New purchase order</h1>
      <p className="text-sm text-muted-foreground">
        For <span className="font-mono">{o.requisition.number}</span> ({o.requisition.title}), estimated {money(o.requisition.estimatedTotal)} · {back}
      </p>
    </div>
  );
  const stop = (message: string, extra?: ReactNode) => (
    <div className="grid gap-4">
      {heading}
      <p role="note" className="text-sm">
        {message}
      </p>
      {extra}
    </div>
  );
  const usable = o.quotations.filter((q) => !q.expired);
  const quotationLinks =
    usable.length > 0 ? (
      <ul className="grid gap-1 text-sm">
        {usable.map((q) => (
          <li key={q.id}>
            <Link href={`/purchase-orders/new?requisitionId=${o.requisition.id}&quotationId=${q.id}`} className="underline-offset-4 hover:underline">
              Order from {q.supplierName}&apos;s quotation on {q.rfqNumber}
            </Link>{' '}
            (valid until {formatDate(q.validUntil)})
          </li>
        ))}
      </ul>
    ) : null;

  if (o.requisition.status !== 'approved') return stop(`Requisition ${o.requisition.number} is ${o.requisition.status.replace('_', ' ')}: only approved requisitions can be ordered.`);
  if (quotation?.expired) return stop(`The quotation on ${quotation.rfqNumber} was valid until ${formatDate(quotation.validUntil)}, so its prices can no longer be ordered.`);
  if (!quotation && o.rfqRequired) {
    return stop(
      `${o.requisition.number} is estimated at or above the RFQ threshold, so it can only be ordered from an awarded quotation.`,
      quotationLinks ?? <p className="text-sm text-muted-foreground">No RFQ of this requisition has a valid award yet.</p>,
    );
  }

  const lines: FormLine[] = o.lines
    .map((l) => {
      const quoted = quotation?.lines.find((q) => q.requisitionLineId === l.id);
      return {
        id: l.id,
        lineNo: l.lineNo,
        description: l.description,
        uom: l.uom,
        estimatedUnitPrice: l.estimatedUnitPrice,
        availableQty: l.availableQty,
        quoted: quoted ? { lineId: quoted.id, unitPrice: quoted.unitPrice, quantity: quoted.quantity } : null,
      };
    })
    .filter((l) => (quotation ? l.quoted !== null : true));
  const open = lines.filter((l) => dec(l.availableQty).gt(0));
  if (open.length === 0) return stop('Everything on this requisition is already ordered.');

  return (
    <div className="grid gap-4">
      {heading}
      {!quotation && quotationLinks ? (
        <div className="grid gap-1">
          <p className="text-sm">This requisition has an awarded quotation. To use its prices:</p>
          {quotationLinks}
        </div>
      ) : null}
      {quotation ? (
        <p className="text-sm text-muted-foreground">
          From the quotation of {quotation.supplierName} on {quotation.rfqNumber}
          {quotation.supplierReference ? ` (${quotation.supplierReference})` : ''}, valid until {formatDate(quotation.validUntil)}. Prices come from the quotation.
        </p>
      ) : null}
      <Card>
        <CardContent>
          <PurchaseOrderForm
            mode="create"
            requisitionId={o.requisition.id}
            quotationId={quotation?.id ?? null}
            supplier={quotation ? { fixed: { id: quotation.supplierId, name: quotation.supplierName } } : { choices: o.suppliers }}
            currencyCode={o.requisition.currencyCode}
            lines={open}
            values={{
              paymentTerms: '',
              deliveryAddress: '',
              expectedDeliveryDate: '',
              lines: Object.fromEntries(
                open.map((l) => [l.id, { quantity: l.quoted ? least(l.availableQty, l.quoted.quantity) : l.availableQty, unitPrice: l.estimatedUnitPrice, taxRatePct: '0' }]),
              ),
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
