'use client';

import { useActionState } from 'react';
import { FieldError, FormMessage } from '@/components/form-message';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { IDLE, type ActionState } from '@/lib/action-state';
import {
  blockSupplierAction,
  deactivateSupplierAction,
  reactivateSupplierAction,
  reviewSupplierAction,
  unblockSupplierAction,
} from '../actions';

type Target = { supplierId: string; version: number };

function Hidden({ supplierId, version }: Target) {
  return (
    <>
      <input type="hidden" name="supplierId" value={supplierId} />
      <input type="hidden" name="expectedVersion" value={version} />
    </>
  );
}

/** SUP-T04 / SUP-T05. The server refuses makers (SOD-03) whatever this form shows. */
export function ReviewForm(props: Target & { callerIsMaker: boolean }) {
  const [state, formAction, pending] = useActionState(reviewSupplierAction, IDLE);
  if (props.callerIsMaker) {
    return (
      <p role="note" className="rounded-md border p-3 text-sm">
        You registered this supplier or last changed its legal name or tax ID, so another reviewer must decide (maker-checker).
      </p>
    );
  }
  return (
    <form action={formAction} className="grid gap-3" noValidate>
      <Hidden {...props} />
      <div className="grid gap-2">
        <Label htmlFor="review-note">Review note (required to reject)</Label>
        <Textarea id="review-note" name="note" maxLength={2000} rows={2} disabled={pending} />
        <FieldError state={state} name="note" />
      </div>
      <FormMessage state={state} />
      <div className="flex gap-3">
        <Button type="submit" name="decision" value="approve" disabled={pending}>
          Approve
        </Button>
        <Button type="submit" name="decision" value="reject" variant="outline" disabled={pending}>
          Reject
        </Button>
      </div>
    </form>
  );
}

function ReasonForm(props: {
  target: Target;
  action: (state: ActionState, form: FormData) => Promise<ActionState>;
  id: string;
  label: string;
  button: string;
  destructive?: boolean;
}) {
  const [state, formAction, pending] = useActionState(props.action, IDLE);
  return (
    <form action={formAction} className="grid gap-3" noValidate>
      <Hidden {...props.target} />
      <div className="grid gap-2">
        <Label htmlFor={props.id}>{props.label}</Label>
        <Textarea id={props.id} name="reason" required maxLength={500} rows={2} disabled={pending} />
        <FieldError state={state} name="reason" />
      </div>
      <FormMessage state={state} />
      <div>
        <Button type="submit" variant={props.destructive ? 'destructive' : 'outline'} disabled={pending}>
          {props.button}
        </Button>
      </div>
    </form>
  );
}

export function BlockForm(target: Target) {
  return <ReasonForm target={target} action={blockSupplierAction} id="block-reason" label="Reason for blocking" button="Block supplier" destructive />;
}

export function UnblockForm(target: Target) {
  return <ReasonForm target={target} action={unblockSupplierAction} id="unblock-reason" label="Reason for unblocking" button="Unblock supplier" />;
}

export function DeactivateForm(target: Target) {
  return (
    <ReasonForm target={target} action={deactivateSupplierAction} id="deactivate-reason" label="Reason for deactivation" button="Deactivate supplier" />
  );
}

export function ReactivateForm(target: Target) {
  const [state, formAction, pending] = useActionState(reactivateSupplierAction, IDLE);
  return (
    <form action={formAction} className="grid gap-3">
      <Hidden {...target} />
      <FormMessage state={state} />
      <div>
        <Button type="submit" variant="outline" disabled={pending}>
          Reactivate supplier
        </Button>
      </div>
    </form>
  );
}
