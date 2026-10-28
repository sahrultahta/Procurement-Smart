import type { Metadata } from 'next';
import { SpendReport } from '../_components/spend-report';
import type { SearchParams } from '../_components/report-page';

export const metadata: Metadata = { title: 'Spend by department' };

export default async function SpendByDepartmentPage({ searchParams }: { searchParams: SearchParams }) {
  return <SpendReport by="department" params={await searchParams} />;
}
