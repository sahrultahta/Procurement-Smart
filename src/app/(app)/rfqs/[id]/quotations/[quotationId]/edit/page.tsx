import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { getRfq } from '@/modules/sourcing';
import { getRequestContext } from '@/server/request-context';
import { runQuery } from '@/shared/application/runner';
import { QuotationForm } from '../../../../_components/quotation-form';

export const metadata: Metadata = { title: 'Edit quotation' };

export default async function EditQuotationPage(props: { params: Promise<{ id: string; quotationId: string }> }) {
  const { id, quotationId } = await props.params;
  const result = await runQuery(await getRequestContext(), getRfq, { rfqId: id });
  if (!result.ok) {
    if (result.error.code === 'NOT_FOUND' || result.error.code === 'VALIDATION_FAILED') notFound();
    return (
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold">{result.error.code === 'FORBIDDEN' ? 'Access denied' : 'Edit quotation'}</h1>
        <p className="text-muted-foreground">{result.error.message}</p>
      </div>
    );
  }
  const r = result.data;
  const quotation = r.quotations.find((q) => q.id === quotationId);
  if (!quotation) notFound();
  const back = (
    <Link href={`/rfqs/${r.id}`} className="underline-offset-4 hover:underline">
      Back to {r.number}
    </Link>
  );
  if (!quotation.callerActions.includes('edit')) {
    return (
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold">Edit quotation</h1>
        <p className="text-muted-foreground">Only a draft quotation of an issued RFQ can be edited, by procurement.</p>
        <p className="text-sm">{back}</p>
      </div>
    );
  }
  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">Edit quotation from {quotation.supplierName}</h1>
        <p className="text-sm text-muted-foreground">
          For <span className="font-mono">{r.number}</span> ({r.title}) · {back}
        </p>
      </div>
      <Card>
        <CardContent>
          <QuotationForm
            mode="edit"
            rfqId={r.id}
            lines={r.lines}
            currencyCode={r.currencyCode}
            quotation={{
              id: quotation.id,
              version: quotation.version,
              supplierReference: quotation.supplierReference,
              validUntil: quotation.validUntil,
              leadTimeDays: quotation.leadTimeDays,
              prices: Object.fromEntries(quotation.lines.map((l) => [l.rfqLineId, l.unitPrice])),
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
