import { sql } from 'drizzle-orm';
import { check, date, index, integer, numeric, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { approvalRequests } from '../../approvals/tables';
import { departments, users } from '../../identity/tables';
import { purchaseRequisitions, requisitionLines } from '../../requisitions/tables';
import { quotationLines, quotations } from '../../sourcing/tables';
import { suppliers } from '../../suppliers/tables';

/*
 * Purchase orders (docs/schema.md, Phase 7). Declarations only (no I/O, no `server-only`), so
 * drizzle-kit can load this file.
 */
const tz = { withTimezone: true, mode: 'date' } as const;

export const purchaseOrders = pgTable(
  'purchase_orders',
  {
    id: uuid('id').default(sql`uuidv7()`).primaryKey(),
    number: text('number').notNull().unique(),
    /** One approved requisition per PO; every line is one of its lines. */
    requisitionId: uuid('requisition_id')
      .notNull()
      .references(() => purchaseRequisitions.id, { onDelete: 'restrict' }),
    /** The requisition's department, copied at create: it routes the approval and scopes who reads the PO. */
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'restrict' }),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),
    /** The awarded quotation the prices come from, if any. */
    quotationId: uuid('quotation_id').references(() => quotations.id, { onDelete: 'restrict' }),
    status: text('status').notNull().default('draft'),
    /** The requisition's currency, never from input. */
    currencyCode: text('currency_code').notNull(),
    currencyScale: smallint('currency_scale').notNull(),
    /** Server-computed sums of the rounded line values (ADR 0007). */
    subtotal: numeric('subtotal', { precision: 20, scale: 4 }).notNull(),
    taxTotal: numeric('tax_total', { precision: 20, scale: 4 }).notNull(),
    total: numeric('total', { precision: 20, scale: 4 }).notNull(),
    paymentTerms: text('payment_terms'),
    deliveryAddress: text('delivery_address'),
    expectedDeliveryDate: date('expected_delivery_date', { mode: 'string' }),
    /** The latest submission: why approval was needed (empty: it was not), and the rule as it stood. */
    approvalReasons: text('approval_reasons').array().notNull().default(sql`'{}'::text[]`),
    approvalThreshold: numeric('approval_threshold', { precision: 20, scale: 4 }),
    priceTolerancePct: numeric('price_tolerance_pct', { precision: 7, scale: 4 }),
    /** The latest approval round, if the PO ever needed one. */
    currentApprovalRequestId: uuid('current_approval_request_id').references(() => approvalRequests.id, { onDelete: 'restrict' }),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    submittedAt: timestamp('submitted_at', tz),
    submittedByUserId: uuid('submitted_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    approvedAt: timestamp('approved_at', tz),
    issuedAt: timestamp('issued_at', tz),
    issuedByUserId: uuid('issued_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    /** `over_receipt_tolerance_pct` when the PO was issued; it fixed each line's `max_receivable_qty`. */
    receiptTolerancePct: numeric('receipt_tolerance_pct', { precision: 7, scale: 4 }),
    closedAt: timestamp('closed_at', tz),
    closedByUserId: uuid('closed_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    closeReason: text('close_reason'),
    cancelledAt: timestamp('cancelled_at', tz),
    cancelledByUserId: uuid('cancelled_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    cancelReason: text('cancel_reason'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    check('purchase_orders_number_format', sql`${t.number} ~ '^PO-[0-9]{4}-[0-9]{6}$'`),
    check(
      'purchase_orders_status',
      sql`${t.status} IN ('draft', 'pending_approval', 'approved', 'issued', 'partially_received', 'received', 'closed', 'rejected', 'cancelled')`,
    ),
    check('purchase_orders_currency_code_format', sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
    check('purchase_orders_currency_scale_range', sql`${t.currencyScale} BETWEEN 0 AND 4`),
    check('purchase_orders_totals_non_negative', sql`${t.subtotal} >= 0 AND ${t.taxTotal} >= 0 AND ${t.total} >= 0`),
    check('purchase_orders_total_sum', sql`${t.total} = ${t.subtotal} + ${t.taxTotal}`),
    check('purchase_orders_payment_terms_length', sql`${t.paymentTerms} IS NULL OR char_length(${t.paymentTerms}) BETWEEN 1 AND 500`),
    check('purchase_orders_delivery_address_length', sql`${t.deliveryAddress} IS NULL OR char_length(${t.deliveryAddress}) BETWEEN 1 AND 500`),
    check(
      'purchase_orders_approval_reasons_known',
      sql`${t.approvalReasons} <@ ARRAY['AMOUNT_THRESHOLD', 'NO_THRESHOLD', 'PRICE_VARIANCE', 'TOTAL_VARIANCE']::text[]`,
    ),
    check('purchase_orders_approval_threshold_non_negative', sql`${t.approvalThreshold} IS NULL OR ${t.approvalThreshold} >= 0`),
    check('purchase_orders_price_tolerance_range', sql`${t.priceTolerancePct} IS NULL OR ${t.priceTolerancePct} BETWEEN 0 AND 100`),
    // Submitted at least once: who and when, and the rule it was checked against.
    check('purchase_orders_submitted_by_with_time', sql`(${t.submittedAt} IS NULL) = (${t.submittedByUserId} IS NULL)`),
    check('purchase_orders_submitted_rule', sql`(${t.submittedAt} IS NULL) = (${t.priceTolerancePct} IS NULL)`),
    check('purchase_orders_threshold_with_submission', sql`${t.approvalThreshold} IS NULL OR ${t.submittedAt} IS NOT NULL`),
    check('purchase_orders_submitted_states', sql`${t.status} IN ('draft', 'cancelled') OR ${t.submittedAt} IS NOT NULL`),
    // Waiting for or refused by an approval round: there is one, and a reason for it.
    check(
      'purchase_orders_approval_round_states',
      sql`${t.status} NOT IN ('pending_approval', 'rejected') OR (${t.currentApprovalRequestId} IS NOT NULL AND cardinality(${t.approvalReasons}) > 0)`,
    ),
    check(
      'purchase_orders_approved_states',
      sql`CASE WHEN ${t.status} IN ('approved', 'issued', 'partially_received', 'received', 'closed') THEN ${t.approvedAt} IS NOT NULL WHEN ${t.status} = 'cancelled' THEN true ELSE ${t.approvedAt} IS NULL END`,
    ),
    check('purchase_orders_issued_fields', sql`(${t.issuedAt} IS NULL) = (${t.issuedByUserId} IS NULL) AND (${t.issuedAt} IS NULL) = (${t.receiptTolerancePct} IS NULL)`),
    check(
      'purchase_orders_issued_states',
      sql`CASE WHEN ${t.status} IN ('issued', 'partially_received', 'received', 'closed') THEN ${t.issuedAt} IS NOT NULL WHEN ${t.status} = 'cancelled' THEN true ELSE ${t.issuedAt} IS NULL END`,
    ),
    check('purchase_orders_receipt_tolerance_range', sql`${t.receiptTolerancePct} IS NULL OR ${t.receiptTolerancePct} BETWEEN 0 AND 100`),
    check('purchase_orders_close_consistent', sql`(${t.status} = 'closed') = (${t.closedAt} IS NOT NULL AND ${t.closedByUserId} IS NOT NULL)`),
    check('purchase_orders_close_reason', sql`${t.closeReason} IS NULL OR (${t.status} = 'closed' AND char_length(${t.closeReason}) BETWEEN 1 AND 500)`),
    check(
      'purchase_orders_cancel_consistent',
      sql`(${t.status} = 'cancelled') = (${t.cancelledAt} IS NOT NULL AND ${t.cancelledByUserId} IS NOT NULL AND ${t.cancelReason} IS NOT NULL)`,
    ),
    check('purchase_orders_cancel_reason_length', sql`${t.cancelReason} IS NULL OR char_length(${t.cancelReason}) BETWEEN 1 AND 500`),
    index('purchase_orders_requisition_idx').on(t.requisitionId),
    index('purchase_orders_supplier_idx').on(t.supplierId),
    index('purchase_orders_quotation_idx').on(t.quotationId),
    index('purchase_orders_department_status_idx').on(t.departmentId, t.status),
    index('purchase_orders_status_idx').on(t.status),
  ],
);

export const purchaseOrderLines = pgTable(
  'purchase_order_lines',
  {
    id: uuid('id').default(sql`uuidv7()`).primaryKey(),
    purchaseOrderId: uuid('purchase_order_id')
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'restrict' }),
    lineNo: smallint('line_no').notNull(),
    /** Every PO line traces to an approved need. */
    requisitionLineId: uuid('requisition_line_id')
      .notNull()
      .references(() => requisitionLines.id, { onDelete: 'restrict' }),
    /** The quotation line the price comes from, when the PO has a quotation. */
    quotationLineId: uuid('quotation_line_id').references(() => quotationLines.id, { onDelete: 'restrict' }),
    /** Copied from the requisition line, never from input. */
    description: text('description').notNull(),
    uom: text('uom').notNull(),
    quantity: numeric('quantity', { precision: 18, scale: 3 }).notNull(),
    unitPrice: numeric('unit_price', { precision: 20, scale: 4 }).notNull(),
    taxRatePct: numeric('tax_rate_pct', { precision: 7, scale: 4 }).notNull(),
    /** Server-computed (ADR 0007). */
    lineSubtotal: numeric('line_subtotal', { precision: 20, scale: 4 }).notNull(),
    lineTax: numeric('line_tax', { precision: 20, scale: 4 }).notNull(),
    lineTotal: numeric('line_total', { precision: 20, scale: 4 }).notNull(),
    /** Posted goods receipts add to it and their reversals take it back (GR-I1); nothing else moves it. */
    receivedQty: numeric('received_qty', { precision: 18, scale: 3 }).notNull().default('0'),
    /** Fixed when the PO is issued: floor3(quantity × (1 + receipt tolerance / 100)). */
    maxReceivableQty: numeric('max_receivable_qty', { precision: 18, scale: 3 }),
  },
  (t) => [
    check('purchase_order_lines_line_no', sql`${t.lineNo} BETWEEN 1 AND 200`),
    check('purchase_order_lines_description_length', sql`char_length(${t.description}) BETWEEN 1 AND 500`),
    check('purchase_order_lines_uom_length', sql`char_length(${t.uom}) BETWEEN 1 AND 16`),
    check('purchase_order_lines_quantity_positive', sql`${t.quantity} > 0`),
    check('purchase_order_lines_price_non_negative', sql`${t.unitPrice} >= 0`),
    check('purchase_order_lines_tax_rate_range', sql`${t.taxRatePct} BETWEEN 0 AND 100`),
    check('purchase_order_lines_amounts_non_negative', sql`${t.lineSubtotal} >= 0 AND ${t.lineTax} >= 0 AND ${t.lineTotal} >= 0`),
    check('purchase_order_lines_total_sum', sql`${t.lineTotal} = ${t.lineSubtotal} + ${t.lineTax}`),
    // Over-receipt backstop for goods receipts (ADR 0008 C3, GR-I2).
    check('purchase_order_lines_received_non_negative', sql`${t.receivedQty} >= 0`),
    check('purchase_order_lines_max_receivable', sql`${t.maxReceivableQty} IS NULL OR ${t.maxReceivableQty} >= ${t.quantity}`),
    check(
      'purchase_order_lines_received_within_max',
      sql`${t.receivedQty} = 0 OR (${t.maxReceivableQty} IS NOT NULL AND ${t.receivedQty} <= ${t.maxReceivableQty})`,
    ),
    uniqueIndex('purchase_order_lines_po_line_no').on(t.purchaseOrderId, t.lineNo),
    uniqueIndex('purchase_order_lines_po_requisition_line').on(t.purchaseOrderId, t.requisitionLineId),
    index('purchase_order_lines_requisition_line_idx').on(t.requisitionLineId),
    index('purchase_order_lines_quotation_line_idx').on(t.quotationLineId),
  ],
);
