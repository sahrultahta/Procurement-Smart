import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatTimestamp } from '@/lib/format';
import { getUser, listDepartments } from '@/modules/identity';
import { getOrganization } from '@/server/organization-profile';
import { getRequestContext } from '@/server/request-context';
import { runQuery } from '@/shared/application/runner';
import { ErrorPanel, UserStatusBadge } from '../../_components/status-badge';
import {
  DeactivateForm,
  GrantRoleForm,
  ProfileForm,
  ReactivateForm,
  RevokeRoleForm,
  SetupLinkForm,
} from '../../_components/user-forms';
import { ROLE_OPTIONS } from '../../role-options';

export const metadata: Metadata = { title: 'User' };

export default async function UserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const request = await getRequestContext();
  const result = await runQuery(request, getUser, { userId: id });
  if (!result.ok) {
    if (result.error.code === 'NOT_FOUND' || result.error.code === 'VALIDATION_FAILED') notFound();
    return <ErrorPanel message={result.error.message} />;
  }
  const user = result.data;
  const { timezone } = await getOrganization();
  const departments = await runQuery(request, listDepartments, {});
  const allDepartments = departments.ok ? departments.data : [];
  const activeDepartments = allDepartments.filter((d) => d.isActive).map((d) => ({ code: d.code, name: d.name }));
  // Keep the user's current department selectable even if it has since been deactivated.
  const current = allDepartments.find((d) => d.code === user.department?.code && !d.isActive);
  const profileDepartments = current ? [...activeDepartments, { code: current.code, name: `${current.name} (inactive)` }] : activeDepartments;

  const isSelf = request.actor?.userId === user.id;
  const active = user.assignments.filter((a) => a.revokedAt === null);
  const history = user.assignments.filter((a) => a.revokedAt !== null);

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{user.name}</h1>
          <UserStatusBadge status={user.status} passwordSet={user.passwordSet} />
        </div>
        <p className="text-sm text-muted-foreground">
          {user.email} · created {formatTimestamp(user.createdAt, timezone)}
        </p>
      </div>

      {isSelf ? (
        <p role="note" className="rounded-md border p-4 text-sm">
          This is your own account. Another administrator must change your profile, status, or roles (separation of duties).
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <h2 className="font-semibold">Profile</h2>
        </CardHeader>
        <CardContent>
          {isSelf ? (
            <p className="text-sm">
              Home department: {user.department ? `${user.department.name} (${user.department.code})` : 'None'}
            </p>
          ) : (
            <ProfileForm
              userId={user.id}
              name={user.name}
              departmentCode={user.department?.code ?? null}
              version={user.version}
              departments={profileDepartments}
            />
          )}
        </CardContent>
      </Card>

      {isSelf ? null : (
        <Card>
          <CardHeader>
            <h2 className="font-semibold">Access</h2>
          </CardHeader>
          <CardContent className="grid gap-4">
            {user.status === 'active' ? (
              <>
                {user.passwordSet ? (
                  <p className="text-sm">The user has set a password.</p>
                ) : (
                  <div className="grid gap-2">
                    <p className="text-sm">The user has not set a password yet. Issue a new link if the first one was lost or expired.</p>
                    <SetupLinkForm userId={user.id} />
                  </div>
                )}
                <DeactivateForm userId={user.id} version={user.version} />
              </>
            ) : (
              <>
                <p className="text-sm">
                  Deactivated{user.deactivatedAt ? ` on ${formatTimestamp(user.deactivatedAt, timezone)}` : ''}. The user cannot sign in.
                </p>
                <ReactivateForm userId={user.id} version={user.version} />
              </>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <h2 className="font-semibold">Roles</h2>
        </CardHeader>
        <CardContent className="grid gap-6">
          <Table aria-label="Active roles">
            <TableHeader>
              <TableRow>
                <TableHead>Role</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Granted</TableHead>
                {isSelf ? null : <TableHead className="w-72">Revoke</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {active.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground">
                    No roles. The user can sign in but cannot do any procurement work.
                  </TableCell>
                </TableRow>
              ) : (
                active.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>{a.label}</TableCell>
                    <TableCell>{a.departmentCode ?? 'Whole organization'}</TableCell>
                    <TableCell className="whitespace-normal">
                      {formatTimestamp(a.grantedAt, timezone)} by {a.grantedBy}
                    </TableCell>
                    {isSelf ? null : (
                      <TableCell>
                        <RevokeRoleForm userId={user.id} assignmentId={a.id} label={a.label} />
                      </TableCell>
                    )}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          {isSelf || user.status !== 'active' ? null : <GrantRoleForm userId={user.id} roles={ROLE_OPTIONS} departments={activeDepartments} />}
          {history.length > 0 ? (
            <div className="grid gap-2">
              <h3 className="text-sm font-medium">History</h3>
              <Table aria-label="Revoked roles">
                <TableHeader>
                  <TableRow>
                    <TableHead>Role</TableHead>
                    <TableHead>Scope</TableHead>
                    <TableHead>Granted</TableHead>
                    <TableHead>Revoked</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell>{a.label}</TableCell>
                      <TableCell>{a.departmentCode ?? 'Whole organization'}</TableCell>
                      <TableCell className="whitespace-normal">
                        {formatTimestamp(a.grantedAt, timezone)} by {a.grantedBy}
                      </TableCell>
                      <TableCell className="whitespace-normal">
                        {a.revokedAt ? formatTimestamp(a.revokedAt, timezone) : ''} by {a.revokedBy}: {a.revokeReason}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
