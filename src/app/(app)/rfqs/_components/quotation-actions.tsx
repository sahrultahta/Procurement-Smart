'use client';

import { useActionState, useState } from 'react';
import { FieldError, FormMessage } from '@/components/form-message';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ActionForm } from '@/components/action-form';
import { IDLE } from '@/lib/action-state';
import { awardQuotationAction, submitQuotationAction, withdrawQuotationAction } from '../actions';

/* Submit (QUO-T03), discard or withdraw (QUO-T04), and the award (RFQ-T05). */

type QuotationProps = { quotationId: string; version: number; supplierName: string };

export function SubmitQuotationForm({ quotationId, version, supplierName }: QuotationProps) {
  const [state, formAction, pending] = useActionState(submitQuotationAction, IDLE);
  return (
    <ActionForm action={formAction} className="grid gap-2">
      <input type="hidden" name="quotationId" value={quotationId} />
      <input type="hidden" name="expectedVersion" value={version} />
      <FormMessage state={state} />
      <div>
        <Button type="submit" size="sm" disabled={pending} aria-label={`Submit the quotation from ${supplierName}`}>
          Submit
        </Button>
      </div>
    </ActionForm>
  );
}

export function WithdrawQuotationForm({ quotationId, version, supplierName, mode }: QuotationProps & { mode: 'discard' | 'withdraw' }) {
  const [state, formAction, pending] = useActionState(withdrawQuotationAction, IDLE);
  const id = `withdraw-reason-${quotationId}`;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer underline-offset-4 hover:underline">{mode === 'discard' ? 'Discard draft…' : 'Withdraw…'}</summary>
      <ActionForm action={formAction} className="mt-2 grid gap-2" noValidate>
        <input type="hidden" name="quotationId" value={quotationId} />
        <input type="hidden" name="expectedVersion" value={version} />
        <input type="hidden" name="mode" value={mode} />
        <div className="grid gap-2">
          <Label htmlFor={id}>{mode === 'discard' ? `Why discard the draft from ${supplierName}?` : `Why withdraw the quotation from ${supplierName}?`}</Label>
          <Textarea
            id={id}
            name="reason"
            maxLength={500}
            rows={2}
            required
            disabled={pending}
            aria-describedby={state.status === 'error' && state.fieldErrors?.reason ? 'reason-error' : undefined}
          />
          <FieldError state={state} name="reason" />
        </div>
        <FormMessage state={state} />
        <div>
          <Button type="submit" size="sm" variant="destructive" disabled={pending}>
            {mode === 'discard' ? 'Discard draft' : 'Withdraw quotation'}
          </Button>
        </div>
      </ActionForm>
    </details>
  );
}

type AwardOption = { id: string; label: string; lowest: boolean };

/**
 * The buyer picks one valid quotation. The note under the choices says whether a justification
 * will be needed; the server decides, with the same rule.
 */
export function AwardForm({ rfqId, version, options, belowMinQuotes, minQuotes }: { rfqId: string; version: number; options: AwardOption[]; belowMinQuotes: boolean; minQuotes: number }) {
  const [state, formAction, pending] = useActionState(awardQuotationAction, IDLE);
  const [chosen, setChosen] = useState<string>(() => options.find((o) => o.lowest)?.id ?? options[0]?.id ?? '');
  const notLowest = options.find((o) => o.id === chosen)?.lowest === false;
  const needs = [
    ...(belowMinQuotes ? [`fewer than ${minQuotes} valid quotations were received`] : []),
    ...(notLowest ? ['the chosen quotation is not the lowest valid total'] : []),
  ];
  return (
    <ActionForm action={formAction} className="grid gap-4" noValidate>
      <input type="hidden" name="rfqId" value={rfqId} />
      <input type="hidden" name="expectedVersion" value={version} />
      <fieldset className="grid gap-2" disabled={pending}>
        <legend className="mb-1 text-sm font-medium">Award to</legend>
        {options.map((o) => (
          <div key={o.id} className="flex items-center gap-2">
            <input
              type="radio"
              id={`award-${o.id}`}
              name="quotationId"
              value={o.id}
              defaultChecked={o.id === chosen}
              onChange={() => setChosen(o.id)}
              className="size-4"
            />
            <Label htmlFor={`award-${o.id}`} className="font-normal">
              {o.label}
              {o.lowest ? ' (lowest)' : ''}
            </Label>
          </div>
        ))}
      </fieldset>
      <div className="grid gap-2">
        <Label htmlFor="award-justification">Justification{needs.length > 0 ? ' (required)' : ' (optional)'}</Label>
        <Textarea
          id="award-justification"
          name="justification"
          maxLength={2000}
          rows={3}
          disabled={pending}
          aria-describedby="award-justification-note"
        />
        <p id="award-justification-note" className="text-sm text-muted-foreground">
          {needs.length > 0 ? `A justification is required: ${needs.join(', and ')}.` : 'No justification is required for this choice.'} It is
          kept in the audit trail.
        </p>
        <FieldError state={state} name="justification" />
      </div>
      <FormMessage state={state} />
      <div>
        <Button type="submit" disabled={pending || options.length === 0}>
          Award RFQ
        </Button>
      </div>
    </ActionForm>
  );
}
