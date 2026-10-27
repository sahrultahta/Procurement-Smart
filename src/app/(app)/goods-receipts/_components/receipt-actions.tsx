'use client';

import { useActionState } from 'react';
import { FieldError, FormMessage } from '@/components/form-message';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ActionForm } from '@/components/action-form';
import { IDLE } from '@/lib/action-state';
import { cancelGoodsReceiptAction, postGoodsReceiptAction, reverseGoodsReceiptAction } from '../actions';

/* Post (GR-T02), cancel a draft (GR-T03), and reverse (GR-T04). */

type Props = { goodsReceiptId: string; version: number };

export function PostGoodsReceiptForm({ goodsReceiptId, version }: Props) {
  const [state, formAction, pending] = useActionState(postGoodsReceiptAction, IDLE);
  return (
    <ActionForm action={formAction} className="grid gap-3">
      <input type="hidden" name="goodsReceiptId" value={goodsReceiptId} />
      <input type="hidden" name="expectedVersion" value={version} />
      <p className="text-sm text-muted-foreground">
        Posting adds these quantities to the purchase order and updates its status. A posted receipt cannot be changed, only reversed.
      </p>
      <FormMessage state={state} />
      <div>
        <Button type="submit" disabled={pending}>
          Post receipt
        </Button>
      </div>
    </ActionForm>
  );
}

function ReasonForm({
  goodsReceiptId,
  version,
  action,
  id,
  label,
  button,
  required,
  destructive,
}: Props & {
  action: typeof cancelGoodsReceiptAction;
  id: string;
  label: string;
  button: string;
  required: boolean;
  destructive: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  return (
    <ActionForm action={formAction} className="grid gap-3" noValidate>
      <input type="hidden" name="goodsReceiptId" value={goodsReceiptId} />
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

export function CancelGoodsReceiptForm(props: Props) {
  return (
    <ReasonForm
      {...props}
      action={cancelGoodsReceiptAction}
      id="gr-cancel-reason"
      label="Reason for cancelling the draft (optional)"
      button="Cancel draft"
      required={false}
      destructive={false}
    />
  );
}

export function ReverseGoodsReceiptForm(props: Props) {
  return (
    <ReasonForm
      {...props}
      action={reverseGoodsReceiptAction}
      id="gr-reverse-reason"
      label="Reason for reversing"
      button="Reverse receipt"
      required
      destructive
    />
  );
}
