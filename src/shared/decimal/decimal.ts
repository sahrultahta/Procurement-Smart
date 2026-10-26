import Decimal from 'decimal.js';
import { z } from 'zod';

/**
 * The one Decimal constructor used for money and quantities (ADR 0007).
 * Cloned so the global decimal.js configuration is never relied upon.
 */
export const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -40, toExpPos: 40 });
export type DecimalValue = Decimal;

/** Monetary input: up to 12 integer digits and 4 decimals, no sign, no exponent. */
export const MONEY_INPUT_PATTERN = /^\d{1,12}(\.\d{1,4})?$/;
/** Quantity input: up to 9 integer digits and 3 decimals. */
export const QUANTITY_INPUT_PATTERN = /^\d{1,9}(\.\d{1,3})?$/;
/** Percentage input, e.g. a tax rate: 0 to 100 with up to 4 decimals. */
export const PERCENT_INPUT_PATTERN = /^\d{1,3}(\.\d{1,4})?$/;

/** numeric(20,4) holds 16 integer digits; totals must stay strictly below 10^16. */
export const AMOUNT_LIMIT = new Dec('1e16');

export const moneyInput = z.string().regex(MONEY_INPUT_PATTERN, 'Enter an amount with up to 4 decimal places, e.g. 1250.50');

export const quantityInput = z
  .string()
  .regex(QUANTITY_INPUT_PATTERN, 'Enter a quantity with up to 3 decimal places, e.g. 12.5')
  // Zod runs every check even after the pattern fails, so the refinement must not parse a malformed value.
  .refine((value) => !QUANTITY_INPUT_PATTERN.test(value) || new Dec(value).gt(0), 'Quantity must be greater than zero');

export const percentInput = z
  .string()
  .regex(PERCENT_INPUT_PATTERN, 'Enter a percentage with up to 4 decimal places, e.g. 11')
  .refine((value) => !PERCENT_INPUT_PATTERN.test(value) || new Dec(value).lte(100), 'Percentage cannot exceed 100');

/** Parses a decimal string that has already been validated or read from PostgreSQL. */
export function dec(value: string): DecimalValue {
  const parsed = new Dec(value);
  if (!parsed.isFinite()) throw new Error('Decimal value must be finite');
  return parsed;
}

export function assertCurrencyScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 0 || scale > 4) {
    throw new Error(`Currency scale must be an integer from 0 to 4, got ${scale}`);
  }
}

/** Rounds half-up to `scale` decimals and returns a fixed-point string, e.g. '12.50'. */
export function toFixedScale(value: DecimalValue, scale: number): string {
  return value.toDecimalPlaces(scale, Dec.ROUND_HALF_UP).toFixed(scale);
}
