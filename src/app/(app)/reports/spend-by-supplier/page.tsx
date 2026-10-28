import type { Metadata } from 'next';
import { SpendReport } from '../_components/spend-report';
import type { SearchParams } from '../_components/report-page';

export const metadata: Metadata = { title: 'Spend by supplier' };

export default async function SpendBySupplierPage({ searchParams }: { searchParams: SearchParams }) {
  return <SpendReport by="supplier" params={await searchParams} />;
}
