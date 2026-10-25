import { sql } from 'drizzle-orm';
import { check, index, integer, numeric, pgTable, primaryKey, smallint, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from '../../identity/tables';
import { purchaseRequisitions, requisitionLines } from '../../requisitions/tables';
import { suppliers } from '../../suppliers/tables';

/*
 * Requests for quotation (docs/schema.md, Phase 6a). Quotations and the award columns arrive
 * with Phase 6b. Declarations only (no I/O, no `server-only`), so drizzle-kit can load this file.
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

/** Invited suppliers. Quotations (Phase 6b) can come only from these. */
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
