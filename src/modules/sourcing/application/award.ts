import 'server-only';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { auditChanges, recordAuditEvent } from '@/modules/audit';
import { findSourcingRules, todayIn } from '@/modules/organization';
import { findSuppliersByIds } from '@/modules/suppliers';
import { defineCommand } from '@/shared/application/runner';
import { dec, toFixedScale } from '@/shared/decimal/decimal';
import { fail, failBusinessRule } from '@/shared/result';
import { compareQuotations, justificationReasons, type Comparison, type ComparedQuotation, type JustificationReason } from '../domain/comparison';
import type { RfqStatus } from '../domain/rfq';
import { findQuotationLines, lockQuotations, updateQuotation, type QuotationRow } from '../infrastructure/quotation-repository';
import { findRfqLines, updateRfq } from '../infrastructure/rfq-repository';
import { justificationField, quotationAudit } from './quotation-input';
import { rfqAudit, versionField } from './rfq-input';
import { assertRequisitionApproved, assertRfqTransition, assertRfqVersion, lockRfqWithRequisition } from './rfq-locks';

/*
 * The award (US-SRC-03; RFQ-T05 and QUO-T05). Lock order (ADR 0008 C8): the requisition, the RFQ,
 * then all of its quotations, so a withdrawal or another award of the same RFQ waits.
 */

/** Builds the comparison input from stored rows; `today` decides expiry. */
export function toCompared(rows: readonly QuotationRow[], lines: readonly { quotationId: string; rfqLineId: string; unitPrice: string }[], activeSupplierIds: ReadonlySet<string>): ComparedQuotation[] {
  return rows.map((q) => ({
    id: q.id,
    status: q.status as ComparedQuotation['status'],
    validUntil: q.validUntil,
    supplierActive: activeSupplierIds.has(q.supplierId),
    total: q.total,
    unitPrices: new Map(lines.filter((l) => l.quotationId === q.id).map((l) => [l.rfqLineId, l.unitPrice])),
  }));
}

/** Amounts in the message are at the currency scale, e.g. "302.30 USD". */
function justificationMessage(
  reasons: readonly JustificationReason[],
  c: Comparison,
  rule: { estimatedTotal: string; threshold: string; minQuotes: number; chosenTotal: string; lowestTotal: string; currency: string },
): string {
  const parts: string[] = [];
  if (reasons.includes('below_min_quotes')) {
    parts.push(
      `Only ${c.validCount} valid quotation${c.validCount === 1 ? ' was' : 's were'} received; ${rule.minQuotes} are expected because the requisition's estimated total (${rule.estimatedTotal} ${rule.currency}) is at or above ${rule.threshold} ${rule.currency}.`,
    );
  }
  if (reasons.includes('not_lowest')) {
    parts.push(`This quotation (${rule.chosenTotal} ${rule.currency}) is not the lowest valid one (${rule.lowestTotal} ${rule.currency}).`);
  }
  return `${parts.join(' ')} Give a justification to award it.`;
}

