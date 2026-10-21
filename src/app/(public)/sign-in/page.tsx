import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { getRequestContext } from '@/server/request-context';
import { SignInForm } from './sign-in-form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { actor } = await getRequestContext();
  if (actor) redirect('/');
  const { next } = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <h1 className="text-xl leading-none font-semibold">Sign in to ProcureFlow</h1>
          <CardDescription>Use the account your administrator created for you.</CardDescription>
        </CardHeader>
        <CardContent>
          <SignInForm next={typeof next === 'string' ? next : null} />
        </CardContent>
      </Card>
    </main>
  );
}
