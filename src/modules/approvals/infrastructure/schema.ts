import { sql } from 'drizzle-orm';
import { check, index, integer, numeric, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { departments, users } from '../../identity/tables';
import { approvalPolicies } from '../../organization/tables';

/*
 * Approval requests and their steps (docs/schema.md, Phase 5b). One request per submission
 * round; its steps are a snapshot of the policy route at submit time.
 * Declarations only (no I/O, no `server-only`), so drizzle-kit can load this file.
 */
const tz = { withTimezone: true, mode: 'date' } as const;

export const approvalRequests = pgTable(
  'approval_requests',
  {
    id: uuid('id').default(sql`uuidv7()`).primaryKey(),
    documentType: text('document_type').notNull(),
    /** The requisition or purchase order; not a foreign key, because it points at either table. */
    documentId: uuid('document_id').notNull(),
    round: smallint('round').notNull(),
    // What the approvers were asked to approve, frozen at submit.
    documentNumber: text('document_number').notNull(),
    documentTitle: text('document_title').notNull(),
    amountSnapshot: numeric('amount_snapshot', { precision: 20, scale: 4 }).notNull(),
    currencyCode: text('currency_code').notNull(),
    currencyScale: smallint('currency_scale').notNull(),
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'restrict' }),
    policyId: uuid('policy_id')
      .notNull()
      .references(() => approvalPolicies.id, { onDelete: 'restrict' }),
    policyVersionNo: integer('policy_version_no').notNull(),
    /** SOD-01: never decides a step of this request. */
    submittedByUserId: uuid('submitted_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** SOD-06, purchase orders from an award (Phase 7). Always NULL for requisitions. */
    awardedByUserId: uuid('awarded_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    status: text('status').notNull().default('pending'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    completedAt: timestamp('completed_at', tz),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    check('approval_requests_document_type', sql`${t.documentType} IN ('requisition', 'purchase_order')`),
    check('approval_requests_round_positive', sql`${t.round} >= 1`),
    check('approval_requests_document_number_length', sql`char_length(${t.documentNumber}) BETWEEN 1 AND 32`),
    check('approval_requests_document_title_length', sql`char_length(${t.documentTitle}) BETWEEN 1 AND 200`),
    check('approval_requests_amount_positive', sql`${t.amountSnapshot} > 0`),
    check('approval_requests_currency_code_format', sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
    check('approval_requests_currency_scale_range', sql`${t.currencyScale} BETWEEN 0 AND 4`),
    check('approval_requests_policy_version_positive', sql`${t.policyVersionNo} >= 1`),
    check('approval_requests_status', sql`${t.status} IN ('pending', 'approved', 'rejected', 'returned', 'cancelled')`),
    check('approval_requests_completed_consistent', sql`(${t.status} = 'pending') = (${t.completedAt} IS NULL)`),
    uniqueIndex('approval_requests_document_round').on(t.documentType, t.documentId, t.round),
    // AP-I1: at most one pending request per document.
    uniqueIndex('approval_requests_one_pending').on(t.documentType, t.documentId).where(sql`${t.status} = 'pending'`),
  ],
);

export const approvalSteps = pgTable(
  'approval_steps',
  {
    id: uuid('id').default(sql`uuidv7()`).primaryKey(),
    approvalRequestId: uuid('approval_request_id')
      .notNull()
      .references(() => approvalRequests.id, { onDelete: 'restrict' }),
    stepNo: smallint('step_no').notNull(),
    requiredRole: text('required_role').notNull(),
    /** The document's department for department-scoped steps; NULL means an org-wide assignment is needed. */
    scopeDepartmentId: uuid('scope_department_id').references(() => departments.id, { onDelete: 'restrict' }),
    status: text('status').notNull().default('waiting'),
    /** When the step became pending (open for a decision), for the inbox and approval aging. */
    activatedAt: timestamp('activated_at', tz),
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    decidedAt: timestamp('decided_at', tz),
    comment: text('comment'),
  },
  (t) => [
    check('approval_steps_step_no', sql`${t.stepNo} BETWEEN 1 AND 5`),
    check('approval_steps_required_role', sql`${t.requiredRole} IN ('approver', 'finance')`),
    check('approval_steps_finance_org_wide', sql`${t.requiredRole} <> 'finance' OR ${t.scopeDepartmentId} IS NULL`),
    check('approval_steps_status', sql`${t.status} IN ('waiting', 'pending', 'approved', 'rejected', 'returned', 'cancelled')`),
    check(
      'approval_steps_activated_consistent',
      sql`CASE ${t.status} WHEN 'waiting' THEN ${t.activatedAt} IS NULL WHEN 'cancelled' THEN true ELSE ${t.activatedAt} IS NOT NULL END`,
    ),
    // AP-I2: decided fields are set exactly on decided steps.
    check(
      'approval_steps_decided_consistent',
      sql`(${t.status} IN ('approved', 'rejected', 'returned')) = (${t.decidedByUserId} IS NOT NULL AND ${t.decidedAt} IS NOT NULL)`,
    ),
    check('approval_steps_decided_at_with_decider', sql`(${t.decidedByUserId} IS NULL) = (${t.decidedAt} IS NULL)`),
    check('approval_steps_comment_length', sql`${t.comment} IS NULL OR char_length(${t.comment}) BETWEEN 1 AND 2000`),
    check('approval_steps_comment_only_on_decision', sql`${t.comment} IS NULL OR ${t.decidedByUserId} IS NOT NULL`),
    check('approval_steps_comment_required', sql`${t.status} NOT IN ('rejected', 'returned') OR ${t.comment} IS NOT NULL`),
    uniqueIndex('approval_steps_request_step_no').on(t.approvalRequestId, t.stepNo),
    // SOD-02 / AP-I4: one decision per person per round (NULLs are distinct, so undecided steps never collide).
    uniqueIndex('approval_steps_distinct_deciders').on(t.approvalRequestId, t.decidedByUserId),
    // The approval inbox reads pending steps by role and scope.
    index('approval_steps_pending_idx').on(t.requiredRole, t.scopeDepartmentId).where(sql`${t.status} = 'pending'`),
  ],
);
