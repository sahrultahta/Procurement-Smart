import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { SUPPLIER_STATUSES, listSuppliers, type SupplierStatus } from '@/modules/suppliers';
import { getRequestContext } from '@/server/request-context';
import { runQuery } from '@/shared/application/runner';
import { SupplierStatusBadge, supplierStatusLabel } from './_components/supplier-status';
import { countryName } from './country-options';

export const metadata: Metadata = { title: 'Suppliers' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function SuppliersPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const q = typeof params.q === 'string' ? params.q.slice(0, 100) : '';
  const status = SUPPLIER_STATUSES.find((s) => s === params.status);
  const cursor = typeof params.cursor === 'string' ? params.cursor : undefined;
  const request = await getRequestContext();
  const result = await runQuery(request, listSuppliers, {
    ...(q.trim() ? { q } : {}),
    ...(status ? { status } : {}),
    ...(cursor ? { cursor } : {}),
  });
  const canManage = request.actor?.permissions.has('supplier.manage') ?? false;

  if (!result.ok) {
    return (
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold">{result.error.code === 'FORBIDDEN' ? 'Access denied' : 'Suppliers'}</h1>
        <p className="text-muted-foreground">
          {result.error.code === 'FORBIDDEN' ? 'Suppliers are available to procurement, finance, and auditors.' : result.error.message}
        </p>
      </div>
    );
  }

  const next = result.data.nextCursor
    ? `/suppliers?${new URLSearchParams({ ...(q ? { q } : {}), ...(status ? { status } : {}), cursor: result.data.nextCursor })}`
    : null;

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Suppliers</h1>
        {canManage ? (
          <Button asChild>
            <Link href="/suppliers/new">Register supplier</Link>
          </Button>
        ) : null}
      </div>
      <form role="search" method="get" className="grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
        <div className="grid gap-2">
          <Label htmlFor="supplier-search">Search</Label>
          <Input id="supplier-search" name="q" defaultValue={q} maxLength={100} placeholder="Name, code, or tax ID" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="supplier-status">Status</Label>
          <NativeSelect id="supplier-status" name="status" defaultValue={status ?? ''}>
            <option value="">Any status</option>
            {SUPPLIER_STATUSES.map((s: SupplierStatus) => (
              <option key={s} value={s}>
                {supplierStatusLabel(s)}
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
            <TableHead>Code</TableHead>
            <TableHead>Legal name</TableHead>
            <TableHead>Tax ID</TableHead>
            <TableHead>Location</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {result.data.items.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="text-muted-foreground">
                No suppliers match.
              </TableCell>
            </TableRow>
          ) : (
            result.data.items.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-mono">{s.code}</TableCell>
                <TableCell>
                  <Link href={`/suppliers/${s.id}`} className="font-medium underline-offset-4 hover:underline">
                    {s.legalName}
                  </Link>
                </TableCell>
                <TableCell>{s.taxId ?? '—'}</TableCell>
                <TableCell>{[s.city, countryName(s.countryCode)].filter(Boolean).join(', ')}</TableCell>
                <TableCell>
                  <SupplierStatusBadge status={s.status} />
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
