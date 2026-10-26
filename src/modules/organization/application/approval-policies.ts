import 'server-only';
import { z } from 'zod';
import { recordAuditEvent } from '@/modules/audit';
import { findDepartmentDirectory, findUserDisplayNames } from '@/modules/identity';
import { defineCommand, defineQuery } from '@/shared/application/runner';
import { moneyInput } from '@/shared/decimal/decimal';
import type { Database, Tx } from '@/shared/db/transaction';
import { failBusinessRule } from '@/shared/result';
import {
  POLICY_DOCUMENT_TYPES,
  SCOPE_MODES,
  STEP_ROLES,
  describeStep,
  resolveRule,
  validatePolicyRules,
  type PolicyDocumentType,
  type PolicyRule,
  type PolicyStep,
} from '../domain/approval-policy';
import {
  findActivePolicy,
  insertPolicy,
  listPolicyVersions,
  lockPolicyPublishing,
  nextPolicyVersion,
  supersedePolicy,
} from '../infrastructure/organization-repository';

/*
 * Approval policies (US-AD-03). Publishing creates a new immutable version and supersedes
 * the active one; requests already submitted keep the steps they were given (Phase 5b).
 */

const departmentCode = z.string().regex(/^[A-Z0-9-]{2,16}$/, 'Use a department code');

const ruleInput = z.strictObject({
  departmentCode: departmentCode.nullable(),
  minAmount: moneyInput,
  maxAmount: moneyInput.nullable(),
  steps: z.array(z.strictObject({ role: z.enum(STEP_ROLES), scopeMode: z.enum(SCOPE_MODES) })).max(10),
});

export const publishApprovalPolicy = defineCommand({
  name: 'admin.approvalPolicy.publish',
  permission: 'admin.approvalPolicies',
  input: z.strictObject({
    // Requisitions (Phase 5a) and purchase orders (Phase 7) each have their own policy versions.
    documentType: z.enum(POLICY_DOCUMENT_TYPES),
    name: z.string().trim().min(1, 'Name this policy version').max(120),
    rules: z
      .array(ruleInput)
      .max(60)
      .superRefine((rules, ctx) => {
        const issues = validatePolicyRules(rules.map((r) => ({ department: r.departmentCode, minAmount: r.minAmount, maxAmount: r.maxAmount, steps: r.steps })));
        for (const issue of issues) ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
      }),
  }),
  handler: async ({ tx, actor, request }, input): Promise<{ policyId: string; versionNo: number }> => {
    await lockPolicyPublishing(tx, input.documentType);
    const directory = await findDepartmentDirectory(tx);
    const rules: PolicyRule<string>[] = input.rules.map((rule) => {
      let department: string | null = null;
      if (rule.departmentCode !== null) {
        const found = directory.find((d) => d.code === rule.departmentCode && d.isActive);
        if (!found) failBusinessRule('UNKNOWN_DEPARTMENT', `Department ${rule.departmentCode} does not exist or is inactive.`);
        department = found.id;
      }
      return { department, minAmount: rule.minAmount, maxAmount: rule.maxAmount, steps: rule.steps };
    });

    const current = await findActivePolicy(tx, input.documentType);
    const versionNo = await nextPolicyVersion(tx, input.documentType);
    if (current) await supersedePolicy(tx, current.id);
    const policyId = await insertPolicy(tx, { documentType: input.documentType, versionNo, name: input.name, createdByUserId: actor.userId }, rules);

    const codeOf = (id: string | null) => (id === null ? null : (directory.find((d) => d.id === id)?.code ?? id));
    await recordAuditEvent(tx, request, {
      action: 'approvalPolicy.published',
      entityType: 'approval_policy',
      entityId: policyId,
      changes: {
        documentType: [current?.documentType ?? null, input.documentType],
        versionNo: [current?.versionNo ?? null, versionNo],
        name: [current?.name ?? null, input.name],
        rules: [current ? summarize(current.rules, codeOf) : null, summarize(rules, codeOf)],
      },
    });
    return { policyId, versionNo };
  },
});

function summarize(rules: readonly PolicyRule<string>[], codeOf: (id: string | null) => string | null): string[] {
  return rules.map(
    (r) => `${codeOf(r.department) ?? 'Any department'} [${r.minAmount}, ${r.maxAmount ?? '∞'}): ${r.steps.map(describeStep).join(' → ')}`,
  );
}

export type ApprovalPolicyRuleDto = {
  departmentCode: string | null;
  departmentName: string | null;
  minAmount: string;
  maxAmount: string | null;
  steps: PolicyStep[];
};
export type ApprovalPolicyDto = {
  id: string;
  versionNo: number;
  name: string;
  createdBy: string;
  createdAt: string;
  rules: ApprovalPolicyRuleDto[];
};
export const APPROVAL_POLICY_KEYS = ['id', 'versionNo', 'name', 'createdBy', 'createdAt', 'rules'] as const;

export const getActiveApprovalPolicy = defineQuery({
  name: 'admin.approvalPolicy.getActive',
  permission: 'admin.approvalPolicies',
  input: z.strictObject({ documentType: z.enum(POLICY_DOCUMENT_TYPES) }),
  handler: async ({ tx }, input): Promise<ApprovalPolicyDto | null> => {
    const policy = await findActivePolicy(tx, input.documentType);
    if (!policy) return null;
    const directory = await findDepartmentDirectory(tx);
    const names = await findUserDisplayNames(tx, [policy.createdByUserId]);
    return {
      id: policy.id,
      versionNo: policy.versionNo,
      name: policy.name,
      createdBy: names.get(policy.createdByUserId) ?? 'Unknown user',
      createdAt: policy.createdAt.toISOString(),
      rules: policy.rules.map((rule) => {
        const department = rule.department === null ? null : directory.find((d) => d.id === rule.department);
        return {
          departmentCode: department?.code ?? null,
          departmentName: department?.name ?? null,
          minAmount: rule.minAmount,
          maxAmount: rule.maxAmount,
          steps: [...rule.steps],
        };
      }),
    };
  },
});

export type ApprovalPolicyVersionDto = { id: string; versionNo: number; name: string; createdBy: string; createdAt: string; supersededAt: string | null };

export const listApprovalPolicyVersions = defineQuery({
  name: 'admin.approvalPolicy.list',
  permission: 'admin.approvalPolicies',
  input: z.strictObject({ documentType: z.enum(POLICY_DOCUMENT_TYPES) }),
  handler: async ({ tx }, input): Promise<ApprovalPolicyVersionDto[]> => {
    const versions = await listPolicyVersions(tx, input.documentType);
    const names = await findUserDisplayNames(tx, versions.map((v) => v.createdByUserId));
    return versions.map((v) => ({
      id: v.id,
      versionNo: v.versionNo,
      name: v.name,
      createdBy: names.get(v.createdByUserId) ?? 'Unknown user',
      createdAt: v.createdAt.toISOString(),
      supersededAt: v.supersededAt?.toISOString() ?? null,
    }));
  },
});

/**
 * For document modules (Phase 5b submit): the steps the active policy prescribes for a
 * document of `departmentId` and `amount`, or null when there is no route.
 */
export async function resolveApprovalRoute(
  db: Database | Tx,
  documentType: PolicyDocumentType,
  departmentId: string,
  amount: string,
): Promise<{ policyId: string; versionNo: number; steps: PolicyStep[] } | null> {
  const policy = await findActivePolicy(db, documentType);
  if (!policy) return null;
  const rule = resolveRule(policy.rules, departmentId, amount);
  return rule ? { policyId: policy.id, versionNo: policy.versionNo, steps: [...rule.steps] } : null;
}
