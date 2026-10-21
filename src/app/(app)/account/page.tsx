import type { Metadata } from 'next';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getMyAccount } from '@/modules/identity';
import { runQuery } from '@/shared/application/runner';
import { getRequestContext } from '@/server/request-context';

export const metadata: Metadata = { title: 'My account' };

export default async function AccountPage() {
  const result = await runQuery(await getRequestContext(), getMyAccount, {});
  if (!result.ok) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{result.error.message}</AlertDescription>
      </Alert>
    );
  }
  const account = result.data;

  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">My account</h1>
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
            <dt className="text-muted-foreground">Name</dt>
            <dd>{account.name}</dd>
            <dt className="text-muted-foreground">Email</dt>
            <dd>{account.email}</dd>
            <dt className="text-muted-foreground">Department</dt>
            <dd>{account.department ? `${account.department.name} (${account.department.code})` : 'None'}</dd>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Roles</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {account.roles.length === 0 ? (
            <p className="text-muted-foreground">No roles assigned.</p>
          ) : (
            <ul className="grid gap-1" data-testid="role-list">
              {account.roles.map((r) => (
                <li key={`${r.role}:${r.departmentCode ?? ''}`}>
                  {r.label}
                  {r.departmentCode ? <span className="text-muted-foreground"> · {r.departmentCode}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
