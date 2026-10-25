import { z } from 'zod';
import { defineAuditPolicy } from '@/modules/audit';
import { quantityInput } from '@/shared/decimal/decimal';
import { MAX_INVITED_SUPPLIERS, MAX_RFQ_LINES } from '../domain/rfq';

/*
 * What a buyer enters for an RFQ (US-SRC-01). Number, status, descriptions, units, creator,
 * and times are never accepted: a client that sends them gets VALIDATION_FAILED.
 */

const lineInput = z.strictObject({ requisitionLineId: z.uuid(), quantity: quantityInput });

export const rfqFields = {
  title: z.string().trim().min(1, 'Enter a title').max(200),
  /** A wall-clock time in the organization's time zone, as an HTML datetime-local value. */
  responseDueAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Enter a date and time'),
  lines: z
    .array(lineInput)
    .min(1, 'Choose at least one requisition line')
    .max(MAX_RFQ_LINES, `At most ${MAX_RFQ_LINES} lines`)
    .superRefine((lines, ctx) => {
      const seen = new Set<string>();
      lines.forEach((line, i) => {
        if (seen.has(line.requisitionLineId)) ctx.addIssue({ code: 'custom', path: [i, 'requisitionLineId'], message: 'This line is listed twice' });
        seen.add(line.requisitionLineId);
      });
    }),
  supplierIds: z
    .array(z.uuid())
    .max(MAX_INVITED_SUPPLIERS, `At most ${MAX_INVITED_SUPPLIERS} suppliers`)
    .refine((ids) => new Set(ids).size === ids.length, 'A supplier is listed twice'),
};

export const versionField = z.number().int().min(1).max(2_147_483_647);
export const reasonField = z.string().trim().min(1, 'Give a reason (required)').max(500);

export const rfqAudit = defineAuditPolicy<{
  number: string;
  requisitionNumber: string;
  title: string;
  responseDueAt: string;
  lines: string[];
  suppliers: string[];
  status: string;
}>({
  entityType: 'rfq',
  fields: ['number', 'requisitionNumber', 'title', 'responseDueAt', 'lines', 'suppliers', 'status'],
});
