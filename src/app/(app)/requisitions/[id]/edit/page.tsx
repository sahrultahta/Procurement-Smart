import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { getRequisition } from '@/modules/requisitions';
import { getRequestContext } from '@/server/request-context';
import { runQuery } from '@/shared/application/runner';
import { RequisitionForm } from '../../_components/requisition-form';

export const metadata: Metadata = { title: 'Edit requisition' };

export default async function EditRequisitionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await runQuery(await getRequestContext(), getRequisition, { requisitionId: id });
  if (!result.ok) {
    if (result.error.code === 'NOT_FOUND' || result.error.code === 'VALIDATION_FAILED') notFound();
    return <p className="text-muted-foreground">{result.error.message}</p>;
  }
  const r = result.data;
  if (!r.callerCanEdit) {
    return (
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold">This requisition cannot be edited</h1>
        <p className="text-muted-foreground">Only its requester can edit it, and only while it is a draft or returned.</p>
      </div>
    );
  }
  return (
    <div className="grid gap-4">
      <h1 className="text-2xl font-semibold">Edit {r.number}</h1>
      <Card>
        <CardContent>
          <RequisitionForm
            currency={{ code: r.currencyCode, scale: r.currencyScale }}
            requisition={{
              id: r.id,
              version: r.version,
              values: {
                title: r.title,
                justification: r.justification,
                neededBy: r.neededBy,
                lines: r.lines.map((l) => ({ description: l.description, quantity: l.quantity, uom: l.uom, estimatedUnitPrice: l.estimatedUnitPrice })),
              },
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
