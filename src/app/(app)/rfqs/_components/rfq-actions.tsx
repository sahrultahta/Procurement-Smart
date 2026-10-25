'use client';

import { useActionState } from 'react';
import { FieldError, FormMessage } from '@/components/form-message';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ActionForm } from '@/components/action-form';
import { IDLE } from '@/lib/action-state';
import { cancelRfqAction, closeRfqAction, issueRfqAction } from '../actions';

/* Issue (RFQ-T03), close (RFQ-T04), and cancel (RFQ-T06). */

type Props = { rfqId: string; version: number };

export function IssueRfqForm({ rfqId, version }: Props) {
  const [state, formAction, pending] = useActionState(issueRfqAction, IDLE);
  return (
    <ActionForm action={formAction} className="grid gap-3">
      <input type="hidden" name="rfqId" value={rfqId} />
      <input type="hidden" name="expectedVersion" value={version} />
      <p className="text-sm text-muted-foreground">Issuing fixes the lines and the invited suppliers. ProcureFlow sends nothing to suppliers.</p>
      <FormMessage state={state} />
      <div>
        <Button type="submit" disabled={pending}>
          Issue RFQ
        </Button>
      </div>
    </ActionForm>
  );
}

export function CloseRfqForm({ rfqId, version }: Props) {
  const [state, formAction, pending] = useActionState(closeRfqAction, IDLE);
  return (
    <ActionForm action={formAction} className="grid gap-3">
      <input type="hidden" name="rfqId" value={rfqId} />
      <input type="hidden" name="expectedVersion" value={version} />
      <p className="text-sm text-muted-foreground">Close the RFQ when every invited supplier has answered or the due time has passed.</p>
      <FormMessage state={state} />
      <div>
        <Button type="submit" variant="outline" disabled={pending}>
          Close RFQ
        </Button>
      </div>
    </ActionForm>
  );
}

export function CancelRfqForm({ rfqId, version }: Props) {
  const [state, formAction, pending] = useActionState(cancelRfqAction, IDLE);
  return (
    <ActionForm action={formAction} className="grid gap-3" noValidate>
      <input type="hidden" name="rfqId" value={rfqId} />
      <input type="hidden" name="expectedVersion" value={version} />
      <div className="grid gap-2">
        <Label htmlFor="rfq-cancel-reason">Reason for cancelling</Label>
        <Textarea
          id="rfq-cancel-reason"
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
        <Button type="submit" variant="destructive" disabled={pending}>
          Cancel RFQ
        </Button>
      </div>
    </ActionForm>
  );
}
