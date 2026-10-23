import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { formatTimestamp } from '@/lib/format';
import { getSupplier } from '@/modules/suppliers';
import { getOrganization } from '@/server/organization-profile';
import { getRequestContext } from '@/server/request-context';
import { runQuery } from '@/shared/application/runner';
import { BlockForm, DeactivateForm, ReactivateForm, ReviewForm, UnblockForm } from '../_components/supplier-actions';
import { SupplierForm } from '../_components/supplier-form';
import { SupplierStatusBadge } from '../_components/supplier-status';
import { COUNTRY_OPTIONS, countryName } from '../country-options';
import { supplierNotice } from '../notices';

export const metadata: Metadata = { title: 'Supplier' };

export default async function SupplierPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await props.params;
  const notice = supplierNotice((await props.searchParams).notice);
  const request = await getRequestContext();
  const result = await runQuery(request, getSupplier, { supplierId: id });
  if (!result.ok) {
    if (result.error.code === 'NOT_FOUND' || result.error.code === 'VALIDATION_FAILED') notFound();
    return (
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold">{result.error.code === 'FORBIDDEN' ? 'Access denied' : 'Supplier'}</h1>
        <p className="text-muted-foreground">{result.error.message}</p>
      </div>
    );
  }
  const s = result.data;
  const { timezone } = await getOrganization();
  const can = (permission: string) => request.actor?.permissions.has(permission) ?? false;
  const target = { supplierId: s.id, version: s.version };
  const editable = can('supplier.manage') && s.status !== 'inactive';

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{s.legalName}</h1>
          <SupplierStatusBadge status={s.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          <span className="font-mono">{s.code}</span> · registered by {s.createdBy} on {formatTimestamp(s.createdAt, timezone)}
        </p>
      </div>

      {notice ? (
        <Alert role="status">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <h2 className="font-semibold">Review</h2>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <dl className="grid grid-cols-[12rem_1fr] gap-y-2">
            <dt className="text-muted-foreground">Reviewed</dt>
            <dd>{s.reviewedBy && s.reviewedAt ? `by ${s.reviewedBy} on ${formatTimestamp(s.reviewedAt, timezone)}` : 'Not reviewed'}</dd>
            {s.reviewNote ? (
              <>
                <dt className="text-muted-foreground">Review note</dt>
                <dd>{s.reviewNote}</dd>
              </>
            ) : null}
            {s.identityChangedBy ? (
              <>
                <dt className="text-muted-foreground">Identity last changed by</dt>
                <dd>{s.identityChangedBy}</dd>
              </>
            ) : null}
            {s.statusReason ? (
              <>
                <dt className="text-muted-foreground">Status reason</dt>
                <dd>{s.statusReason}</dd>
              </>
            ) : null}
          </dl>
          {s.status === 'pending_review' && can('supplier.review') ? <ReviewForm {...target} callerIsMaker={s.callerIsMaker} /> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="font-semibold">Details</h2>
        </CardHeader>
        <CardContent>
          {editable ? (
            <SupplierForm
              countries={COUNTRY_OPTIONS}
              supplier={{
                id: s.id,
                version: s.version,
                status: s.status,
                values: {
                  legalName: s.legalName,
                  taxId: s.taxId,
                  email: s.email,
                  phone: s.phone,
                  addressLine1: s.addressLine1,
                  addressLine2: s.addressLine2,
                  city: s.city,
                  region: s.region,
                  postalCode: s.postalCode,
                  countryCode: s.countryCode,
                },
              }}
            />
          ) : (
            <dl className="grid grid-cols-[12rem_1fr] gap-y-2 text-sm">
              <dt className="text-muted-foreground">Tax ID</dt>
              <dd>{s.taxId ?? '—'}</dd>
              <dt className="text-muted-foreground">Email</dt>
              <dd>{s.email ?? '—'}</dd>
              <dt className="text-muted-foreground">Phone</dt>
              <dd>{s.phone ?? '—'}</dd>
              <dt className="text-muted-foreground">Address</dt>
              <dd>
                {[s.addressLine1, s.addressLine2, s.city, s.region, s.postalCode].filter(Boolean).join(', ') || '—'}
              </dd>
              <dt className="text-muted-foreground">Country</dt>
              <dd>{countryName(s.countryCode)}</dd>
            </dl>
          )}
        </CardContent>
      </Card>

      {(s.status === 'active' && (can('supplier.block') || can('supplier.manage'))) ||
      (s.status === 'blocked' && can('supplier.review')) ||
      (s.status === 'inactive' && can('supplier.manage')) ? (
        <Card>
          <CardHeader>
            <h2 className="font-semibold">Status</h2>
          </CardHeader>
          <CardContent className="grid gap-6">
            {s.status === 'active' && can('supplier.block') ? <BlockForm {...target} /> : null}
            {s.status === 'active' && can('supplier.manage') ? <DeactivateForm {...target} /> : null}
            {s.status === 'blocked' && can('supplier.review') ? <UnblockForm {...target} /> : null}
            {s.status === 'inactive' && can('supplier.manage') ? <ReactivateForm {...target} /> : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
