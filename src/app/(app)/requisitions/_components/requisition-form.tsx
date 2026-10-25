'use client';

import { useActionState, useMemo, useState } from 'react';
import { FieldError, FormMessage } from '@/components/form-message';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ActionForm } from '@/components/action-form';
import { IDLE, type ActionState } from '@/lib/action-state';
import { formatMoney } from '@/lib/format';
import { MONEY_INPUT_PATTERN, QUANTITY_INPUT_PATTERN } from '@/shared/decimal/decimal';
import { priceDocument } from '@/shared/decimal/pricing';
import { createRequisitionAction, updateRequisitionAction } from '../actions';

export type FormLine = { description: string; quantity: string; uom: string; estimatedUnitPrice: string };
export type RequisitionFormValues = { title: string; justification: string | null; neededBy: string; lines: FormLine[] };

const EMPTY_LINE: FormLine = { description: '', quantity: '1', uom: 'pcs', estimatedUnitPrice: '0' };

function lineErrors(state: ActionState, index: number): string[] {
  if (state.status !== 'error') return [];
  return Object.entries(state.fieldErrors ?? {})
    .filter(([key]) => key.startsWith(`lines.${index}.`))
    .flatMap(([, messages]) => messages);
}

/**
 * A preview only (ADR 0007 allows it): the same pricing function the server runs, applied
 * to what is typed so far. The server recomputes everything and ignores this.
 */
function preview(lines: FormLine[], scale: number): { lines: (string | null)[]; total: string | null } {
  const valid = lines.map((l) => QUANTITY_INPUT_PATTERN.test(l.quantity) && MONEY_INPUT_PATTERN.test(l.estimatedUnitPrice));
  try {
    const priced = priceDocument(
      lines.map((l, i) => (valid[i] ? { quantity: l.quantity, unitPrice: l.estimatedUnitPrice } : { quantity: '0', unitPrice: '0' })),
      scale,
    );
    return { lines: priced.lines.map((p, i) => (valid[i] ? p.lineTotal : null)), total: valid.every(Boolean) ? priced.total : null };
  } catch {
    return { lines: lines.map(() => null), total: null };
  }
}

export function RequisitionForm(props: {
  currency: { code: string; scale: number };
  requisition?: { id: string; version: number; values: RequisitionFormValues };
}) {
  const editing = props.requisition !== undefined;
  const [state, formAction, pending] = useActionState(editing ? updateRequisitionAction : createRequisitionAction, IDLE);
  const initial = props.requisition?.values;
  const [lines, setLines] = useState<FormLine[]>(initial?.lines ?? [{ ...EMPTY_LINE }]);
  // One key per form: a double submit returns the first requisition instead of a second one.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const totals = useMemo(() => preview(lines, props.currency.scale), [lines, props.currency.scale]);
  const update = (index: number, change: Partial<FormLine>) => setLines((all) => all.map((l, i) => (i === index ? { ...l, ...change } : l)));

  return (
    <ActionForm action={formAction} className="grid gap-5" noValidate>
      <input type="hidden" name="lines" value={JSON.stringify(lines)} />
      {props.requisition ? (
        <>
          <input type="hidden" name="requisitionId" value={props.requisition.id} />
          <input type="hidden" name="expectedVersion" value={props.requisition.version} />
        </>
      ) : (
        <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      )}
      <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
        <div className="grid gap-2">
          <Label htmlFor="requisition-title">Title</Label>
          <Input id="requisition-title" name="title" defaultValue={initial?.title ?? ''} required maxLength={200} disabled={pending} />
          <FieldError state={state} name="title" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="requisition-needed-by">Needed by</Label>
          <Input id="requisition-needed-by" name="neededBy" type="date" defaultValue={initial?.neededBy ?? ''} required disabled={pending} />
          <FieldError state={state} name="neededBy" />
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="requisition-justification">Justification (optional)</Label>
        <Textarea id="requisition-justification" name="justification" defaultValue={initial?.justification ?? ''} maxLength={2000} rows={3} disabled={pending} />
        <FieldError state={state} name="justification" />
      </div>

      <fieldset className="grid gap-3">
        <legend className="mb-1 font-medium">Lines</legend>
        {lines.map((line, i) => (
          <div key={i} className="grid gap-2 rounded-md border p-3" role="group" aria-label={`Line ${i + 1}`}>
            <div className="grid gap-2 sm:grid-cols-[1fr_7rem_6rem_9rem]">
              <div className="grid gap-1">
                <Label htmlFor={`line-${i}-description`}>Item</Label>
                <Input id={`line-${i}-description`} value={line.description} onChange={(e) => update(i, { description: e.target.value })} maxLength={500} disabled={pending} />
              </div>
              <div className="grid gap-1">
                <Label htmlFor={`line-${i}-quantity`}>Quantity</Label>
                <Input id={`line-${i}-quantity`} inputMode="decimal" value={line.quantity} onChange={(e) => update(i, { quantity: e.target.value })} disabled={pending} />
              </div>
              <div className="grid gap-1">
                <Label htmlFor={`line-${i}-uom`}>Unit</Label>
                <Input id={`line-${i}-uom`} value={line.uom} onChange={(e) => update(i, { uom: e.target.value })} maxLength={16} disabled={pending} />
              </div>
              <div className="grid gap-1">
                <Label htmlFor={`line-${i}-price`}>Unit price ({props.currency.code})</Label>
                <Input id={`line-${i}-price`} inputMode="decimal" value={line.estimatedUnitPrice} onChange={(e) => update(i, { estimatedUnitPrice: e.target.value })} disabled={pending} />
              </div>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                Line total: {totals.lines[i] ? formatMoney(totals.lines[i] ?? '0', props.currency.code, props.currency.scale) : '—'}
              </span>
              <Button type="button" variant="ghost" size="sm" onClick={() => setLines((all) => all.filter((_, k) => k !== i))} disabled={pending || lines.length === 1}>
                Remove line
              </Button>
            </div>
            {lineErrors(state, i).length > 0 ? (
              <ul className="list-disc pl-5 text-sm text-destructive">
                {lineErrors(state, i).map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
        <div>
          <Button type="button" variant="outline" onClick={() => setLines((all) => [...all, { ...EMPTY_LINE }])} disabled={pending || lines.length >= 200}>
            Add line
          </Button>
        </div>
        <FieldError state={state} name="lines" />
      </fieldset>

      <p className="text-sm" aria-live="polite">
        Estimated total: <strong>{totals.total ? formatMoney(totals.total, props.currency.code, props.currency.scale) : '—'}</strong>{' '}
        <span className="text-muted-foreground">(the server calculates the final figure)</span>
      </p>
      <FormMessage state={state} />
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : editing ? 'Save changes' : 'Create draft'}
        </Button>
      </div>
    </ActionForm>
  );
}
