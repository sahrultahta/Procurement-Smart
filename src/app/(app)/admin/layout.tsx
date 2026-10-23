import Link from 'next/link';
import type { ReactNode } from 'react';
import { getRequestContext } from '@/server/request-context';

/**
 * Administration area. Hiding it from non-admins is a usability measure only: every
 * query and Server Action below checks permissions itself through the runner.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const { actor } = await getRequestContext();
  const canManageUsers = actor?.permissions.has('admin.users') ?? false;
  const canManageSettings = actor?.permissions.has('admin.settings') ?? false;
  const canManagePolicies = actor?.permissions.has('admin.approvalPolicies') ?? false;

  if (!canManageUsers && !canManageSettings && !canManagePolicies) {
    return (
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <p className="text-muted-foreground">Administration is available to administrators only.</p>
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      <nav aria-label="Administration" className="flex gap-4 border-b pb-2 text-sm">
        {canManageUsers ? (
          <Link href="/admin/users" className="text-muted-foreground hover:text-foreground">
            Users
          </Link>
        ) : null}
        {canManageSettings ? (
          <Link href="/admin/departments" className="text-muted-foreground hover:text-foreground">
            Departments
          </Link>
        ) : null}
        {canManageSettings ? (
          <Link href="/admin/settings" className="text-muted-foreground hover:text-foreground">
            Settings
          </Link>
        ) : null}
        {canManagePolicies ? (
          <Link href="/admin/approval-policy" className="text-muted-foreground hover:text-foreground">
            Approval policy
          </Link>
        ) : null}
      </nav>
      {children}
    </div>
  );
}
