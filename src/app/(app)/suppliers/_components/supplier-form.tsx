'use client';

import { useActionState } from 'react';
import { FieldError, FormMessage } from '@/components/form-message';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { IDLE, type ActionState } from '@/lib/action-state';
import { createSupplierAction, updateSupplierAction } from '../actions';

export type CountryOption = { code: string; name: string };

export type SupplierFormValues = {
  legalName: string;
  taxId: string | null;
  email: string | null;
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  countryCode: string;
};

const EMPTY: SupplierFormValues = {
  legalName: '',
  taxId: null,
  email: null,
  phone: null,
  addressLine1: null,
  addressLine2: null,
  city: null,
  region: null,
  postalCode: null,
  countryCode: '',
};

function Field(props: {
  state: ActionState;
  name: keyof SupplierFormValues;
  label: string;
  value: string | null;
  disabled: boolean;
  type?: string;
  maxLength: number;
  required?: boolean;
  hint?: string;
}) {
  const id = `supplier-${props.name}`;
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{props.label}</Label>
      <Input
        id={id}
        name={props.name}
        type={props.type ?? 'text'}
        defaultValue={props.value ?? ''}
        maxLength={props.maxLength}
        required={props.required}
        disabled={props.disabled}
        autoComplete="off"
      />
      {props.hint ? <p className="text-sm text-muted-foreground">{props.hint}</p> : null}
      <FieldError state={props.state} name={props.name} />
    </div>
  );
}

/** Create (no `supplier`) or edit an existing supplier. */
export function SupplierForm(props: {
  countries: CountryOption[];
  supplier?: { id: string; version: number; status: string; values: SupplierFormValues };
}) {
  const editing = props.supplier !== undefined;
  const [state, formAction, pending] = useActionState(editing ? updateSupplierAction : createSupplierAction, IDLE);
  const values = props.supplier?.values ?? EMPTY;

  return (
    <form action={formAction} className="grid gap-4" noValidate>
      {props.supplier ? (
        <>
          <input type="hidden" name="supplierId" value={props.supplier.id} />
          <input type="hidden" name="expectedVersion" value={props.supplier.version} />
        </>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field state={state} name="legalName" label="Legal name" value={values.legalName} maxLength={200} required disabled={pending} />
        <Field
          state={state}
          name="taxId"
          label="Tax ID (optional)"
          value={values.taxId}
          maxLength={40}
          disabled={pending}
          hint="Spaces, dots, and dashes are ignored when checking for duplicates."
        />
      </div>
      {editing && props.supplier?.status === 'active' ? (
        <p className="text-sm text-muted-foreground">
          Changing the legal name or tax ID sends this supplier back to review, and you will not be able to approve it.
        </p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field state={state} name="email" label="Email (optional)" type="email" value={values.email} maxLength={254} disabled={pending} />
        <Field state={state} name="phone" label="Phone (optional)" type="tel" value={values.phone} maxLength={30} disabled={pending} />
      </div>
      <Field state={state} name="addressLine1" label="Address line 1 (optional)" value={values.addressLine1} maxLength={200} disabled={pending} />
      <Field state={state} name="addressLine2" label="Address line 2 (optional)" value={values.addressLine2} maxLength={200} disabled={pending} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Field state={state} name="city" label="City (optional)" value={values.city} maxLength={100} disabled={pending} />
        <Field state={state} name="region" label="Region (optional)" value={values.region} maxLength={100} disabled={pending} />
        <Field state={state} name="postalCode" label="Postal code (optional)" value={values.postalCode} maxLength={20} disabled={pending} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="supplier-countryCode">Country</Label>
        <NativeSelect id="supplier-countryCode" name="countryCode" defaultValue={values.countryCode} required disabled={pending}>
          <option value="">Choose a country</option>
          {props.countries.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </NativeSelect>
        <FieldError state={state} name="countryCode" />
      </div>
      <FormMessage state={state} />
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : editing ? 'Save changes' : 'Register supplier'}
        </Button>
      </div>
    </form>
  );
}
