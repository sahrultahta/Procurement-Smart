import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { users } from '../../identity/tables';
import { purchaseRequisitions, requisitionLines } from '../../requisitions/tables';
import { suppliers } from '../../suppliers/tables';

/*
 * Requests for quotation and quotations (docs/schema.md; Phase 6a the RFQ lifecycle, Phase 6b
 * quotations and the award). Declarations only (no I/O, no `server-only`), so drizzle-kit can
 * load this file.
 */
const tz = { withTimezone: true, mode: 'date' } as const;

export const rfqs = pgTable(
  'rfqs',
  {
    id: uuid('id').default(sql`uuidv7()`).primaryKey(),
    number: text('number').notNull().unique(),
    /** One approved requisition per RFQ; its lines are what is being quoted. */
    requisitionId: uuid('requisition_id')
      .notNull()
      .references(() => purchaseRequisitions.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    status: text('status').notNull().default('draft'),
    /** When quotations are due; entered as a local time in the org time zone. */
    responseDueAt: timestamp('response_due_at', tz).notNull(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    issuedAt: timestamp('issued_at', tz),
    issuedByUserId: uuid('issued_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    closedAt: timestamp('closed_at', tz),
    closedByUserId: uuid('closed_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    cancelledAt: timestamp('cancelled_at', tz),
    cancelledByUserId: uuid('cancelled_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    cancelReason: text('cancel_reason'),
    // The award (RFQ-T05, Phase 6b). `awarded_by` is the buyer SOD-06 keeps off the PO's approval.
    awardedQuotationId: uuid('awarded_quotation_id').references((): AnyPgColumn => quotations.id, { onDelete: 'restrict' }),
    awardedByUserId: uuid('awarded_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    awardedAt: timestamp('awarded_at', tz),
    awardJustification: text('award_justification'),
    // The rule as it stood at the award, so a later settings change cannot rewrite why it was allowed.
    awardRfqRequiredAbove: numeric('award_rfq_required_above', { precision: 20, scale: 4 }),
    awardMinQuotes: smallint('award_min_quotes'),
    awardValidQuotes: smallint('award_valid_quotes'),
    awardBelowMinQuotes: boolean('award_below_min_quotes'),
    awardNotLowest: boolean('award_not_lowest'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    check('rfqs_number_format', sql`${t.number} ~ '^RFQ-[0-9]{4}-[0-9]{6}$'`),
    check('rfqs_title_length', sql`char_length(${t.title}) BETWEEN 1 AND 200`),
    check('rfqs_status', sql`${t.status} IN ('draft', 'issued', 'closed', 'awarded', 'cancelled')`),
    check('rfqs_issued_by_with_time', sql`(${t.issuedAt} IS NULL) = (${t.issuedByUserId} IS NULL)`),
    check('rfqs_issued_states', sql`CASE ${t.status} WHEN 'draft' THEN ${t.issuedAt} IS NULL WHEN 'cancelled' THEN true ELSE ${t.issuedAt} IS NOT NULL END`),
    check('rfqs_closed_by_with_time', sql`(${t.closedAt} IS NULL) = (${t.closedByUserId} IS NULL)`),
    check(
      'rfqs_closed_states',
      sql`CASE ${t.status} WHEN 'closed' THEN ${t.closedAt} IS NOT NULL WHEN 'awarded' THEN ${t.closedAt} IS NOT NULL WHEN 'cancelled' THEN ${t.closedAt} IS NULL OR ${t.issuedAt} IS NOT NULL ELSE ${t.closedAt} IS NULL END`,
    ),
    check(
      'rfqs_cancel_consistent',
      sql`(${t.status} = 'cancelled') = (${t.cancelledAt} IS NOT NULL AND ${t.cancelledByUserId} IS NOT NULL AND ${t.cancelReason} IS NOT NULL)`,
    ),
    check('rfqs_cancel_reason_length', sql`${t.cancelReason} IS NULL OR char_length(${t.cancelReason}) BETWEEN 1 AND 500`),
    // An awarded RFQ has its award and rule snapshot (threshold and justification may be NULL); any other has none of it.
    check(
      'rfqs_award_states',
      sql`CASE WHEN ${t.status} = 'awarded' THEN ${t.awardedQuotationId} IS NOT NULL AND ${t.awardedByUserId} IS NOT NULL AND ${t.awardedAt} IS NOT NULL AND ${t.awardMinQuotes} IS NOT NULL AND ${t.awardValidQuotes} IS NOT NULL AND ${t.awardBelowMinQuotes} IS NOT NULL AND ${t.awardNotLowest} IS NOT NULL ELSE ${t.awardedQuotationId} IS NULL AND ${t.awardedByUserId} IS NULL AND ${t.awardedAt} IS NULL AND ${t.awardJustification} IS NULL AND ${t.awardRfqRequiredAbove} IS NULL AND ${t.awardMinQuotes} IS NULL AND ${t.awardValidQuotes} IS NULL AND ${t.awardBelowMinQuotes} IS NULL AND ${t.awardNotLowest} IS NULL END`,
    ),
    check('rfqs_award_justification_length', sql`${t.awardJustification} IS NULL OR char_length(${t.awardJustification}) BETWEEN 1 AND 2000`),
    // Fewer valid quotations than the minimum, or not the lowest: only with a justification.
    check('rfqs_award_justified', sql`NOT (${t.awardBelowMinQuotes} OR ${t.awardNotLowest}) OR ${t.awardJustification} IS NOT NULL`),
    check(
      'rfqs_award_rule_range',
      sql`(${t.awardMinQuotes} IS NULL OR ${t.awardMinQuotes} BETWEEN 1 AND 10) AND (${t.awardValidQuotes} IS NULL OR ${t.awardValidQuotes} >= 1) AND (${t.awardRfqRequiredAbove} IS NULL OR ${t.awardRfqRequiredAbove} >= 0)`,
    ),
    index('rfqs_requisition_idx').on(t.requisitionId),
    index('rfqs_status_idx').on(t.status),
  ],
);

export const rfqLines = pgTable(
  'rfq_lines',
  {
    id: uuid('id').default(sql`uuidv7()`).primaryKey(),
    rfqId: uuid('rfq_id')
      .notNull()
      .references(() => rfqs.id, { onDelete: 'restrict' }),
    lineNo: smallint('line_no').notNull(),
    requisitionLineId: uuid('requisition_line_id')
      .notNull()
      .references(() => requisitionLines.id, { onDelete: 'restrict' }),
    /** Copied from the requisition line, never from input. */
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 18, scale: 3 }).notNull(),
    uom: text('uom').notNull(),
  },
  (t) => [
    check('rfq_lines_line_no', sql`${t.lineNo} BETWEEN 1 AND 200`),
    check('rfq_lines_description_length', sql`char_length(${t.description}) BETWEEN 1 AND 500`),
    check('rfq_lines_quantity_positive', sql`${t.quantity} > 0`),
    check('rfq_lines_uom_length', sql`char_length(${t.uom}) BETWEEN 1 AND 16`),
    uniqueIndex('rfq_lines_rfq_line_no').on(t.rfqId, t.lineNo),
    uniqueIndex('rfq_lines_rfq_requisition_line').on(t.rfqId, t.requisitionLineId),
    index('rfq_lines_requisition_line_idx').on(t.requisitionLineId),
  ],
);

/** Invited suppliers. Quotations can come only from these (composite foreign key below). */
export const rfqSuppliers = pgTable(
  'rfq_suppliers',
  {
    rfqId: uuid('rfq_id')
      .notNull()
      .references(() => rfqs.id, { onDelete: 'restrict' }),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),
    invitedByUserId: uuid('invited_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    invitedAt: timestamp('invited_at', tz).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: 'rfq_suppliers_pkey', columns: [t.rfqId, t.supplierId] }), index('rfq_suppliers_supplier_idx').on(t.supplierId)],
);

/**
 * What an invited supplier quoted, recorded by a buyer (suppliers have no login in v1). Prices
 * exclude tax; tax comes with the purchase order (Phase 7). Totals are computed by the server.
 */
export const quotations = pgTable(
  'quotations',
  {
    id: uuid('id').default(sql`uuidv7()`).primaryKey(),
    rfqId: uuid('rfq_id')
      .notNull()
      .references(() => rfqs.id, { onDelete: 'restrict' }),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),
    /** The supplier's own quotation number, if any. */
    supplierReference: text('supplier_reference'),
    status: text('status').notNull().default('draft'),
    /** The requisition's currency, never from input. */
    currencyCode: text('currency_code').notNull(),
    validUntil: date('valid_until', { mode: 'string' }).notNull(),
    leadTimeDays: smallint('lead_time_days').notNull(),
    /** Server-computed sum of the rounded line totals (ADR 0007). */
    total: numeric('total', { precision: 20, scale: 4 }).notNull(),
    recordedByUserId: uuid('recorded_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** From the application clock: it decides whether the quotation was late. */
    submittedAt: timestamp('submitted_at', tz),
    submittedByUserId: uuid('submitted_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    withdrawnAt: timestamp('withdrawn_at', tz),
    withdrawnByUserId: uuid('withdrawn_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    withdrawReason: text('withdraw_reason'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    // Only invited suppliers can quote (P6-AC2).
    foreignKey({ name: 'quotations_invited_supplier_fk', columns: [t.rfqId, t.supplierId], foreignColumns: [rfqSuppliers.rfqId, rfqSuppliers.supplierId] }).onDelete(
      'restrict',
    ),
    check('quotations_status', sql`${t.status} IN ('draft', 'submitted', 'withdrawn', 'awarded', 'not_awarded')`),
    check('quotations_supplier_reference_length', sql`${t.supplierReference} IS NULL OR char_length(${t.supplierReference}) BETWEEN 1 AND 100`),
    check('quotations_currency_code_format', sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
    check('quotations_lead_time_range', sql`${t.leadTimeDays} BETWEEN 0 AND 365`),
    check('quotations_total_non_negative', sql`${t.total} >= 0`),
    check('quotations_submitted_by_with_time', sql`(${t.submittedAt} IS NULL) = (${t.submittedByUserId} IS NULL)`),
    check('quotations_submitted_states', sql`CASE ${t.status} WHEN 'draft' THEN ${t.submittedAt} IS NULL WHEN 'withdrawn' THEN true ELSE ${t.submittedAt} IS NOT NULL END`),
    check(
      'quotations_withdraw_consistent',
      sql`(${t.status} = 'withdrawn') = (${t.withdrawnAt} IS NOT NULL AND ${t.withdrawnByUserId} IS NOT NULL AND ${t.withdrawReason} IS NOT NULL)`,
    ),
    check('quotations_withdraw_reason_length', sql`${t.withdrawReason} IS NULL OR char_length(${t.withdrawReason}) BETWEEN 1 AND 500`),
    // One live quotation per supplier per RFQ, also under concurrency (P6-AC2).
    uniqueIndex('quotations_one_live_per_supplier').on(t.rfqId, t.supplierId).where(sql`${t.status} <> 'withdrawn'`),
    index('quotations_rfq_idx').on(t.rfqId),
    index('quotations_supplier_idx').on(t.supplierId),
  ],
);

export const quotationLines = pgTable(
  'quotation_lines',
  {
    id: uuid('id').default(sql`uuidv7()`).primaryKey(),
    quotationId: uuid('quotation_id')
      .notNull()
      .references(() => quotations.id, { onDelete: 'restrict' }),
    rfqLineId: uuid('rfq_line_id')
      .notNull()
      .references(() => rfqLines.id, { onDelete: 'restrict' }),
    /** Copied from the RFQ line, never from input. */
    quantity: numeric('quantity', { precision: 18, scale: 3 }).notNull(),
    unitPrice: numeric('unit_price', { precision: 20, scale: 4 }).notNull(),
    /** Server-computed: round(quantity × unit price, currency scale). */
    lineTotal: numeric('line_total', { precision: 20, scale: 4 }).notNull(),
  },
  (t) => [
    check('quotation_lines_quantity_positive', sql`${t.quantity} > 0`),
    check('quotation_lines_price_non_negative', sql`${t.unitPrice} >= 0`),
    check('quotation_lines_total_non_negative', sql`${t.lineTotal} >= 0`),
    uniqueIndex('quotation_lines_quotation_rfq_line').on(t.quotationId, t.rfqLineId),
    index('quotation_lines_rfq_line_idx').on(t.rfqLineId),
  ],
);
