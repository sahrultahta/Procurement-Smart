import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { localDateTimeIn } from '@/modules/organization';
import { getRfq, rfqSourcingOptions } from '@/modules/sourcing';
import { getOrganization } from '@/server/organization-profile';
import { getRequestContext } from '@/server/request-context';
import { runQuery } from '@/shared/application/runner';
import { RfqForm } from '../../_components/rfq-form';

export const metadata: Metadata = { title: 'Edit RFQ' };

export default async function EditRfqPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const request = await getRequestContext();
  const result = await runQuery(request, getRfq, { rfqId: id });
  if (!result.ok) {
    if (result.error.code === 'NOT_FOUND' || result.error.code === 'VALIDATION_FAILED') notFound();
    return <p className="text-muted-foreground">{result.error.message}</p>;
  }
  const rfq = result.data;
  const options = rfq.callerActions.includes('edit') ? await runQuery(request, rfqSourcingOptions, { requisitionId: rfq.requisitionId, rfqId: rfq.id }) : null;
  if (!options?.ok) {
    return (
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold">This RFQ cannot be edited</h1>
        <p className="text-muted-foreground">Only procurement can edit an RFQ, and only while it is a draft.</p>
      </div>
    );
  }
  const { timezone } = await getOrganization();
  const lineIds = new Map(options.data.lines.map((l) => [l.lineNo, l.id]));
  return (
    <div className="grid gap-4">
      <h1 className="text-2xl font-semibold">Edit {rfq.number}</h1>
      <Card>
        <CardContent>
          <RfqForm
            options={options.data}
            timezone={timezone}
            rfq={{
              id: rfq.id,
              version: rfq.version,
              values: {
                title: rfq.title,
                responseDueAt: localDateTimeIn(timezone, new Date(rfq.responseDueAt)),
                lines: Object.fromEntries(rfq.lines.map((l) => [lineIds.get(l.requisitionLineNo) ?? '', l.quantity])),
                supplierIds: rfq.suppliers.map((s) => s.id),
              },
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
