'use client';

import { useActionState } from 'react';
import { FieldError, FormMessage } from '@/components/form-message';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ActionForm } from '@/components/action-form';
import { IDLE } from '@/lib/action-state';
import { cancelPurchaseOrderAction, closePurchaseOrderAction, issuePurchaseOrderAction, submitPurchaseOrderAction } from '../actions';

/* Submit (PO-T03), issue (PO-T05), cancel (PO-T08 / T09), and close (PO-T07). */

type Props = { purchaseOrderId: string; version: number };

export function SubmitPurchaseOrderForm({ purchaseOrderId, version }: Props) {
  const [state, formAction, pending] = useActionState(submitPurchaseOrderAction, IDLE);
  return (
    <ActionForm action={formAction} className="grid gap-3">
      <input type="hidden" name="purchaseOrderId" value={purchaseOrderId} />
      <input type="hidden" name="expectedVersion" value={version} />
      <p className="text-sm text-muted-foreground">
        At or above the approval threshold, or with prices above the requisition estimate by more than the tolerance, the order goes to
        approval. Otherwise it is approved at once. Either way it can no longer be edited.
      </p>
      <FormMessage state={state} />
      <div>
        <Button type="submit" disabled={pending}>
          Submit purchase order
        </Button>
      </div>
    </ActionForm>
  );
}

export function IssuePurchaseOrderForm({ purchaseOrderId, version }: Props) {
  const [state, formAction, pending] = useActionState(issuePurchaseOrderAction, IDLE);
  return (
    <ActionForm action={formAction} className="grid gap-3">
      <input type="hidden" name="purchaseOrderId" value={purchaseOrderId} />
      <input type="hidden" name="expectedVersion" value={version} />
      <p className="text-sm text-muted-foreground">
        Issuing fixes the order and how much may be received per line (the over-receipt tolerance in the settings). ProcureFlow sends
        nothing: print the order and send it to the supplier.
      </p>
      <FormMessage state={state} />
      <div>
        <Button type="submit" disabled={pending}>
          Issue purchase order
        </Button>
      </div>
    </ActionForm>
  );
}

function ReasonForm({
  purchaseOrderId,
  version,
  action,
  id,
  label,
  button,
  required,
  destructive,
}: Props & {
  action: typeof cancelPurchaseOrderAction;
  id: string;
  label: string;
  button: string;
  required: boolean;
  destructive: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  return (
    <ActionForm action={formAction} className="grid gap-3" noValidate>
      <input type="hidden" name="purchaseOrderId" value={purchaseOrderId} />
      <input type="hidden" name="expectedVersion" value={version} />
      <div className="grid gap-2">
        <Label htmlFor={id}>{label}</Label>
        <Textarea
          id={id}
          name="reason"
          maxLength={500}
          rows={2}
          required={required}
          disabled={pending}
          aria-describedby={state.status === 'error' && state.fieldErrors?.reason ? 'reason-error' : undefined}
        />
        <FieldError state={state} name="reason" />
      </div>
      <FormMessage state={state} />
      <div>
        <Button type="submit" variant={destructive ? 'destructive' : 'outline'} disabled={pending}>
          {button}
        </Button>
      </div>
    </ActionForm>
  );
}

export function CancelPurchaseOrderForm(props: Props) {
  return (
    <ReasonForm
      {...props}
      action={cancelPurchaseOrderAction}
      id="po-cancel-reason"
      label="Reason for cancelling"
      button="Cancel purchase order"
      required
      destructive
    />
  );
}

export function ClosePurchaseOrderForm(props: Props & { reasonRequired: boolean }) {
  return (
    <ReasonForm
      {...props}
      action={closePurchaseOrderAction}
      id="po-close-reason"
      label={props.reasonRequired ? 'Reason for closing' : 'Reason for closing (optional: everything was received)'}
      button="Close purchase order"
      required={props.reasonRequired}
      destructive={false}
    />
  );
}
