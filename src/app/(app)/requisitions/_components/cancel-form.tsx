'use client';

import { useActionState } from 'react';
import { FieldError, FormMessage } from '@/components/form-message';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { IDLE } from '@/lib/action-state';
import { cancelRequisitionAction } from '../actions';

export function CancelRequisitionForm({ requisitionId, version }: { requisitionId: string; version: number }) {
  const [state, formAction, pending] = useActionState(cancelRequisitionAction, IDLE);
  return (
    <form action={formAction} className="grid gap-3" noValidate>
      <input type="hidden" name="requisitionId" value={requisitionId} />
      <input type="hidden" name="expectedVersion" value={version} />
      <div className="grid gap-2">
        <Label htmlFor="cancel-reason">Reason (optional)</Label>
        <Textarea id="cancel-reason" name="reason" maxLength={500} rows={2} disabled={pending} />
        <FieldError state={state} name="reason" />
      </div>
      <FormMessage state={state} />
      <div>
        <Button type="submit" variant="destructive" disabled={pending}>
          Cancel requisition
        </Button>
      </div>
    </form>
  );
}
