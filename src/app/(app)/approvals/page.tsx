import type { Metadata } from 'next';
import Link from 'next/link';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatMoney, formatTimestamp } from '@/lib/format';
import { approvalInbox, type InboxItemDto } from '@/modules/approvals';
import { getOrganization } from '@/server/organization-profile';
import { getRequestContext } from '@/server/request-context';
import { runQuery } from '@/shared/application/runner';

export const metadata: Metadata = { title: 'Approvals' };

function documentHref(item: InboxItemDto): string {
  // Purchase orders join the inbox in Phase 7.
  return `/requisitions/${item.documentId}`;
}

/** US-AP-01: the steps the signed-in person can decide now, oldest first. */
export default async function ApprovalsPage() {
  const result = await runQuery(await getRequestContext(), approvalInbox, {});
  if (!result.ok) {
    return (
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold">{result.error.code === 'FORBIDDEN' ? 'Access denied' : 'Approvals'}</h1>
        <p className="text-muted-foreground">
          {result.error.code === 'FORBIDDEN' ? 'You have no role that decides approvals.' : result.error.message}
        </p>
      </div>
    );
  }
  const { items, more } = result.data;
  const { timezone } = await getOrganization();

  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">Approvals</h1>
        <p className="text-sm text-muted-foreground">
          Steps waiting for your decision. Documents you submitted, and rounds where you already decided a step, are not listed:
          someone else decides those.
        </p>
      </div>
      {items.length === 0 ? (
        <p className="text-muted-foreground">Nothing is waiting for your decision.</p>
      ) : (
        <Table aria-label="Waiting for your decision">
          <TableHeader>
            <TableRow>
              <TableHead>Document</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Requested by</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Step</TableHead>
              <TableHead>Waiting since</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={`${item.approvalRequestId}-${item.stepNo}`}>
                <TableCell>
                  <Link href={documentHref(item)} className="font-mono underline-offset-4 hover:underline">
                    {item.documentNumber}
                  </Link>
                </TableCell>
                <TableCell className="whitespace-normal">{item.documentTitle}</TableCell>
                <TableCell>
                  {item.submittedBy} ({item.departmentCode})
                </TableCell>
                <TableCell className="text-right">{formatMoney(item.amount, item.currencyCode, item.currencyScale)}</TableCell>
                <TableCell>
                  {item.stepNo} of {item.stepCount}: {item.label}
                  {item.round > 1 ? ` (round ${item.round})` : ''}
                </TableCell>
                <TableCell>{formatTimestamp(item.waitingSince, timezone)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {more ? <p className="text-sm text-muted-foreground">Showing the 50 oldest. Decide these first to see the rest.</p> : null}
    </div>
  );
}
