import { compareAmounts } from '@/shared/decimal/pricing';

/*
 * Approval policy rules with no I/O (docs/schema.md, US-AD-03, P5-AC3).
 * Amounts are decimal strings, compared with decimal arithmetic (ADR 0007 rule 6).
 */

export const POLICY_DOCUMENT_TYPES = ['requisition', 'purchase_order'] as const;
export type PolicyDocumentType = (typeof POLICY_DOCUMENT_TYPES)[number];

export const STEP_ROLES = ['approver', 'finance'] as const;
export type StepRole = (typeof STEP_ROLES)[number];

export const SCOPE_MODES = ['document_department', 'organization'] as const;
export type ScopeMode = (typeof SCOPE_MODES)[number];

export type PolicyStep = { role: StepRole; scopeMode: ScopeMode };

/** `department` is an opaque key (a code in input, an id in storage); null means any department. */
export type PolicyRule<D = string> = {
  department: D | null;
  minAmount: string;
  /** Exclusive; null means no upper limit. */
  maxAmount: string | null;
  steps: readonly PolicyStep[];
};

export type PolicyIssue = { path: (string | number)[]; message: string };

export const MAX_RULES = 50;
export const MAX_STEPS = 5;

const label = (department: unknown): string => (department === null ? 'any department' : String(department));

/**
 * Checks a whole policy: per department no two bands overlap; the "any department" rules
 * cover every amount from 0 upward with no gap; every rule has 1 to 5 steps; finance steps
 * are organization-wide (finance is not a department-scoped role, ADR 0006).
 */
export function validatePolicyRules<D>(rules: readonly PolicyRule<D>[]): PolicyIssue[] {
  const issues: PolicyIssue[] = [];
  if (rules.length === 0) issues.push({ path: [], message: 'Add at least one rule.' });
  if (rules.length > MAX_RULES) issues.push({ path: [], message: `A policy has at most ${MAX_RULES} rules.` });

  rules.forEach((rule, i) => {
    if (rule.maxAmount !== null && compareAmounts(rule.maxAmount, rule.minAmount) <= 0) {
      issues.push({ path: [i, 'maxAmount'], message: 'The upper limit must be above the lower limit.' });
    }
    if (rule.steps.length === 0) issues.push({ path: [i, 'steps'], message: 'Add at least one approval step.' });
    if (rule.steps.length > MAX_STEPS) issues.push({ path: [i, 'steps'], message: `A rule has at most ${MAX_STEPS} steps.` });
    rule.steps.forEach((step, j) => {
      if (step.role === 'finance' && step.scopeMode !== 'organization') {
        issues.push({ path: [i, 'steps', j, 'scopeMode'], message: 'Finance approval is organization-wide.' });
      }
    });
  });

  const groups = new Map<D | null, { rule: PolicyRule<D>; index: number }[]>();
  rules.forEach((rule, index) => {
    const group = groups.get(rule.department) ?? [];
    group.push({ rule, index });
    groups.set(rule.department, group);
  });

  for (const [department, group] of groups) {
    const sorted = [...group].sort((a, b) => compareAmounts(a.rule.minAmount, b.rule.minAmount));
    for (let k = 1; k < sorted.length; k++) {
      const previous = sorted[k - 1];
      const current = sorted[k];
      if (!previous || !current) continue;
      if (previous.rule.maxAmount === null || compareAmounts(current.rule.minAmount, previous.rule.maxAmount) < 0) {
        issues.push({
          path: [current.index, 'minAmount'],
          message: `Overlaps rule ${previous.index + 1} (${label(department)}).`,
        });
      } else if (department === null && compareAmounts(current.rule.minAmount, previous.rule.maxAmount) > 0) {
        issues.push({
          path: [current.index, 'minAmount'],
          message: `Leaves a gap after rule ${previous.index + 1}: amounts from ${previous.rule.maxAmount} would have no route.`,
        });
      }
    }
  }

  const general = [...(groups.get(null) ?? [])].sort((a, b) => compareAmounts(a.rule.minAmount, b.rule.minAmount));
  const first = general[0];
  const last = general.at(-1);
  if (!first || !last) {
    issues.push({ path: [], message: 'Add rules for any department that cover every amount from 0 upward.' });
  } else {
    if (compareAmounts(first.rule.minAmount, '0') !== 0) {
      issues.push({ path: [first.index, 'minAmount'], message: 'The rules for any department must start at 0.' });
    }
    if (last.rule.maxAmount !== null) {
      issues.push({ path: [last.index, 'maxAmount'], message: 'The highest rule for any department must have no upper limit.' });
    }
  }
  return issues;
}

function inBand(rule: PolicyRule<unknown>, amount: string): boolean {
  return compareAmounts(amount, rule.minAmount) >= 0 && (rule.maxAmount === null || compareAmounts(amount, rule.maxAmount) < 0);
}

/**
 * The route for a document: a rule for its department beats an "any department" rule, then
 * the band [min, max) must contain the amount. Null means no route (NO_APPROVAL_ROUTE):
 * a document is never approved automatically.
 */
export function resolveRule<D>(rules: readonly PolicyRule<D>[], department: D, amount: string): PolicyRule<D> | null {
  return rules.find((r) => r.department !== null && r.department === department && inBand(r, amount)) ??
    rules.find((r) => r.department === null && inBand(r, amount)) ??
    null;
}

export function describeStep(step: PolicyStep): string {
  return step.role === 'finance' ? 'Finance' : step.scopeMode === 'document_department' ? "Approver of the document's department" : 'Any approver';
}
