'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { FieldError, FormMessage } from '@/components/form-message';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { IDLE } from '@/lib/action-state';
import { createUserAction } from '../actions';
import { SetupLink } from './setup-link';

export type DepartmentOption = { code: string; name: string };
export type RoleOption = { value: string; label: string; scopable: boolean };

type Props = { departments: DepartmentOption[]; roles: RoleOption[] };

/** Remounting the inner form (new key) clears it for the next user. */
export function CreateUserForm(props: Props) {
  const [round, setRound] = useState(0);
  return <CreateUserFormRound key={round} {...props} onAnother={() => setRound((r) => r + 1)} />;
}

function CreateUserFormRound({ departments, roles, onAnother }: Props & { onAnother: () => void }) {
  const [state, formAction, pending] = useActionState(createUserAction, IDLE);

  if (state.status === 'ok') {
    return (
      <div className="grid gap-4">
        <FormMessage state={state} />
        {state.link ? <SetupLink url={state.link} /> : null}
        <div className="flex gap-3">
          {state.userId ? (
            <Button asChild>
              <Link href={`/admin/users/${state.userId}`}>Open user</Link>
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={onAnother}>
            Create another user
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form action={formAction} className="grid gap-5" noValidate>
      <div className="grid gap-2">
        <Label htmlFor="name">Name</Label>
        <Input id="name" name="name" required maxLength={120} autoComplete="off" disabled={pending} />
        <FieldError state={state} name="name" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="email">Work email</Label>
        <Input id="email" name="email" type="email" required maxLength={254} autoComplete="off" disabled={pending} />
        <FieldError state={state} name="email" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="departmentCode">Home department</Label>
        <NativeSelect id="departmentCode" name="departmentCode" defaultValue="" disabled={pending}>
          <option value="">None</option>
          {departments.map((d) => (
            <option key={d.code} value={d.code}>
              {d.name} ({d.code})
            </option>
          ))}
        </NativeSelect>
        <p className="text-sm text-muted-foreground">Requisitions are filed under this department.</p>
      </div>
      <fieldset className="grid gap-3" disabled={pending}>
        <legend className="mb-2 text-sm font-medium">Roles</legend>
        {roles.map((role) => (
          <div key={role.value} className="grid gap-2 sm:grid-cols-[12rem_1fr] sm:items-center">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="role" value={role.value} className="size-4" />
              {role.label}
            </label>
            {role.scopable ? (
              <NativeSelect name={`scope.${role.value}`} aria-label={`${role.label} scope`} defaultValue="">
                <option value="">Whole organization</option>
                {departments.map((d) => (
                  <option key={d.code} value={d.code}>
                    Only {d.name} ({d.code})
                  </option>
                ))}
              </NativeSelect>
            ) : null}
          </div>
        ))}
        <FieldError state={state} name="roles" />
      </fieldset>
      <FormMessage state={state} />
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Creating…' : 'Create user'}
        </Button>
      </div>
    </form>
  );
}
