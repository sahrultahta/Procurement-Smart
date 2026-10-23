import { z } from 'zod';
import { defineAuditPolicy } from '@/modules/audit';
import { dec, moneyInput, quantityInput } from '@/shared/decimal/decimal';
import { MAX_LINES } from '../domain/requisition';

/*
 * What a requester enters (US-PR-01). Totals, number, department, currency, and status
 * are never accepted: a client that sends them gets VALIDATION_FAILED (strict schemas).
 */

const blankToNull = (value: unknown) => (value === undefined || (typeof value === 'string' && value.trim() === '') ? null : value);

export const lineInput = z.strictObject({
  description: z.string().trim().min(1, 'Describe the item').max(500),
  quantity: quantityInput,
  uom: z.string().trim().min(1, 'Enter a unit, e.g. pcs').max(16),
  estimatedUnitPrice: moneyInput,
});

export const requisitionFields = {
  title: z.string().trim().min(1, 'Enter a title').max(200),
  justification: z.preprocess(blankToNull, z.string().trim().max(2000).nullable()),
  neededBy: z.iso.date('Enter a date as YYYY-MM-DD'),
  lines: z.array(lineInput).min(1, 'Add at least one line').max(MAX_LINES, `At most ${MAX_LINES} lines`),
};

export const versionField = z.number().int().min(1).max(2_147_483_647);

type LineInput = z.output<typeof lineInput>;

/** "2 pcs Printer paper @ 4.5": numbers without trailing zeros, so input and stored rows compare equal. */
export function lineSummaries(lines: readonly Pick<LineInput, 'description' | 'quantity' | 'uom' | 'estimatedUnitPrice'>[]): string[] {
  return lines.map(
    (line, i) => `${i + 1}. ${dec(line.quantity).toString()} ${line.uom} ${line.description} @ ${dec(line.estimatedUnitPrice).toString()}`,
  );
}

export const requisitionAudit = defineAuditPolicy<{
  number: string;
  title: string;
  justification: string | null;
  neededBy: string;
  estimatedTotal: string;
  currencyCode: string;
  departmentCode: string;
  lines: string[];
  status: string;
}>({
  entityType: 'requisition',
  fields: ['number', 'title', 'justification', 'neededBy', 'estimatedTotal', 'currencyCode', 'departmentCode', 'lines', 'status'],
});
