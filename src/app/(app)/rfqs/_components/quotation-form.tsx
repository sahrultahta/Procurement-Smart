'use client';

import { useActionState, useState } from 'react';
import { FieldError, FormMessage } from '@/components/form-message';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ActionForm } from '@/components/action-form';
import { IDLE } from '@/lib/action-state';
import { recordQuotationAction, updateQuotationAction } from '../actions';

/*
 * Record (QUO-T01) or edit (QUO-T02) a quotation: one unit price per RFQ line, without tax.
 * Quantities come from the RFQ; the server computes every total.
 */

type Line = { id: string; lineNo: number; description: string; quantity: string; uom: string };

type Props = {
  rfqId: string;
  lines: Line[];
  currencyCode: string;
} & (
  | { mode: 'record'; supplierId: string }
  | {
      mode: 'edit';
      quotation: { id: string; version: number; supplierReference: string | null; validUntil: string; leadTimeDays: number; prices: Record<string, string> };
    }
);

export function QuotationForm(props: Props) {
  const [state, formAction, pending] = useActionState(props.mode === 'record' ? recordQuotationAction : updateQuotationAction, IDLE);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const existing = props.mode === 'edit' ? props.quotation : null;
  const describedBy = (name: string) => (state.status === 'error' && state.fieldErrors?.[name] ? `${name}-error` : undefined);

  return (
    <ActionForm action={formAction} className="grid gap-4" noValidate>
      <input type="hidden" name="rfqId" value={props.rfqId} />
      {props.mode === 'record' ? (
        <>
          <input type="hidden" name="supplierId" value={props.supplierId} />
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
        </>
      ) : (
        <>
          <input type="hidden" name="quotationId" value={props.quotation.id} />
          <input type="hidden" name="expectedVersion" value={props.quotation.version} />
        </>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="grid gap-2">
          <Label htmlFor="quotation-reference">Supplier&apos;s reference (optional)</Label>
          <Input
            id="quotation-reference"
            name="supplierReference"
            maxLength={100}
            defaultValue={existing?.supplierReference ?? ''}
            disabled={pending}
            aria-describedby={describedBy('supplierReference')}
          />
          <FieldError state={state} name="supplierReference" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="quotation-valid-until">Valid until</Label>
          <Input
            id="quotation-valid-until"
            name="validUntil"
            type="date"
            required
            defaultValue={existing?.validUntil ?? ''}
            disabled={pending}
            aria-describedby={describedBy('validUntil')}
          />
          <FieldError state={state} name="validUntil" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="quotation-lead-time">Lead time (days)</Label>
          <Input
            id="quotation-lead-time"
            name="leadTimeDays"
            type="number"
            min={0}
            max={365}
            step={1}
            required
            defaultValue={existing ? String(existing.leadTimeDays) : ''}
            disabled={pending}
            aria-describedby={describedBy('leadTimeDays')}
          />
          <FieldError state={state} name="leadTimeDays" />
        </div>
      </div>

      <Table aria-label="Prices">
        <TableHeader>
          <TableRow>
            <TableHead>#</TableHead>
            <TableHead>Item</TableHead>
            <TableHead className="text-right">Quantity</TableHead>
            <TableHead>Unit price ({props.currencyCode}, without tax)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {props.lines.map((line, i) => (
            <TableRow key={line.id}>
              <TableCell>{line.lineNo}</TableCell>
              <TableCell className="whitespace-normal">{line.description}</TableCell>
              <TableCell className="text-right">
                {line.quantity} {line.uom}
              </TableCell>
              <TableCell>
                <input type="hidden" name="rfqLineId" value={line.id} />
                <Input
                  id={`price-${line.lineNo}`}
                  name="unitPrice"
                  inputMode="decimal"
                  required
                  defaultValue={existing?.prices[line.id] ?? ''}
                  disabled={pending}
                  aria-label={`Unit price for line ${line.lineNo}, ${line.description}`}
                  aria-describedby={describedBy(`lines.${i}.unitPrice`)}
                  className="max-w-40"
                />
                <FieldError state={state} name={`lines.${i}.unitPrice`} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <FieldError state={state} name="lines" />
      <p className="text-sm text-muted-foreground">
        The quotation is saved as a draft. Line totals and the total are calculated when you save. Submit it from the RFQ page once it is
        complete: only submitted quotations count in the comparison.
      </p>
      <FormMessage state={state} />
      <div>
        <Button type="submit" disabled={pending}>
          {props.mode === 'record' ? 'Save draft quotation' : 'Save changes'}
        </Button>
      </div>
    </ActionForm>
  );
}
