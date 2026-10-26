import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { getRfq } from '@/modules/sourcing';
import { getRequestContext } from '@/server/request-context';
import { runQuery } from '@/shared/application/runner';
import { QuotationForm } from '../../../_components/quotation-form';

export const metadata: Metadata = { title: 'Record quotation' };

export default async function NewQuotationPage(props: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await props.params;
  const { supplierId } = await props.searchParams;
  const result = await runQuery(await getRequestContext(), getRfq, { rfqId: id });
  if (!result.ok) {
    if (result.error.code === 'NOT_FOUND' || result.error.code === 'VALIDATION_FAILED') notFound();
    return (
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold">{result.error.code === 'FORBIDDEN' ? 'Access denied' : 'Record quotation'}</h1>
        <p className="text-muted-foreground">{result.error.message}</p>
      </div>
    );
  }
  const r = result.data;
  const supplier = r.suppliers.find((s) => s.id === supplierId);
  if (!supplier) notFound();
  const back = (
    <Link href={`/rfqs/${r.id}`} className="underline-offset-4 hover:underline">
      Back to {r.number}
    </Link>
  );
  if (!r.callerActions.includes('record')) {
    return (
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold">Record quotation</h1>
        <p className="text-muted-foreground">
          Quotations are recorded by procurement while the RFQ is issued. {r.number} is {r.status}.
        </p>
        <p className="text-sm">{back}</p>
      </div>
    );
  }
  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">Quotation from {supplier.legalName}</h1>
        <p className="text-sm text-muted-foreground">
          For <span className="font-mono">{r.number}</span> ({r.title}) · {back}
        </p>
      </div>
      <Card>
        <CardContent>
          <QuotationForm mode="record" rfqId={r.id} supplierId={supplier.id} lines={r.lines} currencyCode={r.currencyCode} />
        </CardContent>
      </Card>
    </div>
  );
}
