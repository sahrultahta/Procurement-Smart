'use client';

import { useActionState } from 'react';
import { FieldError, FormMessage } from '@/components/form-message';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { ActionForm } from '@/components/action-form';
import { IDLE } from '@/lib/action-state';
import { updateSettingsAction } from '../actions';

export function SettingsForm(props: {
  settings: { orgName: string; timezone: string; currencyCode: string; currencyScale: number; currencyLocked: boolean; version: number };
  timeZones: string[];
  currencies: string[];
}) {
  const [state, formAction, pending] = useActionState(updateSettingsAction, IDLE);
  const { settings } = props;
  return (
    <ActionForm action={formAction} className="grid gap-4" noValidate>
      <input type="hidden" name="expectedVersion" value={settings.version} />
      <div className="grid gap-2">
        <Label htmlFor="settings-org-name">Organization name</Label>
        <Input id="settings-org-name" name="orgName" defaultValue={settings.orgName} required maxLength={120} disabled={pending} />
        <FieldError state={state} name="orgName" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="settings-timezone">Time zone</Label>
        <NativeSelect id="settings-timezone" name="timezone" defaultValue={settings.timezone} disabled={pending}>
          {props.timeZones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </NativeSelect>
        <p className="text-sm text-muted-foreground">Dates such as &quot;needed by&quot; and document years follow this time zone.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="settings-currency">Currency</Label>
          <NativeSelect id="settings-currency" name="currencyCode" defaultValue={settings.currencyCode} disabled={pending || settings.currencyLocked}>
            {props.currencies.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="settings-scale">Decimal places</Label>
          <NativeSelect
            id="settings-scale"
            name="currencyScale"
            defaultValue={String(settings.currencyScale)}
            disabled={pending || settings.currencyLocked}
          >
            {[0, 1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      {settings.currencyLocked ? (
        <>
          {/* Disabled fields are not submitted; send the locked values so the rest can be saved. */}
          <input type="hidden" name="currencyCode" value={settings.currencyCode} />
          <input type="hidden" name="currencyScale" value={settings.currencyScale} />
          <p role="note" className="text-sm">
            The currency is locked: requisitions already use {settings.currencyCode}.
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">The currency locks when the first requisition is created.</p>
      )}
      <FormMessage state={state} />
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save settings'}
        </Button>
      </div>
    </ActionForm>
  );
}
