import type { Metadata } from 'next';
import { Card, CardContent } from '@/components/ui/card';
import { getRequestContext } from '@/server/request-context';
import { SupplierForm } from '../_components/supplier-form';
import { COUNTRY_OPTIONS } from '../country-options';

export const metadata: Metadata = { title: 'Register supplier' };

export default async function NewSupplierPage() {
  const { actor } = await getRequestContext();
  // Usability only: the create command checks supplier.manage itself.
  if (!actor?.permissions.has('supplier.manage')) {
    return (
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <p className="text-muted-foreground">Registering suppliers is for procurement.</p>
      </div>
    );
  }
  return (
    <div className="grid gap-4">
      <h1 className="text-2xl font-semibold">Register supplier</h1>
      <p className="text-sm text-muted-foreground">
        A new supplier starts as pending review. Someone from finance, other than you, must approve it before it can be used.
      </p>
      <Card>
        <CardContent>
          <SupplierForm countries={COUNTRY_OPTIONS} />
        </CardContent>
      </Card>
    </div>
  );
}
