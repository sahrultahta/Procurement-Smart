import { sql } from 'drizzle-orm';
import { check, date, index, integer, numeric, pgTable, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { users } from '../../identity/tables';
import { purchaseOrderLines, purchaseOrders } from '../../purchasing/tables';

/*
 * Goods receipts (docs/schema.md, Phase 8). Declarations only (no I/O, no `server-only`), so
 * drizzle-kit can load this file.
 */
const tz = { withTimezone: true, mode: 'date' } as const;

export const goodsReceipts = pgTable(
  'goods_receipts',
  {
    id: uuid('id').default(sql`uuidv7()`).primaryKey(),
    number: text('number').notNull().unique(),
    purchaseOrderId: uuid('purchase_order_id')
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull().default('receipt'),
    /** The posted receipt a reversal undoes; unique, so a receipt is reversed at most once (GR-I3). */
    reversesGoodsReceiptId: uuid('reverses_goods_receipt_id')
      .unique()
      .references((): AnyPgColumn => goodsReceipts.id, { onDelete: 'restrict' }),
    status: text('status').notNull().default('draft'),
    /** The org date the goods arrived; for a reversal, the org date it was recorded. */
    receivedOn: date('received_on', { mode: 'string' }).notNull(),
    deliveryNoteRef: text('delivery_note_ref'),
    notes: text('notes'),
    /** Why a reversal was made (required for reversals only). */
    reason: text('reason'),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    postedAt: timestamp('posted_at', tz),
    postedByUserId: uuid('posted_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    cancelledAt: timestamp('cancelled_at', tz),
    cancelledByUserId: uuid('cancelled_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    cancelReason: text('cancel_reason'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    check('goods_receipts_number_format', sql`${t.number} ~ '^GR-[0-9]{4}-[0-9]{6}$'`),
    check('goods_receipts_kind', sql`${t.kind} IN ('receipt', 'reversal')`),
    check('goods_receipts_status', sql`${t.status} IN ('draft', 'posted', 'cancelled')`),
    check('goods_receipts_reversal_reference', sql`(${t.kind} = 'reversal') = (${t.reversesGoodsReceiptId} IS NOT NULL)`),
    check('goods_receipts_reversal_reason', sql`(${t.kind} = 'reversal') = (${t.reason} IS NOT NULL)`),
    check('goods_receipts_reason_length', sql`${t.reason} IS NULL OR char_length(${t.reason}) BETWEEN 1 AND 500`),
    check('goods_receipts_reversal_never_cancelled', sql`${t.kind} = 'receipt' OR ${t.status} <> 'cancelled'`),
    check('goods_receipts_delivery_note_ref_length', sql`${t.deliveryNoteRef} IS NULL OR char_length(${t.deliveryNoteRef}) BETWEEN 1 AND 100`),
    check('goods_receipts_notes_length', sql`${t.notes} IS NULL OR char_length(${t.notes}) BETWEEN 1 AND 1000`),
    check('goods_receipts_posted_fields', sql`(${t.status} = 'posted') = (${t.postedAt} IS NOT NULL) AND (${t.postedAt} IS NULL) = (${t.postedByUserId} IS NULL)`),
    check(
      'goods_receipts_cancelled_fields',
      sql`(${t.status} = 'cancelled') = (${t.cancelledAt} IS NOT NULL) AND (${t.cancelledAt} IS NULL) = (${t.cancelledByUserId} IS NULL)`,
    ),
    check('goods_receipts_cancel_reason', sql`${t.cancelReason} IS NULL OR (${t.status} = 'cancelled' AND char_length(${t.cancelReason}) BETWEEN 1 AND 500)`),
    index('goods_receipts_purchase_order_idx').on(t.purchaseOrderId),
    index('goods_receipts_status_idx').on(t.status),
  ],
);

export const goodsReceiptLines = pgTable(
  'goods_receipt_lines',
  {
    id: uuid('id').default(sql`uuidv7()`).primaryKey(),
    goodsReceiptId: uuid('goods_receipt_id')
      .notNull()
      .references(() => goodsReceipts.id, { onDelete: 'restrict' }),
    purchaseOrderLineId: uuid('purchase_order_line_id')
      .notNull()
      .references(() => purchaseOrderLines.id, { onDelete: 'restrict' }),
    quantity: numeric('quantity', { precision: 18, scale: 3 }).notNull(),
    note: text('note'),
  },
  (t) => [
    check('goods_receipt_lines_quantity_positive', sql`${t.quantity} > 0`),
    check('goods_receipt_lines_note_length', sql`${t.note} IS NULL OR char_length(${t.note}) BETWEEN 1 AND 500`),
    uniqueIndex('goods_receipt_lines_receipt_po_line').on(t.goodsReceiptId, t.purchaseOrderLineId),
    index('goods_receipt_lines_po_line_idx').on(t.purchaseOrderLineId),
  ],
);
