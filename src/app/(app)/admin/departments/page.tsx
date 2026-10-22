import type { Metadata } from 'next';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { listDepartments } from '@/modules/identity';
import { getRequestContext } from '@/server/request-context';
import { runQuery } from '@/shared/application/runner';
import { CreateDepartmentForm, DepartmentRowForm } from '../_components/department-forms';
import { ErrorPanel } from '../_components/status-badge';

export const metadata: Metadata = { title: 'Departments' };

export default async function DepartmentsPage() {
  const result = await runQuery(await getRequestContext(), listDepartments, {});
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">Departments</h1>
      <Card>
        <CardHeader>
          <h2 className="font-semibold">New department</h2>
        </CardHeader>
        <CardContent>
          <CreateDepartmentForm />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <h2 className="font-semibold">All departments</h2>
          <p className="text-sm text-muted-foreground">
            An inactive department keeps its current members and roles, but cannot be given to anyone new.
          </p>
        </CardHeader>
        <CardContent className="grid gap-4">
          {!result.ok ? (
            <ErrorPanel message={result.error.message} />
          ) : result.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">No departments yet.</p>
          ) : (
            result.data.map((d) => <DepartmentRowForm key={d.id} {...d} />)
          )}
        </CardContent>
      </Card>
    </div>
  );
}
