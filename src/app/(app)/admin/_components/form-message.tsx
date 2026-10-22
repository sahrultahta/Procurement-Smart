'use client';

import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ActionState } from '../action-state';

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

/** A one-time setup link: shown once, never stored by the page. */
export function SetupLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid gap-2 rounded-md border border-dashed p-3" data-testid="setup-link">
      <p className="text-sm">
        One-time password setup link. It works once and expires in 24 hours. Send it to the user through a channel you trust; it
        will not be shown again.
      </p>
      <div className="flex gap-2">
        <Input readOnly value={url} aria-label="Setup link" onFocus={(e) => e.currentTarget.select()} />
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            void navigator.clipboard.writeText(url).then(() => setCopied(true));
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}
