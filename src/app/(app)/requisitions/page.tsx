import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDate, formatMoney } from '@/lib/format';
import { REQUISITION_STATUSES, listRequisitions } from '@/modules/requisitions';
import { getRequestContext } from '@/server/request-context';
import { runQuery } from '@/shared/application/runner';
import { RequisitionStatusBadge, requisitionStatusLabel } from './_components/requisition-status';

export const metadata: Metadata = { title: 'Requisitions' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function RequisitionsPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const q = typeof params.q === 'string' ? params.q.slice(0, 100) : '';
  const status = REQUISITION_STATUSES.find((s) => s === params.status);
  const cursor = typeof params.cursor === 'string' ? params.cursor : undefined;
  const request = await getRequestContext();
  const result = await runQuery(request, listRequisitions, {
    ...(q.trim() ? { q } : {}),
    ...(status ? { status } : {}),
    ...(cursor ? { cursor } : {}),
  });
  const canCreate = request.actor?.permissions.has('requisition.create') ?? false;

  if (!result.ok) {
    return (
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold">{result.error.code === 'FORBIDDEN' ? 'Access denied' : 'Requisitions'}</h1>
        <p className="text-muted-foreground">
          {result.error.code === 'FORBIDDEN' ? 'You have no role that can see purchase requisitions.' : result.error.message}
        </p>
      </div>
    );
  }
  const next = result.data.nextCursor
    ? `/requisitions?${new URLSearchParams({ ...(q ? { q } : {}), ...(status ? { status } : {}), cursor: result.data.nextCursor })}`
    : null;

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Requisitions</h1>
        {canCreate ? (
          <Button asChild>
            <Link href="/requisitions/new">New requisition</Link>
          </Button>
        ) : null}
      </div>
      <form role="search" method="get" className="grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
        <div className="grid gap-2">
          <Label htmlFor="requisition-search">Search</Label>
          <Input id="requisition-search" name="q" defaultValue={q} maxLength={100} placeholder="Number or title" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="requisition-status-filter">Status</Label>
          <NativeSelect id="requisition-status-filter" name="status" defaultValue={status ?? ''}>
            <option value="">Any status</option>
            {REQUISITION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {requisitionStatusLabel(s)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Number</TableHead>
            <TableHead>Title</TableHead>
            <TableHead>Requester</TableHead>
            <TableHead>Department</TableHead>
            <TableHead>Needed by</TableHead>
            <TableHead className="text-right">Estimated total</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {result.data.items.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7} className="text-muted-foreground">
                No requisitions to show.
              </TableCell>
            </TableRow>
          ) : (
            result.data.items.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono">
                  <Link href={`/requisitions/${r.id}`} className="underline-offset-4 hover:underline">
                    {r.number}
                  </Link>
                </TableCell>
                <TableCell className="whitespace-normal">{r.title}</TableCell>
                <TableCell>{r.requester}</TableCell>
                <TableCell>{r.departmentCode}</TableCell>
                <TableCell>{formatDate(r.neededBy)}</TableCell>
                <TableCell className="text-right">{formatMoney(r.estimatedTotal, r.currencyCode, r.currencyScale)}</TableCell>
                <TableCell>
                  <RequisitionStatusBadge status={r.status} />
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      {next ? (
        <div>
          <Button asChild variant="outline">
            <Link href={next}>Next page</Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
