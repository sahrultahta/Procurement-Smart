import { describe, expect, it } from 'vitest';
import { resolveRule, validatePolicyRules, type PolicyRule, type PolicyStep } from '@/modules/organization/domain/approval-policy';

const approver: PolicyStep = { role: 'approver', scopeMode: 'document_department' };
const finance: PolicyStep = { role: 'finance', scopeMode: 'organization' };

const rule = (department: string | null, minAmount: string, maxAmount: string | null, steps: PolicyStep[] = [approver]): PolicyRule => ({
  department,
  minAmount,
  maxAmount,
  steps,
});

// The seed's default: under 1,000 one approver; from 1,000 the approver, then finance.
const standard = [rule(null, '0', '1000'), rule(null, '1000', null, [approver, finance])];

const messages = (rules: PolicyRule[]) => validatePolicyRules(rules).map((i) => `${i.path.join('.')}: ${i.message}`);

describe('P5a-AC2: policy validation', () => {
  it('accepts full coverage for any department, plus non-overlapping department bands with gaps', () => {
    expect(messages(standard)).toEqual([]);
    expect(messages([...standard, rule('OPS', '0', '500'), rule('OPS', '5000', null, [approver, finance])])).toEqual([]);
  });

  it('rejects overlapping bands within one department, wherever they are listed', () => {
    expect(messages([rule(null, '0', '1000'), rule(null, '500', null)])).toEqual(['1.minAmount: Overlaps rule 1 (any department).']);
    expect(messages([...standard, rule('OPS', '100', null), rule('OPS', '0', '200')])).toEqual(['2.minAmount: Overlaps rule 4 (OPS).']);
    // An unbounded band overlaps anything above it.
    expect(messages([rule(null, '0', null), rule(null, '1000', null)])).toContain('1.minAmount: Overlaps rule 1 (any department).');
  });

  it('allows the same band in different departments', () => {
    expect(messages([...standard, rule('OPS', '0', '1000'), rule('FIN', '0', '1000')])).toEqual([]);
  });

  it('requires the any-department rules to start at 0, have no gaps, and no upper limit at the top', () => {
    expect(messages([rule(null, '0.01', null)])).toEqual(['0.minAmount: The rules for any department must start at 0.']);
    expect(messages([rule(null, '0', '1000'), rule(null, '1000.0001', null)])).toEqual([
      '1.minAmount: Leaves a gap after rule 1: amounts from 1000 would have no route.',
    ]);
    expect(messages([rule(null, '0', '1000'), rule(null, '1000', '5000')])).toEqual([
      '1.maxAmount: The highest rule for any department must have no upper limit.',
    ]);
    expect(messages([rule('OPS', '0', null)])).toEqual([': Add rules for any department that cover every amount from 0 upward.']);
    expect(messages([])).toContain(': Add at least one rule.');
  });

  it('compares amounts as decimals: 1000 and 1000.0000 are the same boundary', () => {
    expect(messages([rule(null, '0', '1000.0000'), rule(null, '1000', null)])).toEqual([]);
    expect(messages([rule(null, '0', '999.9999'), rule(null, '1000', null)])).toHaveLength(1);
  });

  it('checks each rule: upper above lower, 1 to 5 steps, finance organization-wide', () => {
    expect(messages([rule(null, '0', '0'), rule(null, '0', null)])).toContain('0.maxAmount: The upper limit must be above the lower limit.');
    expect(messages([rule(null, '0', null, [])])).toEqual(['0.steps: Add at least one approval step.']);
    expect(messages([rule(null, '0', null, Array(6).fill(approver))])).toEqual(['0.steps: A rule has at most 5 steps.']);
    expect(messages([rule(null, '0', null, [{ role: 'finance', scopeMode: 'document_department' }])])).toEqual([
      '0.steps.0.scopeMode: Finance approval is organization-wide.',
    ]);
    expect(messages(Array.from({ length: 51 }, (_, i) => rule('D', String(i), String(i + 1))).concat(standard))).toContain(
      ': A policy has at most 50 rules.',
    );
  });
});

describe('P5a-AC3: route resolution', () => {
  const policy = [...standard, rule('OPS', '0', '500', [finance]), rule('OPS', '5000', null, [approver, approver, finance])];
  const route = (department: string, amount: string) => resolveRule(policy, department, amount)?.steps ?? null;

  it('matches the band [min, max) exactly at its edges', () => {
    expect(route('FIN', '0')).toEqual([approver]);
    expect(route('FIN', '999.99')).toEqual([approver]);
    expect(route('FIN', '999.9999')).toEqual([approver]);
    expect(route('FIN', '1000')).toEqual([approver, finance]);
    expect(route('FIN', '1000.00')).toEqual([approver, finance]);
    expect(route('FIN', '9999999999999.99')).toEqual([approver, finance]);
  });

  it('prefers a rule for the department, and falls back to any-department rules in its gaps', () => {
    expect(route('OPS', '0')).toEqual([finance]);
    expect(route('OPS', '499.99')).toEqual([finance]);
    expect(route('OPS', '500')).toEqual([approver]); // gap in OPS rules → any department, [0, 1000)
    expect(route('OPS', '4999.99')).toEqual([approver, finance]); // any department, [1000, ∞)
    expect(route('OPS', '5000')).toEqual([approver, approver, finance]);
  });

  it('has no route when nothing matches (never auto-approve)', () => {
    expect(resolveRule([rule(null, '100', null)], 'OPS', '99.99')).toBeNull();
    expect(resolveRule([], 'OPS', '1')).toBeNull();
  });
});
