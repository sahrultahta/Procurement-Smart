'use client';

import Link from 'next/link';
import { useState, useTransition, type FormEvent } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authClient } from '@/lib/auth-client';

// Mirrors MIN_PASSWORD_LENGTH in src/server/auth.ts; the server enforces it regardless.
const MIN_LENGTH = 12;
const LINK_INVALID = 'This link is invalid, already used, or expired. Ask your administrator for a new one.';

export function SetPasswordForm({ token }: { token: string | null }) {
  const [error, setError] = useState<string | null>(token ? null : LINK_INVALID);
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();

  if (done) {
    return (
      <div className="grid gap-4">
        <Alert>
          <AlertDescription>Your password is set. You can sign in now.</AlertDescription>
        </Alert>
        <Button asChild>
          <Link href="/sign-in">Go to sign in</Link>
        </Button>
      </div>
    );
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') ?? '');
    const confirm = String(form.get('confirm') ?? '');
    if (password.length < MIN_LENGTH) return setError(`Use at least ${MIN_LENGTH} characters.`);
    if (password !== confirm) return setError('The two passwords do not match.');
    setError(null);
    startTransition(async () => {
      const { error: failure } = await authClient.resetPassword({ newPassword: password, token });
      if (failure) setError(failure.status === 429 ? 'Too many attempts. Wait a minute, then try again.' : LINK_INVALID);
      else setDone(true);
    });
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      <div className="grid gap-2">
        <Label htmlFor="password">New password</Label>
        <Input id="password" name="password" type="password" autoComplete="new-password" minLength={MIN_LENGTH} required disabled={!token || pending} aria-describedby="password-hint" />
        <p id="password-hint" className="text-sm text-muted-foreground">
          At least {MIN_LENGTH} characters. A short sentence works well.
        </p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="confirm">Repeat the password</Label>
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required disabled={!token || pending} />
      </div>
      <div aria-live="polite">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </div>
      <Button type="submit" disabled={!token || pending}>
        {pending ? 'Saving…' : 'Set password'}
      </Button>
    </form>
  );
}
