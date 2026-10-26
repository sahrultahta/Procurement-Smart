import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatAmount, formatTimestamp } from '@/lib/format';
import { listDepartments } from '@/modules/identity';
import { describeStep, getActiveApprovalPolicy, listApprovalPolicyVersions, type PolicyDocumentType } from '@/modules/organization';
import { getOrganization } from '@/server/organization-profile';
import { getRequestContext } from '@/server/request-context';
import { runQuery } from '@/shared/application/runner';
import { toChoice, type EditorRule } from '../_components/policy-choices';
import { PolicyEditor } from '../_components/policy-editor';
import { ErrorPanel } from '../_components/status-badge';

export const metadata: Metadata = { title: 'Approval policy' };

/** "1000.0000" → "1000": the editor shows amounts as an admin would type them. */
function plain(amount: string): string {
  return amount.includes('.') ? amount.replace(/0+$/, '').replace(/\.$/, '') : amount;
}

const STARTER: Record<PolicyDocumentType, EditorRule[]> = {
  requisition: [
    { department: '', minAmount: '0', maxAmount: '1000', steps: ['approver_department'] },
    { department: '', minAmount: '1000', maxAmount: '', steps: ['approver_department', 'finance'] },
  ],
  purchase_order: [
    { department: '', minAmount: '0', maxAmount: '5000', steps: ['finance'] },
    { department: '', minAmount: '5000', maxAmount: '', steps: ['approver_department', 'finance'] },
  ],
};

/** Each document type has its own policy (Phase 7 added purchase orders). */
const DOCUMENTS: Record<PolicyDocumentType, { title: string; plural: string; missing: string }> = {
  requisition: {
    title: 'Approval policy for requisitions',
    plural: 'Requisitions',
    missing: 'No policy is published yet: requisitions cannot be submitted until one is.',
  },
  purchase_order: {
    title: 'Approval policy for purchase orders',
    plural: 'Purchase orders',
    missing: 'No policy is published yet: purchase orders that need approval cannot be submitted until one is.',
  },
};

export default async function ApprovalPolicyPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const documentType: PolicyDocumentType = (await props.searchParams).type === 'purchase_order' ? 'purchase_order' : 'requisition';
  const labels = DOCUMENTS[documentType];
  const request = await getRequestContext();
  const [active, versions, departments, org] = await Promise.all([
    runQuery(request, getActiveApprovalPolicy, { documentType }),
    runQuery(request, listApprovalPolicyVersions, { documentType }),
    runQuery(request, listDepartments, {}),
    getOrganization(),
  ]);
  if (!active.ok) return <ErrorPanel message={active.error.message} />;
  const policy = active.data;
  const scale = org.currencyScale;

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">{labels.title}</h1>
        <p className="text-sm text-muted-foreground">
          {policy ? `Version ${policy.versionNo}, “${policy.name}”, published by ${policy.createdBy} on ${formatTimestamp(policy.createdAt, org.timezone)}.` : labels.missing}
        </p>
      </div>
      <nav aria-label="Document type" className="flex gap-4 text-sm">
        {(Object.keys(DOCUMENTS) as PolicyDocumentType[]).map((type) =>
          type === documentType ? (
            <span key={type} aria-current="page" className="font-medium">
              {DOCUMENTS[type].plural}
            </span>
          ) : (
            <Link key={type} href={type === 'requisition' ? '/admin/approval-policy' : '/admin/approval-policy?type=purchase_order'} className="text-muted-foreground underline-offset-4 hover:underline">
              {DOCUMENTS[type].plural}
            </Link>
          ),
        )}
      </nav>

      {policy ? (
        <Card>
          <CardHeader>
            <h2 className="font-semibold">Active rules</h2>
          </CardHeader>
          <CardContent>
            <Table aria-label="Active rules">
              <TableHeader>
                <TableRow>
                  <TableHead>Department</TableHead>
                  <TableHead>Amount ({org.currencyCode})</TableHead>
                  <TableHead>Steps</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {policy.rules.map((rule, i) => (
                  <TableRow key={i}>
                    <TableCell>{rule.departmentCode ? `${rule.departmentName} (${rule.departmentCode})` : 'Any department'}</TableCell>
                    <TableCell>
                      {formatAmount(rule.minAmount, scale)} to {rule.maxAmount ? `under ${formatAmount(rule.maxAmount, scale)}` : 'no limit'}
                    </TableCell>
                    <TableCell className="whitespace-normal">{rule.steps.map(describeStep).join(' → ')}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <h2 className="font-semibold">Publish a new version</h2>
          <p className="text-sm text-muted-foreground">Published versions never change. {labels.plural} already submitted keep the steps they were given.</p>
        </CardHeader>
        <CardContent>
          <PolicyEditor
            key={documentType}
            documentType={documentType}
            initialName={policy ? `${policy.name} (revised)` : 'Standard approvals'}
            initialRules={
              policy
                ? policy.rules.map((r) => ({
                    department: r.departmentCode ?? '',
                    minAmount: plain(r.minAmount),
                    maxAmount: r.maxAmount ? plain(r.maxAmount) : '',
                    steps: r.steps.map(toChoice),
                  }))
                : STARTER[documentType]
            }
            departments={departments.ok ? departments.data.filter((d) => d.isActive).map((d) => ({ code: d.code, name: d.name })) : []}
            currency={org.currencyCode}
          />
        </CardContent>
      </Card>

      {versions.ok && versions.data.length > 0 ? (
        <Card>
          <CardHeader>
            <h2 className="font-semibold">History</h2>
          </CardHeader>
          <CardContent>
            <Table aria-label="Policy versions">
              <TableHeader>
                <TableRow>
                  <TableHead>Version</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Published</TableHead>
                  <TableHead>Superseded</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {versions.data.map((v) => (
                  <TableRow key={v.id}>
                    <TableCell>{v.versionNo}</TableCell>
                    <TableCell>{v.name}</TableCell>
                    <TableCell className="whitespace-normal">
                      {formatTimestamp(v.createdAt, org.timezone)} by {v.createdBy}
                    </TableCell>
                    <TableCell>{v.supersededAt ? formatTimestamp(v.supersededAt, org.timezone) : 'Active'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
