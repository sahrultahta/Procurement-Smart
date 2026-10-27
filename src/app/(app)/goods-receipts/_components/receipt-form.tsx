'use client';

import { useActionState, useState } from 'react';
import { FieldError, FormMessage } from '@/components/form-message';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { ActionForm } from '@/components/action-form';
import { IDLE } from '@/lib/action-state';
import { createGoodsReceiptAction } from '../actions';

/*
 * Record a goods receipt (GR-T01): when the goods arrived, the delivery note, and how much of each
 * order line. Nothing is received until the draft is posted; the server checks every quantity
 * against what the line can still take.
 */

export type ReceiptFormLine = {
  id: string;
  lineNo: number;
  description: string;
  uom: string;
  quantity: string;
  receivedQty: string;
  remainingQty: string;
};

type Props = { purchaseOrderId: string; issuedOn: string; today: string; lines: ReceiptFormLine[] };

export function GoodsReceiptForm({ purchaseOrderId, issuedOn, today, lines }: Props) {
  const [state, formAction, pending] = useActionState(createGoodsReceiptAction, IDLE);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [included, setIncluded] = useState<Set<string>>(() => new Set(lines.map((l) => l.id)));
  const describedBy = (name: string) => (state.status === 'error' && state.fieldErrors?.[name] ? `${name}-error` : undefined);
  // Field errors name lines by their position among the received ones, as the action sends them.
  const position = new Map(lines.filter((l) => included.has(l.id)).map((l, i) => [l.id, i]));
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
      <input type="hidden" name="purchaseOrderId" value={purchaseOrderId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="gr-received-on">Received on</Label>
          <Input
            id="gr-received-on"
            name="receivedOn"
            type="date"
            min={issuedOn}
            max={today}
            defaultValue={today}
            disabled={pending}
            aria-describedby={describedBy('receivedOn')}
          />
          <FieldError state={state} name="receivedOn" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="gr-delivery-note">Delivery note reference (optional)</Label>
          <Input id="gr-delivery-note" name="deliveryNoteRef" maxLength={100} disabled={pending} aria-describedby={describedBy('deliveryNoteRef')} />
          <FieldError state={state} name="deliveryNoteRef" />
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="gr-notes">Notes (optional)</Label>
        <Textarea id="gr-notes" name="notes" maxLength={1000} rows={2} disabled={pending} aria-describedby={describedBy('notes')} />
        <FieldError state={state} name="notes" />
      </div>

      <Table aria-label="Lines received">
        <TableHeader>
          <TableRow>
            <TableHead>Receive</TableHead>
            <TableHead>Item</TableHead>
            <TableHead>Quantity received</TableHead>
            <TableHead>Note (optional)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((line) => {
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
                    aria-label={`Receive line ${line.lineNo}, ${line.description}`}
                  />
                </TableCell>
                <TableCell className="whitespace-normal">
                  <span className="font-medium">{line.lineNo}.</span> {line.description}
                  <span className="block text-xs text-muted-foreground">
                    Ordered {line.quantity} {line.uom} · received so far {line.receivedQty} · can still take {line.remainingQty}
                  </span>
                </TableCell>
                <TableCell>
                  <Input
                    id={`quantity-${line.lineNo}`}
                    name={`quantity-${line.id}`}
                    inputMode="decimal"
                    defaultValue={line.remainingQty}
                    disabled={pending || !on}
                    aria-label={`Quantity received for line ${line.lineNo}, ${line.description} (${line.uom})`}
                    aria-describedby={describedBy(lineField(line.id, 'quantity'))}
                    className="max-w-28"
                  />
                  <FieldError state={state} name={lineField(line.id, 'quantity')} />
                  <FieldError state={state} name={lineField(line.id, 'purchaseOrderLineId')} />
                </TableCell>
                <TableCell>
                  <Input
                    id={`note-${line.lineNo}`}
                    name={`note-${line.id}`}
                    maxLength={500}
                    disabled={pending || !on}
                    aria-label={`Note for line ${line.lineNo}, ${line.description}`}
                    aria-describedby={describedBy(lineField(line.id, 'note'))}
                  />
                  <FieldError state={state} name={lineField(line.id, 'note')} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <FieldError state={state} name="lines" />
      <p className="text-sm text-muted-foreground">
        Saving records a draft. Post it to add the quantities to the purchase order; a receipt that would take any line over what it can
        still take is refused as a whole.
      </p>
      <FormMessage state={state} />
      <div>
        <Button type="submit" disabled={pending}>
          Save draft receipt
        </Button>
      </div>
    </ActionForm>
  );
}
