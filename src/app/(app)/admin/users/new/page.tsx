import type { Metadata } from 'next';
import { Card, CardContent } from '@/components/ui/card';
import { listDepartments } from '@/modules/identity';
import { getRequestContext } from '@/server/request-context';
import { runQuery } from '@/shared/application/runner';
import { CreateUserForm } from '../../_components/create-user-form';
import { ErrorPanel } from '../../_components/status-badge';
import { ROLE_OPTIONS } from '../../role-options';

export const metadata: Metadata = { title: 'New user' };

export default async function NewUserPage() {
  const departments = await runQuery(await getRequestContext(), listDepartments, {});
  return (
    <div className="grid gap-4">
      <h1 className="text-2xl font-semibold">New user</h1>
      <p className="text-sm text-muted-foreground">
        The user gets no password. You receive a one-time link (valid 24 hours) that lets them set one.
      </p>
      {!departments.ok ? (
        <ErrorPanel message={departments.error.message} />
      ) : (
        <Card>
          <CardContent>
            <CreateUserForm
              departments={departments.data.filter((d) => d.isActive).map((d) => ({ code: d.code, name: d.name }))}
              roles={ROLE_OPTIONS}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
