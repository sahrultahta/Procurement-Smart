import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatTimestamp } from '@/lib/format';
import { RFQ_STATUSES, listRfqs } from '@/modules/sourcing';
import { getOrganization } from '@/server/organization-profile';
import { getRequestContext } from '@/server/request-context';
import { runQuery } from '@/shared/application/runner';
import { RfqStatusBadge, rfqStatusLabel } from './_components/rfq-status';

export const metadata: Metadata = { title: 'RFQs' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function RfqsPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const q = typeof params.q === 'string' ? params.q.slice(0, 100) : '';
  const status = RFQ_STATUSES.find((s) => s === params.status);
  const cursor = typeof params.cursor === 'string' ? params.cursor : undefined;
  const result = await runQuery(await getRequestContext(), listRfqs, {
    ...(q.trim() ? { q } : {}),
    ...(status ? { status } : {}),
    ...(cursor ? { cursor } : {}),
  });

  if (!result.ok) {
    return (
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold">{result.error.code === 'FORBIDDEN' ? 'Access denied' : 'RFQs'}</h1>
        <p className="text-muted-foreground">{result.error.code === 'FORBIDDEN' ? 'You have no role that can see requests for quotation.' : result.error.message}</p>
      </div>
    );
  }
  const { timezone } = await getOrganization();
  const next = result.data.nextCursor
    ? `/rfqs?${new URLSearchParams({ ...(q ? { q } : {}), ...(status ? { status } : {}), cursor: result.data.nextCursor })}`
    : null;

  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">RFQs</h1>
        <p className="text-sm text-muted-foreground">Requests for quotation. Procurement starts one from an approved requisition.</p>
      </div>
      <form role="search" method="get" className="grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
        <div className="grid gap-2">
          <Label htmlFor="rfq-search">Search</Label>
          <Input id="rfq-search" name="q" defaultValue={q} maxLength={100} placeholder="Number or title" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="rfq-status-filter">Status</Label>
          <NativeSelect id="rfq-status-filter" name="status" defaultValue={status ?? ''}>
            <option value="">Any status</option>
            {RFQ_STATUSES.map((s) => (
              <option key={s} value={s}>
                {rfqStatusLabel(s)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>
      <Table aria-label="RFQs">
        <TableHeader>
          <TableRow>
            <TableHead>Number</TableHead>
            <TableHead>Title</TableHead>
            <TableHead>Requisition</TableHead>
            <TableHead className="text-right">Lines</TableHead>
            <TableHead className="text-right">Suppliers</TableHead>
            <TableHead>Quotations due</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {result.data.items.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7} className="text-muted-foreground">
                No RFQs to show.
              </TableCell>
            </TableRow>
          ) : (
            result.data.items.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono">
                  <Link href={`/rfqs/${r.id}`} className="underline-offset-4 hover:underline">
                    {r.number}
                  </Link>
                </TableCell>
                <TableCell className="whitespace-normal">{r.title}</TableCell>
                <TableCell className="font-mono">
                  <Link href={`/requisitions/${r.requisitionId}`} className="underline-offset-4 hover:underline">
                    {r.requisitionNumber}
                  </Link>
                </TableCell>
                <TableCell className="text-right">{r.lineCount}</TableCell>
                <TableCell className="text-right">{r.supplierCount}</TableCell>
                <TableCell>{formatTimestamp(r.responseDueAt, timezone)}</TableCell>
                <TableCell>
                  <RfqStatusBadge status={r.status} />
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
