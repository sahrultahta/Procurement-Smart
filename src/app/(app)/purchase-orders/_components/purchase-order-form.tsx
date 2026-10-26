'use client';

import { useActionState, useState } from 'react';
import { FieldError, FormMessage } from '@/components/form-message';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { ActionForm } from '@/components/action-form';
import { IDLE } from '@/lib/action-state';
import { createPurchaseOrderAction, updatePurchaseOrderAction } from '../actions';

/*
 * Create (PO-T01) or edit (PO-T02) a purchase order: which requisition lines to order, how much,
 * at what price (from the quotation, when there is one), and the tax rate of each line.
 * Descriptions and units come from the requisition; the server computes every amount.
 */

export type FormLine = {
  id: string;
  lineNo: number;
  description: string;
  uom: string;
  estimatedUnitPrice: string;
  availableQty: string;
  /** The quoted line and price, when the order comes from a quotation. */
  quoted: { lineId: string; unitPrice: string; quantity: string } | null;
};

export type FormValues = {
  paymentTerms: string;
  deliveryAddress: string;
  expectedDeliveryDate: string;
  lines: Record<string, { quantity: string; unitPrice: string; taxRatePct: string }>;
};

type Props = {
  currencyCode: string;
  lines: FormLine[];
  values: FormValues;
} & (
  | {
      mode: 'create';
      requisitionId: string;
      /** A fixed supplier (from the quotation), or the choice of active suppliers. */
      supplier: { fixed: { id: string; name: string } } | { choices: { id: string; code: string; legalName: string }[] };
      quotationId: string | null;
    }
  | { mode: 'edit'; purchaseOrderId: string; version: number }
);

