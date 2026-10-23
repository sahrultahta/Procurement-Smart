import 'server-only';
import { and, asc, desc, eq, inArray, isNull, max, sql } from 'drizzle-orm';
import type { Database, Tx } from '@/shared/db/transaction';
import type { PolicyDocumentType, PolicyRule, ScopeMode, StepRole } from '../domain/approval-policy';
import { approvalPolicies, approvalPolicyRules, approvalPolicySteps, orgSettings } from './schema';

type Queryable = Database | Tx;

export type SettingsRow = typeof orgSettings.$inferSelect;

export async function readSettings(db: Queryable): Promise<SettingsRow> {
  const [row] = await db.select().from(orgSettings).where(eq(orgSettings.id, 1));
  if (!row) throw new Error('org_settings row 1 is missing (migration 0009 creates it)');
  return row;
}

export async function lockSettings(tx: Tx): Promise<SettingsRow> {
  const [row] = await tx.select().from(orgSettings).where(eq(orgSettings.id, 1)).for('update');
  if (!row) throw new Error('org_settings row 1 is missing (migration 0009 creates it)');
  return row;
}

export async function updateSettings(
  tx: Tx,
  expectedVersion: number,
  values: Pick<SettingsRow, 'orgName' | 'timezone' | 'currencyCode' | 'currencyScale' | 'updatedByUserId'>,
): Promise<number> {
  const [row] = await tx
    .update(orgSettings)
    .set({ ...values, updatedAt: sql`now()`, version: sql`${orgSettings.version} + 1` })
    .where(and(eq(orgSettings.id, 1), eq(orgSettings.version, expectedVersion)))
    .returning({ version: orgSettings.version });
  if (!row) throw new Error('org_settings changed under its lock');
  return row.version;
}

/**
 * The currency for a new monetary document, locking it on first use. Only the very first
 * document takes the row lock; after that this is a plain read. If an admin changes the
 * currency concurrently, the conditional update sees the committed row and returns it.
 */
export async function lockCurrency(tx: Tx): Promise<{ code: string; scale: number }> {
  const current = await readSettings(tx);
  if (current.currencyLockedAt) return { code: current.currencyCode, scale: current.currencyScale };
  const [locked] = await tx
    .update(orgSettings)
    .set({ currencyLockedAt: sql`now()` })
    .where(and(eq(orgSettings.id, 1), isNull(orgSettings.currencyLockedAt)))
    .returning({ code: orgSettings.currencyCode, scale: orgSettings.currencyScale });
  if (locked) return locked;
  const after = await readSettings(tx);
  return { code: after.currencyCode, scale: after.currencyScale };
}

// --- Approval policies ---

// pg_advisory_xact_lock keys: one per document type, so publishes of one type serialize.
const PUBLISH_LOCK: Record<PolicyDocumentType, number> = { requisition: 0x5046_0101, purchase_order: 0x5046_0102 };

export async function lockPolicyPublishing(tx: Tx, documentType: PolicyDocumentType): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${PUBLISH_LOCK[documentType]}::bigint)`);
}

export type PolicyRow = typeof approvalPolicies.$inferSelect;
export type StoredPolicy = PolicyRow & { rules: (PolicyRule<string> & { ruleNo: number })[] };

async function rulesOf(db: Queryable, policyIds: readonly string[]): Promise<Map<string, StoredPolicy['rules']>> {
  const byPolicy = new Map<string, StoredPolicy['rules']>();
  if (policyIds.length === 0) return byPolicy;
  const rules = await db
    .select()
    .from(approvalPolicyRules)
    .where(inArray(approvalPolicyRules.policyId, [...policyIds]))
    .orderBy(asc(approvalPolicyRules.ruleNo));
  const steps =
    rules.length === 0
      ? []
      : await db
          .select()
          .from(approvalPolicySteps)
          .where(inArray(approvalPolicySteps.ruleId, rules.map((r) => r.id)))
          .orderBy(asc(approvalPolicySteps.stepNo));
  for (const rule of rules) {
    const list = byPolicy.get(rule.policyId) ?? [];
    list.push({
      ruleNo: rule.ruleNo,
      department: rule.departmentId,
      minAmount: rule.minAmount,
      maxAmount: rule.maxAmount,
      steps: steps.filter((s) => s.ruleId === rule.id).map((s) => ({ role: s.requiredRole as StepRole, scopeMode: s.scopeMode as ScopeMode })),
    });
    byPolicy.set(rule.policyId, list);
  }
  return byPolicy;
}

export async function findActivePolicy(db: Queryable, documentType: PolicyDocumentType): Promise<StoredPolicy | null> {
  const [policy] = await db
    .select()
    .from(approvalPolicies)
    .where(and(eq(approvalPolicies.documentType, documentType), eq(approvalPolicies.isActive, true)));
  if (!policy) return null;
  return { ...policy, rules: (await rulesOf(db, [policy.id])).get(policy.id) ?? [] };
}

export async function listPolicyVersions(db: Queryable, documentType: PolicyDocumentType): Promise<PolicyRow[]> {
  return db
    .select()
    .from(approvalPolicies)
    .where(eq(approvalPolicies.documentType, documentType))
    .orderBy(desc(approvalPolicies.versionNo));
}

export async function nextPolicyVersion(tx: Tx, documentType: PolicyDocumentType): Promise<number> {
  const [row] = await tx
    .select({ latest: max(approvalPolicies.versionNo) })
    .from(approvalPolicies)
    .where(eq(approvalPolicies.documentType, documentType));
  return (row?.latest ?? 0) + 1;
}

export async function supersedePolicy(tx: Tx, policyId: string): Promise<void> {
  await tx.update(approvalPolicies).set({ isActive: false, supersededAt: sql`now()` }).where(eq(approvalPolicies.id, policyId));
}

export async function insertPolicy(
  tx: Tx,
  policy: { documentType: PolicyDocumentType; versionNo: number; name: string; createdByUserId: string },
  rules: readonly PolicyRule<string>[],
): Promise<string> {
  const [row] = await tx.insert(approvalPolicies).values(policy).returning({ id: approvalPolicies.id });
  if (!row) throw new Error('approval policy insert returned no row');
  for (const [index, rule] of rules.entries()) {
    const [inserted] = await tx
      .insert(approvalPolicyRules)
      .values({ policyId: row.id, ruleNo: index + 1, departmentId: rule.department, minAmount: rule.minAmount, maxAmount: rule.maxAmount })
      .returning({ id: approvalPolicyRules.id });
    if (!inserted) throw new Error('approval policy rule insert returned no row');
    await tx
      .insert(approvalPolicySteps)
      .values(rule.steps.map((step, j) => ({ ruleId: inserted.id, stepNo: j + 1, requiredRole: step.role, scopeMode: step.scopeMode })));
  }
  return row.id;
}
