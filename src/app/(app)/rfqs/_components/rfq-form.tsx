'use client';

import { useActionState, useState } from 'react';
import { FieldError, FormMessage } from '@/components/form-message';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ActionForm } from '@/components/action-form';
import { IDLE, type ActionState } from '@/lib/action-state';
import type { SourcingOptionsDto } from '@/modules/sourcing';
import { createRfqAction, updateRfqAction } from '../actions';

export type RfqFormValues = { title: string; responseDueAt: string; lines: Record<string, string>; supplierIds: string[] };

type LineChoice = { selected: boolean; quantity: string };

function errorsUnder(state: ActionState, prefix: string): string[] {
  if (state.status !== 'error') return [];
  return Object.entries(state.fieldErrors ?? {})
    .filter(([key]) => key === prefix || key.startsWith(`${prefix}.`))
    .flatMap(([, messages]) => messages);
}

/**
 * Lines come from the requisition: the buyer picks which ones and how much of each. A line
 * already on another RFQ, or with nothing left to order, cannot be picked (the server checks
 * again). Due times are wall-clock times in the organization's time zone.
 */
export function RfqForm(props: { options: SourcingOptionsDto; timezone: string; rfq?: { id: string; version: number; values: RfqFormValues } }) {
  const editing = props.rfq !== undefined;
  const [state, formAction, pending] = useActionState(editing ? updateRfqAction : createRfqAction, IDLE);
  const initial = props.rfq?.values;
  // remainingQty is a normalized decimal string: "0" when nothing is left.
  const available = (l: SourcingOptionsDto['lines'][number]) => l.onRfq === null && l.remainingQty !== '0';
  const [lines, setLines] = useState<Record<string, LineChoice>>(() =>
    Object.fromEntries(
      props.options.lines.map((l) => {
        const kept = initial?.lines[l.id];
        return [l.id, kept !== undefined ? { selected: true, quantity: kept } : { selected: !initial && available(l), quantity: l.remainingQty }];
      }),
    ),
  );
  const [suppliers, setSuppliers] = useState<Set<string>>(() => new Set(initial?.supplierIds ?? []));
  // One key per form: a double submit returns the first RFQ instead of a second one.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const chosenLines = props.options.lines
    .filter((l) => lines[l.id]?.selected)
    .map((l) => ({ requisitionLineId: l.id, quantity: (lines[l.id]?.quantity ?? '').trim() }));
  const setLine = (id: string, change: Partial<LineChoice>) => setLines((all) => ({ ...all, [id]: { ...(all[id] ?? { selected: false, quantity: '' }), ...change } }));
  const toggleSupplier = (id: string, on: boolean) =>
    setSuppliers((all) => {
      const next = new Set(all);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <ActionForm action={formAction} className="grid gap-5" noValidate>
      <input type="hidden" name="lines" value={JSON.stringify(chosenLines)} />
      <input type="hidden" name="supplierIds" value={JSON.stringify(props.options.suppliers.filter((s) => suppliers.has(s.id)).map((s) => s.id))} />
      {props.rfq ? (
        <>
          <input type="hidden" name="rfqId" value={props.rfq.id} />
          <input type="hidden" name="expectedVersion" value={props.rfq.version} />
        </>
      ) : (
        <>
          <input type="hidden" name="requisitionId" value={props.options.requisition.id} />
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
        </>
      )}
      <div className="grid gap-4 sm:grid-cols-[1fr_16rem]">
        <div className="grid gap-2">
          <Label htmlFor="rfq-title">Title</Label>
          <Input id="rfq-title" name="title" defaultValue={initial?.title ?? props.options.requisition.title} required maxLength={200} disabled={pending} />
          <FieldError state={state} name="title" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="rfq-due">Quotations due ({props.timezone})</Label>
          <Input id="rfq-due" name="responseDueAt" type="datetime-local" defaultValue={initial?.responseDueAt ?? ''} required disabled={pending} />
          <FieldError state={state} name="responseDueAt" />
        </div>
      </div>

      <fieldset className="grid gap-3">
        <legend className="mb-1 font-medium">Lines from {props.options.requisition.number}</legend>
        {props.options.lines.map((l) => {
          const choice = lines[l.id];
          const blocked = !available(l) && !initial?.lines[l.id];
          return (
            <div key={l.id} className="grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_10rem] sm:items-center">
              <div className="flex items-start gap-2">
                <input
                  type="checkbox"
                  id={`line-${l.lineNo}-selected`}
                  className="mt-1 size-4"
                  checked={choice?.selected ?? false}
                  disabled={pending || blocked}
                  onChange={(e) => setLine(l.id, { selected: e.target.checked })}
                />
                <Label htmlFor={`line-${l.lineNo}-selected`} className="grid gap-0.5 font-normal">
                  <span>
                    Line {l.lineNo}: {l.description}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {l.remainingQty} of {l.quantity} {l.uom} left to order
                    {l.onRfq ? ` · already on ${l.onRfq}` : ''}
                  </span>
                </Label>
              </div>
              <div className="grid gap-1">
                <Label htmlFor={`line-${l.lineNo}-quantity`}>Quantity ({l.uom})</Label>
                <Input
                  id={`line-${l.lineNo}-quantity`}
                  inputMode="decimal"
                  value={choice?.quantity ?? ''}
                  onChange={(e) => setLine(l.id, { quantity: e.target.value })}
                  disabled={pending || !choice?.selected}
                />
              </div>
            </div>
          );
        })}
        {errorsUnder(state, 'lines').length > 0 ? (
          <ul className="list-disc pl-5 text-sm text-destructive">
            {errorsUnder(state, 'lines').map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        ) : null}
      </fieldset>

      <fieldset className="grid gap-2">
        <legend className="mb-1 font-medium">Invite suppliers</legend>
        {props.options.suppliers.length === 0 ? <p className="text-sm text-muted-foreground">There are no active suppliers yet.</p> : null}
        {props.options.suppliers.map((s) => (
          <div key={s.id} className="flex items-center gap-2">
            <input
              type="checkbox"
              id={`supplier-${s.code}`}
              className="size-4"
              checked={suppliers.has(s.id)}
              disabled={pending}
              onChange={(e) => toggleSupplier(s.id, e.target.checked)}
            />
            <Label htmlFor={`supplier-${s.code}`} className="font-normal">
              {s.legalName} <span className="font-mono text-muted-foreground">{s.code}</span>
            </Label>
          </div>
        ))}
        <p className="text-sm text-muted-foreground">Only active suppliers are listed. You can save a draft without suppliers, but not issue it.</p>
        <FieldError state={state} name="supplierIds" />
      </fieldset>

      <FormMessage state={state} />
      <div>
        <Button type="submit" disabled={pending}>
          {editing ? 'Save changes' : 'Create draft RFQ'}
        </Button>
      </div>
    </ActionForm>
  );
}
