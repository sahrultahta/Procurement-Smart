import { z } from 'zod';
import { defineAuditPolicy } from '@/modules/audit';
import { dec, quantityInput } from '@/shared/decimal/decimal';
import { MAX_DELIVERY_NOTE_REF, MAX_GR_LINES, MAX_LINE_NOTE, MAX_NOTES, MAX_REASON } from '../domain/goods-receipt';

/*
 * What a receiver enters for a goods receipt (US-GR-01). Number, kind, status, what the order
 * line ordered or received before, and who did what are never accepted: a client that sends them
 * gets VALIDATION_FAILED (strict schemas).
 */

const blankToNull = (value: unknown) => (value === undefined || (typeof value === 'string' && value.trim() === '') ? null : value);

const lineInput = z.strictObject({
  purchaseOrderLineId: z.uuid(),
  quantity: quantityInput,
  note: z.preprocess(blankToNull, z.string().trim().max(MAX_LINE_NOTE).nullable()),
});

export const goodsReceiptFields = {
  receivedOn: z.iso.date('Enter a date as YYYY-MM-DD'),
  deliveryNoteRef: z.preprocess(blankToNull, z.string().trim().max(MAX_DELIVERY_NOTE_REF).nullable()),
  notes: z.preprocess(blankToNull, z.string().trim().max(MAX_NOTES).nullable()),
  lines: z
    .array(lineInput)
    .min(1, 'Receive at least one line')
    .max(MAX_GR_LINES, `At most ${MAX_GR_LINES} lines`)
    .superRefine((lines, ctx) => {
      const seen = new Set<string>();
      lines.forEach((line, i) => {
        if (seen.has(line.purchaseOrderLineId)) ctx.addIssue({ code: 'custom', path: [i, 'purchaseOrderLineId'], message: 'This line is received twice' });
        seen.add(line.purchaseOrderLineId);
      });
    }),
};

export type GoodsReceiptLineInput = z.output<typeof lineInput>;

export const versionField = z.number().int().min(1).max(2_147_483_647);
export const reasonField = z.string().trim().min(1, 'Give a reason (required)').max(MAX_REASON);
/** Cancelling a draft needs no reason (GR-T03); blank means none. */
export const optionalReasonField = z.preprocess(blankToNull, z.string().trim().max(MAX_REASON).nullable());

/** "1. 4 pcs Ergonomic office chair (2 boxes dented)": the order line's number, the quantity without trailing zeros. */
export function goodsReceiptLineSummary(line: { lineNo: number; quantity: string; uom: string; description: string; note: string | null }): string {
  return `${line.lineNo}. ${dec(line.quantity).toString()} ${line.uom} ${line.description}${line.note ? ` (${line.note})` : ''}`;
}

export const goodsReceiptAudit = defineAuditPolicy<{
  number: string;
  purchaseOrder: string;
  kind: string;
  reverses: string;
  reversedBy: string;
  receivedOn: string;
  deliveryNoteRef: string | null;
  notes: string | null;
  lines: string[];
  status: string;
  purchaseOrderStatus: string;
}>({
  entityType: 'goods_receipt',
  fields: ['number', 'purchaseOrder', 'kind', 'reverses', 'reversedBy', 'receivedOn', 'deliveryNoteRef', 'notes', 'lines', 'status', 'purchaseOrderStatus'],
});
