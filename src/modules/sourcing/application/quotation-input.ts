import { z } from 'zod';
import { defineAuditPolicy } from '@/modules/audit';
import { dec, moneyInput } from '@/shared/decimal/decimal';
import { MAX_JUSTIFICATION, MAX_LEAD_TIME_DAYS, MAX_SUPPLIER_REFERENCE } from '../domain/quotation';
import { MAX_RFQ_LINES } from '../domain/rfq';

/*
 * What a buyer enters for a quotation (US-SRC-02) and an award (US-SRC-03). Quantities, totals,
 * currency, status, and who did what are never accepted: a client that sends them gets
 * VALIDATION_FAILED (strict schemas). Prices exclude tax.
 */

const blankToNull = (value: unknown) => (value === undefined || (typeof value === 'string' && value.trim() === '') ? null : value);

const priceInput = z.strictObject({ rfqLineId: z.uuid(), unitPrice: moneyInput });

export const quotationFields = {
  supplierReference: z.preprocess(blankToNull, z.string().trim().max(MAX_SUPPLIER_REFERENCE).nullable()),
  validUntil: z.iso.date('Enter a date as YYYY-MM-DD'),
  leadTimeDays: z.number().int('Enter whole days').min(0, 'Cannot be negative').max(MAX_LEAD_TIME_DAYS, `At most ${MAX_LEAD_TIME_DAYS} days`),
  /** One unit price per RFQ line; the command checks that every line is priced. */
  lines: z
    .array(priceInput)
    .min(1, 'Enter a unit price for every line')
    .max(MAX_RFQ_LINES, `At most ${MAX_RFQ_LINES} lines`)
    .superRefine((lines, ctx) => {
      const seen = new Set<string>();
      lines.forEach((line, i) => {
        if (seen.has(line.rfqLineId)) ctx.addIssue({ code: 'custom', path: [i, 'rfqLineId'], message: 'This line is priced twice' });
        seen.add(line.rfqLineId);
      });
    }),
};

/** Optional: the award needs it only when fewer valid quotations than the minimum arrived, or for a non-lowest one. */
export const justificationField = z.preprocess(blankToNull, z.string().trim().max(MAX_JUSTIFICATION).nullable());

/** The reason recorded on drafts discarded by closing their RFQ. */
export const DISCARDED_AT_CLOSE = 'Not submitted before the RFQ was closed';

/** "1. 4 pcs Ergonomic office chair @ 175 = 700.00": prices without trailing zeros, totals at the currency scale. */
export function quotationLineSummary(lineNo: number, line: { quantity: string; uom: string; description: string; unitPrice: string; lineTotal: string }): string {
  return `${lineNo}. ${dec(line.quantity).toString()} ${line.uom} ${line.description} @ ${dec(line.unitPrice).toString()} = ${line.lineTotal}`;
}

export const quotationAudit = defineAuditPolicy<{
  rfqNumber: string;
  supplier: string;
  supplierReference: string | null;
  currencyCode: string;
  validUntil: string;
  leadTimeDays: number;
  lines: string[];
  total: string;
  status: string;
  late: boolean;
}>({
  entityType: 'quotation',
  fields: ['rfqNumber', 'supplier', 'supplierReference', 'currencyCode', 'validUntil', 'leadTimeDays', 'lines', 'total', 'status', 'late'],
});
