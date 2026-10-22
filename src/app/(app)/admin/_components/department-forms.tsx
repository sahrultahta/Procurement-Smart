'use client';

import { useActionState } from 'react';
import { FieldError, FormMessage } from '@/components/form-message';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { IDLE } from '@/lib/action-state';
import { createDepartmentAction, updateDepartmentAction } from '../actions';

export function CreateDepartmentForm() {
  const [state, formAction, pending] = useActionState(createDepartmentAction, IDLE);
  return (
    <form action={formAction} className="grid gap-3 sm:grid-cols-[10rem_1fr_auto] sm:items-end" noValidate>
      <div className="grid gap-2">
        <Label htmlFor="department-code">Code</Label>
        <Input id="department-code" name="code" required maxLength={16} placeholder="OPS" autoComplete="off" disabled={pending} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="department-name">Name</Label>
        <Input id="department-name" name="name" required maxLength={120} placeholder="Operations" autoComplete="off" disabled={pending} />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? 'Creating…' : 'Create department'}
      </Button>
      <div className="grid gap-2 sm:col-span-3">
        <FieldError state={state} name="code" />
        <FieldError state={state} name="name" />
        <p className="text-sm text-muted-foreground">2 to 16 uppercase letters, digits, or dashes. The code cannot be changed later.</p>
        <FormMessage state={state} />
      </div>
    </form>
  );
}

export function DepartmentRowForm(props: { id: string; code: string; name: string; isActive: boolean; version: number }) {
  const [state, formAction, pending] = useActionState(updateDepartmentAction, IDLE);
  return (
    <form action={formAction} className="grid gap-2" noValidate aria-label={`Department ${props.code}`}>
      <input type="hidden" name="departmentId" value={props.id} />
      <input type="hidden" name="expectedVersion" value={props.version} />
      <div className="grid gap-3 sm:grid-cols-[6rem_1fr_8rem_auto] sm:items-center">
        <span className="font-mono text-sm">{props.code}</span>
        <Input name="name" defaultValue={props.name} aria-label={`Name of ${props.code}`} required maxLength={120} disabled={pending} />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="isActive" defaultChecked={props.isActive} className="size-4" disabled={pending} />
          Active
        </label>
        <Button type="submit" variant="outline" size="sm" className="h-9" disabled={pending}>
          Save
        </Button>
      </div>
      <FormMessage state={state} />
    </form>
  );
}
