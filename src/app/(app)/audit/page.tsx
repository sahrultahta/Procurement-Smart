import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatTimestamp } from '@/lib/format';
import { auditFilterOptions, searchAudit } from '@/modules/reporting';
import { getOrganization } from '@/server/organization-profile';
import { getRequestContext } from '@/server/request-context';
import { runQuery } from '@/shared/application/runner';
import { ChangeList } from '../_components/document-history';

export const metadata: Metadata = { title: 'Audit' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const FILTERS = ['entityType', 'entityId', 'actorUserId', 'action', 'from', 'to'] as const;

/** Where a document's own page is, for the entity types that have one. */
const DOCUMENT_PATHS: Record<string, string> = {
  requisition: '/requisitions',
  rfq: '/rfqs',
  purchase_order: '/purchase-orders',
  goods_receipt: '/goods-receipts',
  supplier: '/suppliers',
};

export default async function AuditPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const filters: Partial<Record<(typeof FILTERS)[number], string>> = {};
  for (const key of FILTERS) {
    const value = params[key];
    if (typeof value === 'string' && value.trim() !== '') filters[key] = value.trim().slice(0, 128);
  }
  const cursor = typeof params.cursor === 'string' ? params.cursor : undefined;
  const request = await getRequestContext();
  if (!request.actor?.permissions.has('audit.read')) {
    return (
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <p className="text-muted-foreground">Only auditors and administrators can search the audit trail.</p>
      </div>
    );
  }
  const { timezone } = await getOrganization();
  const options = await runQuery(request, auditFilterOptions, {});
  const result = await runQuery(request, searchAudit, { ...filters, ...(cursor ? { cursor } : {}) });
  const next = result.ok && result.data.nextCursor ? `/audit?${new URLSearchParams({ ...filters, cursor: result.data.nextCursor })}` : null;
  const users = options.ok ? options.data.users : [];
  const entityTypes = options.ok ? options.data.entityTypes : [];

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">Audit trail</h1>
        <p className="text-sm text-muted-foreground">
          Every recorded change, newest first. Dates are in the organization&apos;s time zone ({timezone}). The trail cannot be edited.
        </p>
      </div>

      <form role="search" method="get" className="grid gap-3 sm:grid-cols-3 sm:items-end">
        <div className="grid gap-2">
          <Label htmlFor="audit-entity-type">Record type</Label>
          <NativeSelect id="audit-entity-type" name="entityType" defaultValue={filters.entityType ?? ''}>
            <option value="">Any type</option>
            {entityTypes.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="audit-entity-id">Record id</Label>
          <Input id="audit-entity-id" name="entityId" defaultValue={filters.entityId ?? ''} maxLength={128} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="audit-actor">Person</Label>
          <NativeSelect id="audit-actor" name="actorUserId" defaultValue={filters.actorUserId ?? ''}>
            <option value="">Anyone</option>
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="audit-action">Action</Label>
          <Input id="audit-action" name="action" defaultValue={filters.action ?? ''} maxLength={100} placeholder="e.g. po.issued" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="audit-from">From</Label>
          <Input id="audit-from" name="from" type="date" defaultValue={filters.from ?? ''} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="audit-to">To</Label>
          <Input id="audit-to" name="to" type="date" defaultValue={filters.to ?? ''} />
        </div>
        <div className="flex gap-2 sm:col-span-3">
          <Button type="submit" variant="outline">
            Search
          </Button>
          <Button asChild variant="ghost">
            <Link href="/audit">Clear filters</Link>
          </Button>
        </div>
      </form>

      {!result.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {result.error.message}{' '}
          {Object.entries(result.error.fieldErrors ?? {})
            .map(([field, messages]) => `${field}: ${messages.join(', ')}`)
            .join('; ')}
        </p>
      ) : (
        <Table aria-label="Audit events">
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Who</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Record</TableHead>
              <TableHead>Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.data.items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  No audit events match these filters.
                </TableCell>
              </TableRow>
            ) : (
              result.data.items.map((event) => {
                const path = DOCUMENT_PATHS[event.entityType];
                return (
                  <TableRow key={event.id} className="align-top">
                    <TableCell className="whitespace-normal">{formatTimestamp(event.occurredAt, timezone)}</TableCell>
                    <TableCell className="whitespace-normal">
                      {event.actor}
                      {event.actorRoles.length > 0 ? <span className="block text-xs text-muted-foreground">{event.actorRoles.join(', ')}</span> : null}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{event.action}</TableCell>
                    <TableCell className="whitespace-normal text-xs">
                      {event.entityType}
                      <span className="block break-all font-mono">
                        {path ? (
                          <Link href={`${path}/${event.entityId}`} className="underline-offset-4 hover:underline">
                            {event.entityId}
                          </Link>
                        ) : (
                          event.entityId
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="min-w-64 whitespace-normal">
                      <details>
                        <summary className="cursor-pointer text-xs">
                          {event.changes.length} {event.changes.length === 1 ? 'change' : 'changes'}
                          {event.reason ? ', with reason' : ''}
                        </summary>
                        <div className="mt-2 grid gap-2 text-xs">
                          {event.changes.length > 0 ? <ChangeList changes={event.changes} /> : null}
                          {event.reason ? <p className="whitespace-pre-wrap">Reason: {event.reason}</p> : null}
                          <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-muted-foreground">
                            <dt>Request</dt>
                            <dd className="break-all font-mono">{event.requestId ?? '—'}</dd>
                            <dt>IP address</dt>
                            <dd className="font-mono">{event.ip ?? '—'}</dd>
                            <dt>User agent</dt>
                            <dd className="break-words">{event.userAgent ?? '—'}</dd>
                          </dl>
                        </div>
                      </details>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      )}
      {next ? (
        <div>
          <Button asChild variant="outline">
            <Link href={next}>Older events</Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
