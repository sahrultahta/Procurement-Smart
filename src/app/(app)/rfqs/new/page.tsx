import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { rfqSourcingOptions } from '@/modules/sourcing';
import { getOrganization } from '@/server/organization-profile';
import { getRequestContext } from '@/server/request-context';
import { runQuery } from '@/shared/application/runner';
import { RfqForm } from '../_components/rfq-form';

export const metadata: Metadata = { title: 'New RFQ' };

export default async function NewRfqPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { requisitionId } = await searchParams;
  if (typeof requisitionId !== 'string') notFound();
  const result = await runQuery(await getRequestContext(), rfqSourcingOptions, { requisitionId });
  if (!result.ok) {
    if (result.error.code === 'NOT_FOUND' || result.error.code === 'VALIDATION_FAILED') notFound();
    return (
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold">{result.error.code === 'FORBIDDEN' ? 'Access denied' : 'New RFQ'}</h1>
        <p className="text-muted-foreground">{result.error.code === 'FORBIDDEN' ? 'Creating RFQs is for procurement.' : result.error.message}</p>
      </div>
    );
  }
  const options = result.data;
  const { timezone } = await getOrganization();
  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">New RFQ for {options.requisition.number}</h1>
        <p className="text-sm text-muted-foreground">{options.requisition.title}</p>
      </div>
      {options.requisition.status !== 'approved' ? (
        <p className="text-muted-foreground">This requisition is not approved, so it cannot be sourced.</p>
      ) : (
        <Card>
          <CardContent>
            <RfqForm options={options} timezone={timezone} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
