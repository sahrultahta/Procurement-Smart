import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { getPurchaseOrder, purchaseOrderFormOptions } from '@/modules/purchasing';
import { getRequestContext } from '@/server/request-context';
import { runQuery } from '@/shared/application/runner';
import { dec } from '@/shared/decimal/decimal';
import { PurchaseOrderForm, type FormLine } from '../../_components/purchase-order-form';

export const metadata: Metadata = { title: 'Edit purchase order' };

export default async function EditPurchaseOrderPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const request = await getRequestContext();
  const result = await runQuery(request, getPurchaseOrder, { purchaseOrderId: id });
  if (!result.ok) {
    if (result.error.code === 'NOT_FOUND' || result.error.code === 'VALIDATION_FAILED') notFound();
    return (
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold">{result.error.code === 'FORBIDDEN' ? 'Access denied' : 'Edit purchase order'}</h1>
        <p className="text-muted-foreground">{result.error.message}</p>
      </div>
    );
  }
  const po = result.data;
  const back = (
    <Link href={`/purchase-orders/${po.id}`} className="underline-offset-4 hover:underline">
      Back to {po.number}
    </Link>
  );
  const options = po.callerActions.includes('edit') ? await runQuery(request, purchaseOrderFormOptions, { requisitionId: po.requisitionId, purchaseOrderId: po.id }) : null;
  if (!options?.ok) {
    return (
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold">Edit purchase order</h1>
        <p className="text-muted-foreground">Only the buyer who created {po.number} can edit it, and only while it is a draft.</p>
        <p className="text-sm">{back}</p>
      </div>
    );
  }
  const o = options.data;
  const quotation = po.quotation ? o.quotations.find((q) => q.id === po.quotation?.id) : null;
  const ordered = new Map(po.lines.map((l) => [l.requisitionLineId, l]));
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
    .filter((l) => (po.quotation ? l.quoted !== null : true) && (ordered.has(l.id) || dec(l.availableQty).gt(0)));

  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">
          Edit purchase order <span className="font-mono">{po.number}</span>
        </h1>
        <p className="text-sm text-muted-foreground">
          {po.supplier.legalName} · for <span className="font-mono">{po.requisitionNumber}</span> ({po.requisitionTitle}) · {back}
        </p>
      </div>
      <Card>
        <CardContent>
          <PurchaseOrderForm
            mode="edit"
            purchaseOrderId={po.id}
            version={po.version}
            currencyCode={po.currencyCode}
            lines={lines}
            values={{
              paymentTerms: po.paymentTerms ?? '',
              deliveryAddress: po.deliveryAddress ?? '',
              expectedDeliveryDate: po.expectedDeliveryDate ?? '',
              lines: Object.fromEntries(po.lines.map((l) => [l.requisitionLineId, { quantity: l.quantity, unitPrice: l.unitPrice, taxRatePct: l.taxRatePct }])),
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
