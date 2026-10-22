import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { listUsers } from '@/modules/identity';
import { getRequestContext } from '@/server/request-context';
import { runQuery } from '@/shared/application/runner';
import { ErrorPanel, UserStatusBadge } from '../_components/status-badge';

export const metadata: Metadata = { title: 'Users' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const FILTERS = [
  { label: 'All', status: undefined },
  { label: 'Active', status: 'active' },
  { label: 'Deactivated', status: 'deactivated' },
] as const;

export default async function UsersPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const status = params.status === 'active' || params.status === 'deactivated' ? params.status : undefined;
  const cursor = typeof params.cursor === 'string' ? params.cursor : undefined;
  const result = await runQuery(await getRequestContext(), listUsers, {
    ...(status ? { status } : {}),
    ...(cursor ? { cursor } : {}),
  });

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Users</h1>
        <Button asChild>
          <Link href="/admin/users/new">New user</Link>
        </Button>
      </div>
      <nav aria-label="Filter users" className="flex gap-3 text-sm">
        {FILTERS.map((f) => (
          <Link
            key={f.label}
            href={f.status ? `/admin/users?status=${f.status}` : '/admin/users'}
            aria-current={status === f.status ? 'page' : undefined}
            className="text-muted-foreground hover:text-foreground aria-[current=page]:font-medium aria-[current=page]:text-foreground"
          >
            {f.label}
          </Link>
        ))}
      </nav>
      {!result.ok ? (
        <ErrorPanel message={result.error.message} />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Department</TableHead>
                <TableHead>Roles</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.data.items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground">
                    No users match this filter.
                  </TableCell>
                </TableRow>
              ) : (
                result.data.items.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell>
                      <Link href={`/admin/users/${user.id}`} className="font-medium underline-offset-4 hover:underline">
                        {user.name}
                      </Link>
                    </TableCell>
                    <TableCell>{user.email}</TableCell>
                    <TableCell>{user.department?.code ?? '—'}</TableCell>
                    <TableCell className="whitespace-normal">
                      {user.roles.length === 0
                        ? '—'
                        : user.roles.map((r) => (r.departmentCode ? `${r.label} (${r.departmentCode})` : r.label)).join(', ')}
                    </TableCell>
                    <TableCell>
                      <UserStatusBadge status={user.status} passwordSet={user.passwordSet} />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          {result.data.nextCursor ? (
            <div>
              <Button asChild variant="outline">
                <Link href={`/admin/users?${new URLSearchParams({ ...(status ? { status } : {}), cursor: result.data.nextCursor })}`}>
                  Next page
                </Link>
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
