import { z } from 'zod';
import { defineAuditPolicy } from '@/modules/audit';
import { dec, moneyInput, percentInput, quantityInput } from '@/shared/decimal/decimal';
import { MAX_PO_LINES, MAX_REASON, MAX_TERMS } from '../domain/purchase-order';

/*
 * What a buyer enters for a purchase order (US-PO-01). Number, status, totals, line amounts,
 * descriptions, units, currency, department, and who did what are never accepted: a client that
 * sends them gets VALIDATION_FAILED (strict schemas). Unit prices exclude tax.
 */

const blankToNull = (value: unknown) => (value === undefined || (typeof value === 'string' && value.trim() === '') ? null : value);

const lineInput = z.strictObject({
  requisitionLineId: z.uuid(),
  /** Required when the PO has a quotation, refused when it has none (checked by the command). */
  quotationLineId: z.uuid().nullable().optional(),
  quantity: quantityInput,
  /** Required without a quotation; with one, the quoted price is used and this is ignored. */
  unitPrice: moneyInput.optional(),
  taxRatePct: percentInput,
});

export const purchaseOrderFields = {
  paymentTerms: z.preprocess(blankToNull, z.string().trim().max(MAX_TERMS).nullable()),
  deliveryAddress: z.preprocess(blankToNull, z.string().trim().max(MAX_TERMS).nullable()),
  expectedDeliveryDate: z.preprocess(blankToNull, z.iso.date('Enter a date as YYYY-MM-DD').nullable()),
  lines: z
    .array(lineInput)
    .min(1, 'Order at least one line')
    .max(MAX_PO_LINES, `At most ${MAX_PO_LINES} lines`)
    .superRefine((lines, ctx) => {
      const seen = new Set<string>();
      lines.forEach((line, i) => {
        if (seen.has(line.requisitionLineId)) ctx.addIssue({ code: 'custom', path: [i, 'requisitionLineId'], message: 'This line is ordered twice' });
        seen.add(line.requisitionLineId);
      });
    }),
};

export type PurchaseOrderLineInput = z.output<typeof lineInput>;

export const versionField = z.number().int().min(1).max(2_147_483_647);
export const reasonField = z.string().trim().min(1, 'Give a reason (required)').max(MAX_REASON);
/** Closing a fully received order needs no reason (PO-T07); blank means none. */
export const optionalReasonField = z.preprocess(blankToNull, z.string().trim().max(MAX_REASON).nullable());

/** "1. 4 pcs Office chair @ 175, tax 11% = 777.00 (requisition line 2)": numbers without trailing zeros, totals at the currency scale. */
export function purchaseOrderLineSummary(
  lineNo: number,
  line: { quantity: string; uom: string; description: string; unitPrice: string; taxRatePct: string; lineTotal: string; requisitionLineNo: number },
): string {
  return `${lineNo}. ${dec(line.quantity).toString()} ${line.uom} ${line.description} @ ${dec(line.unitPrice).toString()}, tax ${dec(line.taxRatePct).toString()}% = ${line.lineTotal} (requisition line ${line.requisitionLineNo})`;
}

export const purchaseOrderAudit = defineAuditPolicy<{
  number: string;
  requisitionNumber: string;
  supplier: string;
  quotation: string | null;
  paymentTerms: string | null;
  deliveryAddress: string | null;
  expectedDeliveryDate: string | null;
  currencyCode: string;
  lines: string[];
  subtotal: string;
  taxTotal: string;
  total: string;
  status: string;
  approvalReasons: string[];
  approvalThreshold: string | null;
  priceTolerancePct: string;
  round: number;
  approvalRoute: string[];
  receiptTolerancePct: string;
  maxReceivable: string[];
  released: string[];
}>({
  entityType: 'purchase_order',
  fields: [
    'number',
    'requisitionNumber',
    'supplier',
    'quotation',
    'paymentTerms',
    'deliveryAddress',
    'expectedDeliveryDate',
    'currencyCode',
    'lines',
    'subtotal',
    'taxTotal',
    'total',
    'status',
    'approvalReasons',
    'approvalThreshold',
    'priceTolerancePct',
    'round',
    'approvalRoute',
    'receiptTolerancePct',
    'maxReceivable',
    'released',
  ],
});
