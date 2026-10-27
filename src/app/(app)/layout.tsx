import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { PO_READ_PERMISSIONS } from '@/modules/purchasing';
import { REQUISITION_READ_PERMISSIONS } from '@/modules/requisitions';
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
            {REQUISITION_READ_PERMISSIONS.some((p) => actor.permissions.has(p)) ? (
              <Link href="/requisitions" className="text-muted-foreground hover:text-foreground">
                Requisitions
              </Link>
            ) : null}
            {actor.permissions.has('approval.decide') ? (
              <Link href="/approvals" className="text-muted-foreground hover:text-foreground">
                Approvals
              </Link>
            ) : null}
            {actor.permissions.has('rfq.read') ? (
              <Link href="/rfqs" className="text-muted-foreground hover:text-foreground">
                RFQs
              </Link>
            ) : null}
            {PO_READ_PERMISSIONS.some((p) => actor.permissions.has(p)) ? (
              <Link href="/purchase-orders" className="text-muted-foreground hover:text-foreground">
                Purchase orders
              </Link>
            ) : null}
            {actor.permissions.has('receipt.read') || actor.permissions.has('receipt.create') ? (
              <Link href="/goods-receipts" className="text-muted-foreground hover:text-foreground">
                Receiving
              </Link>
            ) : null}
            {actor.permissions.has('supplier.read') ? (
              <Link href="/suppliers" className="text-muted-foreground hover:text-foreground">
                Suppliers
              </Link>
            ) : null}
            {actor.permissions.has('admin.users') || actor.permissions.has('admin.settings') ? (
              <Link href="/admin" className="text-muted-foreground hover:text-foreground">
                Admin
              </Link>
            ) : null}
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
