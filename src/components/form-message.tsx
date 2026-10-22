'use client';

import { Alert, AlertDescription } from '@/components/ui/alert';
import type { ActionState } from '@/lib/action-state';

/** Result of the last submit, announced to screen readers. */
export function FormMessage({ state }: { state: ActionState }) {
  return (
    <div aria-live="polite" className="empty:hidden">
      {state.status === 'error' ? (
        <Alert variant="destructive">
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      ) : state.status === 'ok' ? (
        <Alert>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

export function FieldError({ state, name }: { state: ActionState; name: string }) {
  const messages = state.status === 'error' ? state.fieldErrors?.[name] : undefined;
  if (!messages?.length) return null;
  return (
    <p id={`${name}-error`} className="text-sm text-destructive">
      {messages.join(' ')}
    </p>
  );
}
