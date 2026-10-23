import type { Metadata } from 'next';
import { Card, CardContent } from '@/components/ui/card';
import { getOrganization } from '@/server/organization-profile';
import { getRequestContext } from '@/server/request-context';
import { RequisitionForm } from '../_components/requisition-form';

export const metadata: Metadata = { title: 'New requisition' };

export default async function NewRequisitionPage() {
  const { actor } = await getRequestContext();
  // Usability only: requisition.create is checked by the command itself.
  if (!actor?.permissions.has('requisition.create')) {
    return (
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <p className="text-muted-foreground">Creating requisitions is for requesters.</p>
      </div>
    );
  }
  const org = await getOrganization();
  return (
    <div className="grid gap-4">
      <h1 className="text-2xl font-semibold">New requisition</h1>
      <p className="text-sm text-muted-foreground">
        It is filed under your department and stays a draft until you submit it for approval.
      </p>
      <Card>
        <CardContent>
          <RequisitionForm currency={{ code: org.currencyCode, scale: org.currencyScale }} />
        </CardContent>
      </Card>
    </div>
  );
}