export const awardQuotation = defineCommand({
  name: 'quotation.award',
  permission: 'quotation.award',
  input: z.strictObject({ rfqId: z.uuid(), quotationId: z.uuid(), expectedVersion: versionField, justification: justificationField }),
  handler: async ({ tx, actor, request, clock }, input): Promise<{ version: number; status: RfqStatus }> => {
    const { row: rfq, requisition } = await lockRfqWithRequisition(tx, input.rfqId);
    assertRfqVersion(rfq, input.expectedVersion);
    const status = assertRfqTransition(rfq, 'award', 'awarded');
    assertRequisitionApproved(requisition);
    const all = await lockQuotations(tx, rfq.id);
    const chosen = all.find((q) => q.id === input.quotationId);
    if (!chosen) fail('NOT_FOUND', 'Quotation not found on this RFQ.');
    if (chosen.status !== 'submitted') fail('INVALID_TRANSITION', `A quotation that is ${chosen.status.replace('_', ' ')} cannot be awarded.`);

    const rules = await findSourcingRules(tx);
    const suppliers = await findSuppliersByIds(tx, all.map((q) => q.supplierId));
    const active = new Set([...suppliers.values()].filter((s) => s.status === 'active').map((s) => s.id));
    const lines = await findQuotationLines(tx, all.map((q) => q.id));
    const comparison = compareQuotations(
      toCompared(all, lines, active),
      (await findRfqLines(tx, rfq.id)).map((l) => l.id),
      { estimatedTotal: requisition.estimatedTotal, rfqRequiredAbove: rules.rfqRequiredAbove, minQuotes: rules.minQuotes },
      todayIn(rules.timezone, clock.now()),
    );
    const supplier = suppliers.get(chosen.supplierId);
    const supplierName = supplier ? `${supplier.code} ${supplier.legalName}` : chosen.supplierId;
    const validity = comparison.validity.get(chosen.id);
    if (validity === 'expired') {
      failBusinessRule('QUOTATION_EXPIRED', `The quotation from ${supplier?.legalName ?? 'this supplier'} was valid until ${chosen.validUntil}, so it cannot be awarded.`);
    }
    if (validity === 'supplier_not_active') {
      failBusinessRule('SUPPLIER_NOT_ACTIVE', `${supplier?.legalName ?? 'This supplier'} is no longer active, so its quotation cannot be awarded.`);
    }

    const atScale = (value: string) => toFixedScale(dec(value), requisition.currencyScale);
    const chosenTotal = atScale(chosen.total);
    const reasons = justificationReasons(comparison, chosen.id);
    if (reasons.length > 0 && input.justification === null) {
      // The chosen quotation is valid here, so a lowest valid total exists.
      const lowestTotal = atScale(comparison.lowestTotal ?? chosen.total);
      failBusinessRule(
        reasons[0] === 'below_min_quotes' ? 'MIN_QUOTES_JUSTIFICATION_REQUIRED' : 'NON_LOWEST_JUSTIFICATION_REQUIRED',
        justificationMessage(reasons, comparison, {
          estimatedTotal: requisition.estimatedTotal,
          threshold: rules.rfqRequiredAbove === null ? '' : atScale(rules.rfqRequiredAbove),
          minQuotes: rules.minQuotes,
          chosenTotal,
          lowestTotal,
          currency: requisition.currencyCode,
        }),
        { reasons, validQuotations: comparison.validCount, minQuotes: rules.minQuotes, lowestTotal },
      );
    }

    const notLowest = reasons.includes('not_lowest');
    const version = await updateRfq(tx, rfq.id, rfq.version, {
      status,
      awardedQuotationId: chosen.id,
      awardedByUserId: actor.userId,
      awardedAt: sql`now()`,
      awardJustification: input.justification,
      awardRfqRequiredAbove: rules.rfqRequiredAbove,
      awardMinQuotes: rules.minQuotes,
      awardValidQuotes: comparison.validCount,
      awardBelowMinQuotes: comparison.belowMinQuotes,
      awardNotLowest: notLowest,
    });
    for (const quotation of all.filter((q) => q.status === 'submitted')) {
      const outcome = quotation.id === chosen.id ? 'awarded' : 'not_awarded';
      await updateQuotation(tx, quotation.id, quotation.version, { status: outcome });
      await recordAuditEvent(tx, request, {
        action: outcome === 'awarded' ? 'quotation.awarded' : 'quotation.notAwarded',
        entityType: 'quotation',
        entityId: quotation.id,
        changes: auditChanges(quotationAudit, { status: 'submitted' }, { status: outcome }),
      });
    }
    await recordAuditEvent(tx, request, {
      action: 'rfq.awarded',
      entityType: 'rfq',
      entityId: rfq.id,
      changes: auditChanges(rfqAudit, { status: rfq.status }, {
        status,
        awardedTo: supplierName,
        awardedTotal: `${chosenTotal} ${requisition.currencyCode}`,
        rfqRequiredAbove: rules.rfqRequiredAbove,
        minQuotes: rules.minQuotes,
        validQuotations: comparison.validCount,
        belowMinQuotes: comparison.belowMinQuotes,
        notLowest,
      }),
      ...(input.justification === null ? {} : { reason: input.justification }),
    });
    return { version, status };
  },
});
