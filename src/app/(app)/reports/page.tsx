import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getRequestContext } from '@/server/request-context';
import { AccessDenied } from './_components/report-page';

export const metadata: Metadata = { title: 'Reports' };

const REPORTS = [
  { href: '/reports/spend-by-supplier', title: 'Spend by supplier', description: 'Order spend per supplier, as issued or as received.' },
  { href: '/reports/spend-by-department', title: 'Spend by department', description: 'Order spend per department, as issued or as received.' },
  { href: '/reports/cycle-time', title: 'Requisition cycle time', description: 'How long requisitions take from first submission to approval.' },
  { href: '/reports/approval-aging', title: 'Approval aging', description: 'Approval steps waiting for a decision, and for how long.' },
  { href: '/reports/open-purchase-orders', title: 'Open purchase orders', description: 'Issued orders still waiting for goods, and what is outstanding.' },
  { href: '/reports/split-purchases', title: 'Potential split purchases', description: 'Small orders that together reach an approval or RFQ threshold.' },
] as const;

export default async function ReportsPage() {
  const { actor } = await getRequestContext();
  if (!actor?.permissions.has('report.view')) return <AccessDenied />;
  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">Reports</h1>
        <p className="text-sm text-muted-foreground">Every report reads the live data when you open it, and each one downloads as CSV.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {REPORTS.map((report) => (
          <Link key={report.href} href={report.href} className="rounded-xl focus-visible:outline-2">
            <Card className="h-full transition-colors hover:bg-muted/50">
              <CardHeader>
                <CardTitle>{report.title}</CardTitle>
                <CardDescription>{report.description}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
