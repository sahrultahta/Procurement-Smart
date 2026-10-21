import { failBusinessRule } from '../result';
import { AMOUNT_LIMIT, Dec, assertCurrencyScale, dec, toFixedScale, type DecimalValue } from './decimal';

/**
 * The single implementation of line and document totals (ADR 0007).
 * The server always recomputes with this function; totals sent by a client are never trusted.
 *
 *   line_subtotal = round(quantity × unit_price, scale, HALF_UP)
 *   line_tax      = round(line_subtotal × tax_rate / 100, scale, HALF_UP)
 *   line_total    = line_subtotal + line_tax
 *   document totals = sums of the rounded line values (never re-rounded)
 */
export type PricingLine = {
  quantity: string;
  unitPrice: string;
  /** Omitted for tax-exclusive estimates (purchase requisitions). */
  taxRatePct?: string;
};

export type PricedLine = { lineSubtotal: string; lineTax: string; lineTotal: string };

export type PricedDocument = {
  lines: PricedLine[];
  subtotal: string;
  taxTotal: string;
  total: string;
};

export function priceDocument(lines: readonly PricingLine[], currencyScale: number): PricedDocument {
  assertCurrencyScale(currencyScale);
  let subtotal: DecimalValue = new Dec(0);
  let taxTotal: DecimalValue = new Dec(0);

  const priced = lines.map((line, index) => {
    const lineSubtotal = dec(line.quantity).mul(dec(line.unitPrice)).toDecimalPlaces(currencyScale, Dec.ROUND_HALF_UP);
    const lineTax =
      line.taxRatePct === undefined
        ? new Dec(0)
        : lineSubtotal.mul(dec(line.taxRatePct)).div(100).toDecimalPlaces(currencyScale, Dec.ROUND_HALF_UP);
    const lineTotal = lineSubtotal.add(lineTax);
    if (lineTotal.gte(AMOUNT_LIMIT)) {
      failBusinessRule('AMOUNT_TOO_LARGE', `Line ${index + 1} total is too large.`, { line: index + 1 });
    }
    subtotal = subtotal.add(lineSubtotal);
    taxTotal = taxTotal.add(lineTax);
    return {
      lineSubtotal: toFixedScale(lineSubtotal, currencyScale),
      lineTax: toFixedScale(lineTax, currencyScale),
      lineTotal: toFixedScale(lineTotal, currencyScale),
    };
  });

  const total = subtotal.add(taxTotal);
  if (total.gte(AMOUNT_LIMIT)) {
    failBusinessRule('AMOUNT_TOO_LARGE', 'Document total is too large.');
  }
  return {
    lines: priced,
    subtotal: toFixedScale(subtotal, currencyScale),
    taxTotal: toFixedScale(taxTotal, currencyScale),
    total: toFixedScale(total, currencyScale),
  };
}

/** Compares two decimal strings: -1, 0, or 1. Use instead of `<` / `>` on numbers. */
export function compareAmounts(a: string, b: string): -1 | 0 | 1 {
  return dec(a).comparedTo(dec(b)) as -1 | 0 | 1;
}
