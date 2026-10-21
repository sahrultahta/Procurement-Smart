import type { Metadata } from 'next';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { SetPasswordForm } from './set-password-form';

export const metadata: Metadata = { title: 'Set your password' };

export default async function SetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  const { token } = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <h1 className="text-xl leading-none font-semibold">Set your password</h1>
          <CardDescription>This link works once and expires 24 hours after it was issued.</CardDescription>
        </CardHeader>
        <CardContent>
          <SetPasswordForm token={typeof token === 'string' ? token : null} />
        </CardContent>
      </Card>
    </main>
  );
}
