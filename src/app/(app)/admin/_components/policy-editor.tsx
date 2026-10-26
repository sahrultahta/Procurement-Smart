'use client';

import { useActionState, useState } from 'react';
import { FieldError, FormMessage } from '@/components/form-message';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { ActionForm } from '@/components/action-form';
import { IDLE, type ActionState } from '@/lib/action-state';
import { publishPolicyAction } from '../actions';
import { STEP_LABELS, STEP_VALUES, type EditorDepartment, type EditorRule, type StepChoice } from './policy-choices';

/*
 * Editing a policy means publishing a new version (US-AD-03). The table below is local
 * state until "Publish"; the server validates it as a whole.
 */

function ruleErrors(state: ActionState, index: number): string[] {
  if (state.status !== 'error') return [];
  return Object.entries(state.fieldErrors ?? {})
    .filter(([key]) => key === `rules.${index}` || key.startsWith(`rules.${index}.`))
    .flatMap(([, messages]) => messages);
}

export function PolicyEditor(props: {
  documentType: 'requisition' | 'purchase_order';
  initialName: string;
  initialRules: EditorRule[];
  departments: EditorDepartment[];
  currency: string;
}) {
  const [state, formAction, pending] = useActionState(publishPolicyAction, IDLE);
  const [rules, setRules] = useState<EditorRule[]>(props.initialRules);
  const update = (index: number, change: Partial<EditorRule>) => setRules((all) => all.map((r, i) => (i === index ? { ...r, ...change } : r)));

  const payload = JSON.stringify(
    rules.map((r) => ({
      departmentCode: r.department === '' ? null : r.department,
      minAmount: r.minAmount.trim(),
      maxAmount: r.maxAmount.trim() === '' ? null : r.maxAmount.trim(),
      steps: r.steps.map((s) => STEP_VALUES[s]),
    })),
  );
  const tableErrors = state.status === 'error' ? [...(state.fieldErrors?.['rules'] ?? []), ...(state.fieldErrors?.['_form'] ?? [])] : [];

  return (
    <ActionForm action={formAction} className="grid gap-5" noValidate>
      <input type="hidden" name="documentType" value={props.documentType} />
      <input type="hidden" name="rules" value={payload} />
      <div className="grid gap-2">
        <Label htmlFor="policy-name">Version name</Label>
        <Input id="policy-name" name="name" defaultValue={props.initialName} required maxLength={120} disabled={pending} />
        <FieldError state={state} name="name" />
      </div>
      <p className="text-sm text-muted-foreground">
        Amounts are in {props.currency}. A rule applies from its lower limit up to, but not including, its upper limit. Rules for a
        specific department take priority; the rules for any department must cover every amount from 0 with no gaps.
      </p>
      <ol className="grid gap-4">
        {rules.map((rule, index) => (
          <li key={index} className="grid gap-3 rounded-md border p-4" aria-label={`Rule ${index + 1}`}>
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Rule {index + 1}</h3>
              <Button type="button" variant="ghost" size="sm" onClick={() => setRules((all) => all.filter((_, i) => i !== index))} disabled={pending}>
                Remove rule
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="grid gap-2">
                <Label htmlFor={`rule-${index}-department`}>Department</Label>
                <NativeSelect
                  id={`rule-${index}-department`}
                  value={rule.department}
                  onChange={(e) => update(index, { department: e.target.value })}
                  disabled={pending}
                >
                  <option value="">Any department</option>
                  {props.departments.map((d) => (
                    <option key={d.code} value={d.code}>
                      {d.name} ({d.code})
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="grid gap-2">
                <Label htmlFor={`rule-${index}-min`}>From</Label>
                <Input id={`rule-${index}-min`} inputMode="decimal" value={rule.minAmount} onChange={(e) => update(index, { minAmount: e.target.value })} disabled={pending} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor={`rule-${index}-max`}>Up to (empty: no limit)</Label>
                <Input id={`rule-${index}-max`} inputMode="decimal" value={rule.maxAmount} onChange={(e) => update(index, { maxAmount: e.target.value })} disabled={pending} />
              </div>
            </div>
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium">Approval steps, in order</legend>
              {rule.steps.map((step, j) => (
                <div key={j} className="flex items-center gap-2">
                  <span className="w-6 text-sm text-muted-foreground">{j + 1}.</span>
                  <NativeSelect
                    aria-label={`Rule ${index + 1}, step ${j + 1}`}
                    value={step}
                    onChange={(e) => update(index, { steps: rule.steps.map((s, k) => (k === j ? (e.target.value as StepChoice) : s)) })}
                    disabled={pending}
                  >
                    {(Object.keys(STEP_LABELS) as StepChoice[]).map((choice) => (
                      <option key={choice} value={choice}>
                        {STEP_LABELS[choice]}
                      </option>
                    ))}
                  </NativeSelect>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove step ${j + 1} of rule ${index + 1}`}
                    onClick={() => update(index, { steps: rule.steps.filter((_, k) => k !== j) })}
                    disabled={pending}
                  >
                    Remove
                  </Button>
                </div>
              ))}
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => update(index, { steps: [...rule.steps, 'approver_department'] })}
                  disabled={pending || rule.steps.length >= 5}
                >
                  Add step
                </Button>
              </div>
            </fieldset>
            {ruleErrors(state, index).length > 0 ? (
              <ul className="list-disc pl-5 text-sm text-destructive">
                {ruleErrors(state, index).map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ol>
      <div>
        <Button
          type="button"
          variant="outline"
          onClick={() => setRules((all) => [...all, { department: '', minAmount: '0', maxAmount: '', steps: ['approver_department'] }])}
          disabled={pending}
        >
          Add rule
        </Button>
      </div>
      {tableErrors.length > 0 ? (
        <ul className="list-disc pl-5 text-sm text-destructive">
          {tableErrors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}
      <FormMessage state={state} />
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Publishing…' : 'Publish new version'}
        </Button>
      </div>
    </ActionForm>
  );
}
