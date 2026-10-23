import { sql } from 'drizzle-orm';
import { check, date, index, integer, numeric, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { departments, users } from '../../identity/tables';

/*
 * Purchase requisitions (docs/schema.md). Phase 5a: drafting. The approval columns
 * (current request, submitted/approved times, close fields) arrive with Phase 5b.
 * Declarations only (no I/O, no `server-only`), so drizzle-kit can load this file.
 */
const tz = { withTimezone: true, mode: 'date' } as const;

export const purchaseRequisitions = pgTable(
  'purchase_requisitions',
  {
    id: uuid('id').default(sql`uuidv7()`).primaryKey(),
    number: text('number').notNull().unique(),
    requesterUserId: uuid('requester_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Copied from the requester's profile at create (US-PR-01), never from input. */
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    justification: text('justification'),
    neededBy: date('needed_by', { mode: 'string' }).notNull(),
    /** The org currency when the requisition was created. */
    currencyCode: text('currency_code').notNull(),
    currencyScale: smallint('currency_scale').notNull(),
    /** Server-computed sum of the rounded line totals (ADR 0007). */
    estimatedTotal: numeric('estimated_total', { precision: 20, scale: 4 }).notNull(),
    status: text('status').notNull().default('draft'),
    cancelledAt: timestamp('cancelled_at', tz),
    cancelledByUserId: uuid('cancelled_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    cancelReason: text('cancel_reason'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    check('purchase_requisitions_number_format', sql`${t.number} ~ '^PR-[0-9]{4}-[0-9]{6}$'`),
    check('purchase_requisitions_title_length', sql`char_length(${t.title}) BETWEEN 1 AND 200`),
    check('purchase_requisitions_justification_length', sql`${t.justification} IS NULL OR char_length(${t.justification}) <= 2000`),
    check('purchase_requisitions_currency_code_format', sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
    check('purchase_requisitions_currency_scale_range', sql`${t.currencyScale} BETWEEN 0 AND 4`),
    check('purchase_requisitions_total_non_negative', sql`${t.estimatedTotal} >= 0`),
    check(
      'purchase_requisitions_status',
      sql`${t.status} IN ('draft', 'pending_approval', 'returned', 'approved', 'rejected', 'cancelled', 'closed')`,
    ),
    check(
      'purchase_requisitions_cancel_consistent',
      sql`(${t.status} = 'cancelled') = (${t.cancelledAt} IS NOT NULL AND ${t.cancelledByUserId} IS NOT NULL)`,
    ),
    check('purchase_requisitions_cancel_reason_length', sql`${t.cancelReason} IS NULL OR char_length(${t.cancelReason}) <= 500`),
    index('purchase_requisitions_requester_status_idx').on(t.requesterUserId, t.status),
    index('purchase_requisitions_department_status_idx').on(t.departmentId, t.status),
  ],
);

export const requisitionLines = pgTable(
  'requisition_lines',
  {
    id: uuid('id').default(sql`uuidv7()`).primaryKey(),
    requisitionId: uuid('requisition_id')
      .notNull()
      .references(() => purchaseRequisitions.id, { onDelete: 'restrict' }),
    lineNo: smallint('line_no').notNull(),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 18, scale: 3 }).notNull(),
    uom: text('uom').notNull(),
    estimatedUnitPrice: numeric('estimated_unit_price', { precision: 20, scale: 4 }).notNull(),
    /** Server-computed: round(quantity × unit price, currency scale). */
    lineTotal: numeric('line_total', { precision: 20, scale: 4 }).notNull(),
    /** Changed only by purchase-order commands (Phase 7). PR-I1. */
    orderedQty: numeric('ordered_qty', { precision: 18, scale: 3 }).notNull().default('0'),
  },
  (t) => [
    check('requisition_lines_line_no', sql`${t.lineNo} BETWEEN 1 AND 200`),
    check('requisition_lines_description_length', sql`char_length(${t.description}) BETWEEN 1 AND 500`),
    check('requisition_lines_quantity_positive', sql`${t.quantity} > 0`),
    check('requisition_lines_uom_length', sql`char_length(${t.uom}) BETWEEN 1 AND 16`),
    check('requisition_lines_price_non_negative', sql`${t.estimatedUnitPrice} >= 0`),
    check('requisition_lines_total_non_negative', sql`${t.lineTotal} >= 0`),
    // PR-I1: never more ordered than requested (backstop for OVER_ORDER, Phase 7).
    check('requisition_lines_ordered_qty_range', sql`${t.orderedQty} >= 0 AND ${t.orderedQty} <= ${t.quantity}`),
    uniqueIndex('requisition_lines_requisition_line_no').on(t.requisitionId, t.lineNo),
  ],
);
