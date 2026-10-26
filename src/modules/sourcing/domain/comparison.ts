import { compareAmounts } from '@/shared/decimal/pricing';
import { validityOf, type QuotationStatus, type Validity } from './quotation';

/**
 * The quotation comparison and the award's justification rules (RFQ-T05, P6-AC3/AC4), with no
 * I/O. Only valid quotations count, for the minimum and for the lowest price (maintainer decision
 * 2026-10-25). Amounts are decimal strings and are compared as decimals, never as floats.
 */

export type ComparedQuotation = {
  id: string;
  status: QuotationStatus;
  /** YYYY-MM-DD */
  validUntil: string;
  supplierActive: boolean;
  total: string;
  /** Unit price by RFQ line id. Every quotation covers every line. */
  unitPrices: ReadonlyMap<string, string>;
};

export type AwardRule = {
  /** The requisition's approved estimated total. */
  estimatedTotal: string;
  /** From this estimated total the minimum applies; null: never. */
  rfqRequiredAbove: string | null;
  minQuotes: number;
};

export type Comparison = {
  validity: ReadonlyMap<string, Validity>;
  validCount: number;
  /** The lowest total among valid quotations, or null when none is valid. */
  lowestTotal: string | null;
  /** Valid quotations with that total: a tie makes each of them the lowest. */
  lowestIds: ReadonlySet<string>;
  /** By RFQ line id: the valid quotations with the lowest unit price on that line. */
  lowestOnLine: ReadonlyMap<string, ReadonlySet<string>>;
  /** The estimated total is at or above the threshold. */
  minQuotesApplies: boolean;
  /** The minimum applies and fewer valid quotations were received. */
  belowMinQuotes: boolean;
};

function lowestOf<T>(items: readonly T[], value: (item: T) => string): { lowest: string | null; ids: T[] } {
  let lowest: string | null = null;
  let ids: T[] = [];
  for (const item of items) {
    const amount = value(item);
    const order = lowest === null ? -1 : compareAmounts(amount, lowest);
    if (order < 0) {
      lowest = amount;
      ids = [item];
    } else if (order === 0) {
      ids.push(item);
    }
  }
  return { lowest, ids };
}

export function compareQuotations(quotations: readonly ComparedQuotation[], rfqLineIds: readonly string[], rule: AwardRule, today: string): Comparison {
  const validity = new Map(quotations.map((q) => [q.id, validityOf(q, today)] as const));
  const valid = quotations.filter((q) => validity.get(q.id) === 'valid');
  const total = lowestOf(valid, (q) => q.total);
  const lowestOnLine = new Map(
    rfqLineIds.map((lineId) => [lineId, new Set(lowestOf(valid, (q) => q.unitPrices.get(lineId) ?? '0').ids.map((q) => q.id))] as const),
  );
  const minQuotesApplies = rule.rfqRequiredAbove !== null && compareAmounts(rule.estimatedTotal, rule.rfqRequiredAbove) >= 0;
  return {
    validity,
    validCount: valid.length,
    lowestTotal: total.lowest,
    lowestIds: new Set(total.ids.map((q) => q.id)),
    lowestOnLine,
    minQuotesApplies,
    belowMinQuotes: minQuotesApplies && valid.length < rule.minQuotes,
  };
}

export type JustificationReason = 'below_min_quotes' | 'not_lowest';

/** Why awarding `chosenId` needs a justification; empty when it does not. One text covers both reasons. */
export function justificationReasons(comparison: Comparison, chosenId: string): JustificationReason[] {
  const reasons: JustificationReason[] = [];
  if (comparison.belowMinQuotes) reasons.push('below_min_quotes');
  if (!comparison.lowestIds.has(chosenId)) reasons.push('not_lowest');
  return reasons;
}
