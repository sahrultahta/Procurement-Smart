/* Step choices of the policy editor, shared by the server page and the client editor. */

export type StepChoice = 'approver_department' | 'approver_any' | 'finance';
export type EditorRule = { department: string; minAmount: string; maxAmount: string; steps: StepChoice[] };
export type EditorDepartment = { code: string; name: string };

export const STEP_LABELS: Record<StepChoice, string> = {
  approver_department: "Approver of the requisition's department",
  approver_any: 'Any approver',
  finance: 'Finance',
};

export const STEP_VALUES: Record<StepChoice, { role: 'approver' | 'finance'; scopeMode: 'document_department' | 'organization' }> = {
  approver_department: { role: 'approver', scopeMode: 'document_department' },
  approver_any: { role: 'approver', scopeMode: 'organization' },
  finance: { role: 'finance', scopeMode: 'organization' },
};

export function toChoice(step: { role: string; scopeMode: string }): StepChoice {
  if (step.role === 'finance') return 'finance';
  return step.scopeMode === 'document_department' ? 'approver_department' : 'approver_any';
}

