'use client';

import { useActionState } from 'react';
import { FieldError, FormMessage } from '@/components/form-message';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ActionForm } from '@/components/action-form';
import { IDLE } from '@/lib/action-state';
import { cancelRequisitionAction } from '../actions';

/** draft: PR-T07 (reason optional); withdraw: PR-T08; approved: PR-T09 (both need a reason). */
export type CancelMode = 'draft' | 'withdraw' | 'approved';

const TEXT: Record<CancelMode, { label: string; button: string }> = {
  draft: { label: 'Reason (optional)', button: 'Cancel requisition' },
  withdraw: { label: 'Reason for withdrawing', button: 'Withdraw requisition' },
  approved: { label: 'Reason for cancelling', button: 'Cancel requisition' },
};

export function CancelRequisitionForm({ requisitionId, version, mode }: { requisitionId: string; version: number; mode: CancelMode }) {
  const [state, formAction, pending] = useActionState(cancelRequisitionAction, IDLE);
  const text = TEXT[mode];
  return (
    <ActionForm action={formAction} className="grid gap-3" noValidate>
      <input type="hidden" name="requisitionId" value={requisitionId} />
      <input type="hidden" name="expectedVersion" value={version} />
      <input type="hidden" name="mode" value={mode} />
      <div className="grid gap-2">
        <Label htmlFor="cancel-reason">{text.label}</Label>
        <Textarea
          id="cancel-reason"
          name="reason"
          maxLength={500}
          rows={2}
          disabled={pending}
          required={mode !== 'draft'}
          aria-describedby={state.status === 'error' && state.fieldErrors?.reason ? 'reason-error' : undefined}
        />
        <FieldError state={state} name="reason" />
      </div>
      <FormMessage state={state} />
      <div>
        <Button type="submit" variant="destructive" disabled={pending}>
          {text.button}
        </Button>
      </div>
    </ActionForm>
  );
}
