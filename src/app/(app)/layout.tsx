import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { getRequestContext } from '@/server/request-context';
import { signOutAction } from './actions';

/**
 * Shell for every signed-in page. The session is validated here against the
 * database (proxy.ts only does an optimistic cookie check). Each Server Action
 * and query still re-checks on its own through the command runner.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const { actor } = await getRequestContext();
  if (!actor) redirect('/sign-in');

  return (
    <div className="min-h-screen bg-muted/40">
      <header className="border-b bg-background">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-4">
          <nav aria-label="Main" className="flex items-center gap-6 text-sm">
            <Link href="/" className="font-semibold">
              ProcureFlow
            </Link>
            <Link href="/account" className="text-muted-foreground hover:text-foreground">
              My account
            </Link>
          </nav>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-muted-foreground" data-testid="signed-in-as">
              {actor.name}
            </span>
            <form action={signOutAction}>
              <Button type="submit" variant="outline" size="sm">
                Sign out
              </Button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
    </div>
  );
}
