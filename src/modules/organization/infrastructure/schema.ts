import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, numeric, pgTable, primaryKey, smallint, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { departments, users } from '../../identity/tables';

/*
 * Organization settings and approval policies (docs/schema.md, Phase 5a).
 * Declarations only (no I/O, no `server-only`), so drizzle-kit can load this file.
 */
const tz = { withTimezone: true, mode: 'date' } as const;

/**
 * The single settings row (id = 1, created by the migration). Each phase adds the fields its
 * behavior uses (maintainer decision, 2026-10-22): Phase 5a name, time zone, currency; 6b sourcing;
 * 7 purchase-order approval and the receipt tolerance fixed at issue.
 */
export const orgSettings = pgTable(
  'org_settings',
  {
    id: smallint('id').primaryKey(),
    orgName: text('org_name').notNull(),
    timezone: text('timezone').notNull(),
    currencyCode: text('currency_code').notNull(),
    currencyScale: smallint('currency_scale').notNull(),
    /** Set by the first monetary document; from then on the currency cannot change (trigger). */
    currencyLockedAt: timestamp('currency_locked_at', tz),
    /** Phase 6b: from this requisition estimated total, fewer than `min_quotes` quotations need a justification. NULL: never. */
    rfqRequiredAbove: numeric('rfq_required_above', { precision: 20, scale: 4 }),
    minQuotes: smallint('min_quotes').notNull().default(3),
    /** Phase 7: purchase orders from this total (tax included) need approval. NULL: every one does. */
    poApprovalThreshold: numeric('po_approval_threshold', { precision: 20, scale: 4 }),
    /** Phase 7: how far (percent) PO prices may exceed the requisition estimate without approval. */
    poPriceTolerancePct: numeric('po_price_tolerance_pct', { precision: 7, scale: 4 }).notNull().default('0'),
    /** Phase 7 (issue fixes it per line; Phase 8 receives against it): percent receivable above the ordered quantity. */
    overReceiptTolerancePct: numeric('over_receipt_tolerance_pct', { precision: 7, scale: 4 }).notNull().default('0'),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    check('org_settings_single_row', sql`${t.id} = 1`),
    check('org_settings_org_name_length', sql`char_length(${t.orgName}) BETWEEN 1 AND 120`),
    check('org_settings_timezone_length', sql`char_length(${t.timezone}) BETWEEN 1 AND 64`),
    check('org_settings_currency_code_format', sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
    check('org_settings_currency_scale_range', sql`${t.currencyScale} BETWEEN 0 AND 4`),
    check('org_settings_rfq_required_above_non_negative', sql`${t.rfqRequiredAbove} IS NULL OR ${t.rfqRequiredAbove} >= 0`),
    check('org_settings_min_quotes_range', sql`${t.minQuotes} BETWEEN 1 AND 10`),
    check('org_settings_po_approval_threshold_non_negative', sql`${t.poApprovalThreshold} IS NULL OR ${t.poApprovalThreshold} >= 0`),
    check('org_settings_po_price_tolerance_range', sql`${t.poPriceTolerancePct} BETWEEN 0 AND 100`),
    check('org_settings_over_receipt_tolerance_range', sql`${t.overReceiptTolerancePct} BETWEEN 0 AND 100`),
  ],
);

/**
 * Approval policies are immutable once published (triggers). Publishing a new version
 * supersedes the active one; exactly one is active per document type.
 */
export const approvalPolicies = pgTable(
  'approval_policies',
  {
    id: uuid('id').default(sql`uuidv7()`).primaryKey(),
    documentType: text('document_type').notNull(),
    versionNo: integer('version_no').notNull(),
    name: text('name').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    supersededAt: timestamp('superseded_at', tz),
  },
  (t) => [
    check('approval_policies_document_type', sql`${t.documentType} IN ('requisition', 'purchase_order')`),
    check('approval_policies_name_length', sql`char_length(${t.name}) BETWEEN 1 AND 120`),
    check('approval_policies_version_positive', sql`${t.versionNo} >= 1`),
    check('approval_policies_active_xor_superseded', sql`${t.isActive} = (${t.supersededAt} IS NULL)`),
    uniqueIndex('approval_policies_one_active').on(t.documentType).where(sql`${t.isActive}`),
    uniqueIndex('approval_policies_version_unique').on(t.documentType, t.versionNo),
  ],
);

export const approvalPolicyRules = pgTable(
  'approval_policy_rules',
  {
    id: uuid('id').default(sql`uuidv7()`).primaryKey(),
    policyId: uuid('policy_id')
      .notNull()
      .references(() => approvalPolicies.id, { onDelete: 'restrict' }),
    ruleNo: smallint('rule_no').notNull(),
    /** NULL means "any department". */
    departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'restrict' }),
    minAmount: numeric('min_amount', { precision: 20, scale: 4 }).notNull().default('0'),
    /** Exclusive upper bound; NULL means unbounded. */
    maxAmount: numeric('max_amount', { precision: 20, scale: 4 }),
  },
  (t) => [
    check('approval_policy_rules_rule_no', sql`${t.ruleNo} BETWEEN 1 AND 50`),
    check('approval_policy_rules_min_non_negative', sql`${t.minAmount} >= 0`),
    check('approval_policy_rules_band', sql`${t.maxAmount} IS NULL OR ${t.maxAmount} > ${t.minAmount}`),
    uniqueIndex('approval_policy_rules_policy_rule_no').on(t.policyId, t.ruleNo),
    index('approval_policy_rules_policy_idx').on(t.policyId),
  ],
);

export const approvalPolicySteps = pgTable(
  'approval_policy_steps',
  {
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => approvalPolicyRules.id, { onDelete: 'restrict' }),
    stepNo: smallint('step_no').notNull(),
    requiredRole: text('required_role').notNull(),
    scopeMode: text('scope_mode').notNull(),
  },
  (t) => [
    primaryKey({ name: 'approval_policy_steps_pkey', columns: [t.ruleId, t.stepNo] }),
    check('approval_policy_steps_step_no', sql`${t.stepNo} BETWEEN 1 AND 5`),
    check('approval_policy_steps_required_role', sql`${t.requiredRole} IN ('approver', 'finance')`),
    check('approval_policy_steps_scope_mode', sql`${t.scopeMode} IN ('document_department', 'organization')`),
    // Finance is an organization-wide role (ADR 0006): it cannot be limited to the document's department.
    check('approval_policy_steps_finance_org_wide', sql`${t.requiredRole} <> 'finance' OR ${t.scopeMode} = 'organization'`),
  ],
);