export function PurchaseOrderForm(props: Props) {
  const [state, formAction, pending] = useActionState(props.mode === 'create' ? createPurchaseOrderAction : updatePurchaseOrderAction, IDLE);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [included, setIncluded] = useState<Set<string>>(() => new Set(Object.keys(props.values.lines)));
  const describedBy = (name: string) => (state.status === 'error' && state.fieldErrors?.[name] ? `${name}-error` : undefined);
  // Field errors name lines by their position among the ordered ones, as the action sends them.
  const position = new Map(props.lines.filter((l) => included.has(l.id)).map((l, i) => [l.id, i]));
  const lineField = (lineId: string, field: string) => `lines.${position.get(lineId) ?? -1}.${field}`;
  const toggle = (lineId: string, on: boolean) =>
    setIncluded((current) => {
      const next = new Set(current);
      if (on) next.add(lineId);
      else next.delete(lineId);
      return next;
    });

  return (
    <ActionForm action={formAction} className="grid gap-4" noValidate>
      {props.mode === 'create' ? (
        <>
          <input type="hidden" name="requisitionId" value={props.requisitionId} />
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
          {props.quotationId ? <input type="hidden" name="quotationId" value={props.quotationId} /> : null}
        </>
      ) : (
        <>
          <input type="hidden" name="purchaseOrderId" value={props.purchaseOrderId} />
          <input type="hidden" name="expectedVersion" value={props.version} />
        </>
      )}

      {props.mode === 'create' ? (
        'fixed' in props.supplier ? (
          <p className="text-sm">
            <input type="hidden" name="supplierId" value={props.supplier.fixed.id} />
            Supplier: <span className="font-medium">{props.supplier.fixed.name}</span> (from the awarded quotation)
          </p>
        ) : (
          <div className="grid gap-2">
            <Label htmlFor="po-supplier">Supplier</Label>
            <NativeSelect id="po-supplier" name="supplierId" defaultValue="" disabled={pending} aria-describedby={describedBy('supplierId')}>
              <option value="">Choose an active supplier</option>
              {props.supplier.choices.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.legalName} ({s.code})
                </option>
              ))}
            </NativeSelect>
            <FieldError state={state} name="supplierId" />
          </div>
        )
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="po-payment-terms">Payment terms (optional)</Label>
          <Input
            id="po-payment-terms"
            name="paymentTerms"
            maxLength={500}
            defaultValue={props.values.paymentTerms}
            disabled={pending}
            aria-describedby={describedBy('paymentTerms')}
          />
          <FieldError state={state} name="paymentTerms" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="po-delivery-date">Expected delivery (optional)</Label>
          <Input
            id="po-delivery-date"
            name="expectedDeliveryDate"
            type="date"
            defaultValue={props.values.expectedDeliveryDate}
            disabled={pending}
            aria-describedby={describedBy('expectedDeliveryDate')}
          />
          <FieldError state={state} name="expectedDeliveryDate" />
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="po-delivery-address">Delivery address (optional)</Label>
        <Textarea
          id="po-delivery-address"
          name="deliveryAddress"
          maxLength={500}
          rows={2}
          defaultValue={props.values.deliveryAddress}
          disabled={pending}
          aria-describedby={describedBy('deliveryAddress')}
        />
        <FieldError state={state} name="deliveryAddress" />
      </div>

      <Table aria-label="Lines to order">
        <TableHeader>
          <TableRow>
            <TableHead>Order</TableHead>
            <TableHead>Item</TableHead>
            <TableHead>Quantity</TableHead>
            <TableHead>Unit price ({props.currencyCode}, without tax)</TableHead>
            <TableHead>Tax (%)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {props.lines.map((line) => {
            const value = props.values.lines[line.id];
            const on = included.has(line.id);
            return (
              <TableRow key={line.id}>
                <TableCell>
                  <input
                    type="checkbox"
                    id={`include-${line.lineNo}`}
                    name="include"
                    value={line.id}
                    checked={on}
                    onChange={(event) => toggle(line.id, event.currentTarget.checked)}
                    disabled={pending}
                    className="size-4"
                    aria-label={`Order line ${line.lineNo}, ${line.description}`}
                  />
                </TableCell>
                <TableCell className="whitespace-normal">
                  <span className="font-medium">{line.lineNo}.</span> {line.description}
                  <span className="block text-xs text-muted-foreground">
                    {line.availableQty} {line.uom} left to order · estimate {line.estimatedUnitPrice}
                    {line.quoted ? ` · quoted ${line.quoted.quantity} ${line.uom}` : ''}
                  </span>
                </TableCell>
                <TableCell>
                  <Input
                    id={`quantity-${line.lineNo}`}
                    name={`quantity-${line.id}`}
                    inputMode="decimal"
                    defaultValue={value?.quantity ?? ''}
                    disabled={pending || !on}
                    aria-label={`Quantity for line ${line.lineNo}, ${line.description} (${line.uom})`}
                    aria-describedby={describedBy(lineField(line.id, 'quantity'))}
                    className="max-w-28"
                  />
                  <FieldError state={state} name={lineField(line.id, 'quantity')} />
                </TableCell>
                <TableCell>
                  {line.quoted ? (
                    <>
                      <input type="hidden" name={`quotationLineId-${line.id}`} value={line.quoted.lineId} disabled={!on} />
                      <span>{line.quoted.unitPrice}</span>
                      <span className="block text-xs text-muted-foreground">from the quotation</span>
                    </>
                  ) : (
                    <Input
                      id={`price-${line.lineNo}`}
                      name={`unitPrice-${line.id}`}
                      inputMode="decimal"
                      defaultValue={value?.unitPrice ?? line.estimatedUnitPrice}
                      disabled={pending || !on}
                      aria-label={`Unit price for line ${line.lineNo}, ${line.description}`}
                      aria-describedby={describedBy(lineField(line.id, 'unitPrice'))}
                      className="max-w-36"
                    />
                  )}
                  <FieldError state={state} name={lineField(line.id, 'unitPrice')} />
                  <FieldError state={state} name={lineField(line.id, 'quotationLineId')} />
                </TableCell>
                <TableCell>
                  <Input
                    id={`tax-${line.lineNo}`}
                    name={`taxRatePct-${line.id}`}
                    inputMode="decimal"
                    defaultValue={value?.taxRatePct ?? '0'}
                    disabled={pending || !on}
                    aria-label={`Tax rate in percent for line ${line.lineNo}, ${line.description}`}
                    aria-describedby={describedBy(lineField(line.id, 'taxRatePct'))}
                    className="max-w-24"
                  />
                  <FieldError state={state} name={lineField(line.id, 'taxRatePct')} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <FieldError state={state} name="lines" />
      <p className="text-sm text-muted-foreground">
        Line amounts, tax, and totals are calculated when you save. The quantities are reserved on the requisition while the order is
        open; cancelling or rejecting it gives them back.
      </p>
      <FormMessage state={state} />
      <div>
        <Button type="submit" disabled={pending}>
          {props.mode === 'create' ? 'Save draft purchase order' : 'Save changes'}
        </Button>
      </div>
    </ActionForm>
  );
}
