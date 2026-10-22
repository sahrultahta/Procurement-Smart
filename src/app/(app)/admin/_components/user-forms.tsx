'use client';

import { useActionState } from 'react';
import { FieldError, FormMessage } from '@/components/form-message';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { IDLE } from '@/lib/action-state';
import {
  deactivateUserAction,
  grantRoleAction,
  issueSetupLinkAction,
  reactivateUserAction,
  revokeRoleAction,
  updateUserAction,
} from '../actions';
import type { DepartmentOption, RoleOption } from './create-user-form';
import { SetupLink } from './setup-link';

/*
 * Forms on the user detail page. Hidden fields carry ids and the version the admin
 * is looking at; the server re-checks all of it (a stale version gets CONFLICT).
 */

export function ProfileForm(props: {
  userId: string;
  name: string;
  departmentCode: string | null;
  version: number;
  departments: DepartmentOption[];
}) {
  const [state, formAction, pending] = useActionState(updateUserAction, IDLE);
  return (
    <form action={formAction} className="grid gap-4" noValidate>
      <input type="hidden" name="userId" value={props.userId} />
      <input type="hidden" name="expectedVersion" value={props.version} />
      <div className="grid gap-2">
        <Label htmlFor="profile-name">Name</Label>
        <Input id="profile-name" name="name" defaultValue={props.name} required maxLength={120} disabled={pending} />
        <FieldError state={state} name="name" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="profile-department">Home department</Label>
        <NativeSelect id="profile-department" name="departmentCode" defaultValue={props.departmentCode ?? ''} disabled={pending}>
          <option value="">None</option>
          {props.departments.map((d) => (
            <option key={d.code} value={d.code}>
              {d.name} ({d.code})
            </option>
          ))}
        </NativeSelect>
      </div>
      <FormMessage state={state} />
      <div>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? 'Saving…' : 'Save profile'}
        </Button>
      </div>
    </form>
  );
}

export function DeactivateForm({ userId, version }: { userId: string; version: number }) {
  const [state, formAction, pending] = useActionState(deactivateUserAction, IDLE);
  return (
    <form action={formAction} className="grid gap-3" noValidate>
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="expectedVersion" value={version} />
      <div className="grid gap-2">
        <Label htmlFor="deactivate-reason">Reason for deactivation</Label>
        <Textarea id="deactivate-reason" name="reason" required maxLength={500} rows={2} disabled={pending} />
        <FieldError state={state} name="reason" />
      </div>
      <p className="text-sm text-muted-foreground">The user is signed out everywhere at once and can no longer sign in.</p>
      <FormMessage state={state} />
      <div>
        <Button type="submit" variant="destructive" disabled={pending}>
          {pending ? 'Deactivating…' : 'Deactivate user'}
        </Button>
      </div>
    </form>
  );
}

export function ReactivateForm({ userId, version }: { userId: string; version: number }) {
  const [state, formAction, pending] = useActionState(reactivateUserAction, IDLE);
  return (
    <form action={formAction} className="grid gap-3">
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="expectedVersion" value={version} />
      <FormMessage state={state} />
      <div>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? 'Reactivating…' : 'Reactivate user'}
        </Button>
      </div>
    </form>
  );
}

export function SetupLinkForm({ userId }: { userId: string }) {
  const [state, formAction, pending] = useActionState(issueSetupLinkAction, IDLE);
  return (
    <form action={formAction} className="grid gap-3">
      <input type="hidden" name="userId" value={userId} />
      <FormMessage state={state} />
      {state.status === 'ok' && state.link ? <SetupLink url={state.link} /> : null}
      <div>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? 'Creating link…' : 'Issue new setup link'}
        </Button>
      </div>
    </form>
  );
}

export function GrantRoleForm({ userId, roles, departments }: { userId: string; roles: RoleOption[]; departments: DepartmentOption[] }) {
  const [state, formAction, pending] = useActionState(grantRoleAction, IDLE);
  return (
    <form action={formAction} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" noValidate>
      <input type="hidden" name="userId" value={userId} />
      <div className="grid gap-2">
        <Label htmlFor="grant-role">Role</Label>
        <NativeSelect id="grant-role" name="role" defaultValue={roles[0]?.value} disabled={pending}>
          {roles.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="grant-scope">Scope</Label>
        <NativeSelect id="grant-scope" name="departmentCode" defaultValue="" disabled={pending}>
          <option value="">Whole organization</option>
          {departments.map((d) => (
            <option key={d.code} value={d.code}>
              Only {d.name} ({d.code})
            </option>
          ))}
        </NativeSelect>
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? 'Granting…' : 'Grant role'}
      </Button>
      <div className="sm:col-span-3">
        <p className="mb-2 text-sm text-muted-foreground">Only Requester and Approver can be limited to one department.</p>
        <FormMessage state={state} />
      </div>
    </form>
  );
}

export function RevokeRoleForm({ userId, assignmentId, label }: { userId: string; assignmentId: string; label: string }) {
  const [state, formAction, pending] = useActionState(revokeRoleAction, IDLE);
  return (
    <form action={formAction} className="grid gap-2" noValidate>
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="assignmentId" value={assignmentId} />
      <div className="flex gap-2">
        <Input name="reason" aria-label={`Reason for revoking ${label}`} placeholder="Reason" required maxLength={500} disabled={pending} />
        <Button type="submit" variant="outline" size="sm" className="h-9" disabled={pending}>
          Revoke
        </Button>
      </div>
      {state.status === 'error' ? <FormMessage state={state} /> : null}
    </form>
  );
}
