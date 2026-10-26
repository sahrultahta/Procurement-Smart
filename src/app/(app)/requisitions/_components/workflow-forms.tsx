'use client';

import { useActionState } from 'react';
import { FieldError, FormMessage } from '@/components/form-message';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ActionForm } from '@/components/action-form';
import { IDLE } from '@/lib/action-state';
import { closeRequisitionAction, decideApprovalAction, submitRequisitionAction } from '../actions';

/* Submit (PR-T03), close (PR-T10), and an approval decision (AP-T02 to T04; requisitions and purchase orders). */

export function SubmitRequisitionForm({ requisitionId, version }: { requisitionId: string; version: number }) {
  const [state, formAction, pending] = useActionState(submitRequisitionAction, IDLE);
  return (
    <ActionForm action={formAction} className="grid gap-3">
      <input type="hidden" name="requisitionId" value={requisitionId} />
      <input type="hidden" name="expectedVersion" value={version} />
      <p className="text-sm text-muted-foreground">
        The approval route is chosen from the active policy by your department and the estimated total, and stays fixed for this
        round. You cannot edit the lines while it is being approved.
      </p>
      <FormMessage state={state} />
      <div>
        <Button type="submit" disabled={pending}>
          Submit for approval
        </Button>
      </div>
    </ActionForm>
  );
}

export function CloseRequisitionForm({ requisitionId, version }: { requisitionId: string; version: number }) {
  const [state, formAction, pending] = useActionState(closeRequisitionAction, IDLE);
  return (
    <ActionForm action={formAction} className="grid gap-3" noValidate>
      <input type="hidden" name="requisitionId" value={requisitionId} />
      <input type="hidden" name="expectedVersion" value={version} />
      <div className="grid gap-2">
        <Label htmlFor="close-reason">Reason for closing</Label>
        <Textarea
          id="close-reason"
          name="reason"
          maxLength={500}
          rows={2}
          disabled={pending}
          required
          aria-describedby={state.status === 'error' && state.fieldErrors?.reason ? 'reason-error' : undefined}
        />
        <FieldError state={state} name="reason" />
      </div>
      <FormMessage state={state} />
      <div>
        <Button type="submit" variant="outline" disabled={pending}>
          Close requisition
        </Button>
      </div>
    </ActionForm>
  );
}

const DECISIONS = [
  { value: 'approve', label: 'Approve' },
  { value: 'return', label: 'Return for changes' },
  { value: 'reject', label: 'Reject' },
] as const;

export function DecisionForm({
  approvalRequestId,
  stepNo,
  version,
  stepLabel,
}: {
  approvalRequestId: string;
  stepNo: number;
  version: number;
  stepLabel: string;
}) {
  const [state, formAction, pending] = useActionState(decideApprovalAction, IDLE);
  return (
    <ActionForm action={formAction} className="grid gap-4" noValidate>
      <input type="hidden" name="approvalRequestId" value={approvalRequestId} />
      <input type="hidden" name="stepNo" value={stepNo} />
      <input type="hidden" name="expectedVersion" value={version} />
      <fieldset className="grid gap-2" disabled={pending}>
        <legend className="mb-1 text-sm font-medium">
          Your decision on step {stepNo} ({stepLabel})
        </legend>
        {DECISIONS.map((d) => (
          <div key={d.value} className="flex items-center gap-2">
            <input type="radio" id={`decision-${d.value}`} name="decision" value={d.value} defaultChecked={d.value === 'approve'} className="size-4" />
            <Label htmlFor={`decision-${d.value}`} className="font-normal">
              {d.label}
            </Label>
          </div>
        ))}
      </fieldset>
      <div className="grid gap-2">
        <Label htmlFor="decision-comment">Comment (required to reject or return)</Label>
        <Textarea
          id="decision-comment"
          name="comment"
          maxLength={2000}
          rows={3}
          disabled={pending}
          aria-describedby={state.status === 'error' && state.fieldErrors?.comment ? 'comment-error' : undefined}
        />
        <FieldError state={state} name="comment" />
      </div>
      <FormMessage state={state} />
      <div>
        <Button type="submit" disabled={pending}>
          Record decision
        </Button>
      </div>
    </ActionForm>
  );
}
