import { Dec, dec, type DecimalValue } from '@/shared/decimal/decimal';

/**
 * Percentile with linear interpolation between the closest ranks (PostgreSQL's percentile_cont),
 * in exact decimals. `values` are decimal strings; null for an empty list.
 */
export function percentile(values: readonly string[], fraction: number): DecimalValue | null {
  if (fraction < 0 || fraction > 1) throw new Error(`Percentile fraction must be 0 to 1, got ${fraction}`);
  if (values.length === 0) return null;
  const sorted = values.map(dec).sort((a, b) => a.comparedTo(b));
  const position = new Dec(fraction).mul(sorted.length - 1);
  const lower = position.floor().toNumber();
  const upper = position.ceil().toNumber();
  const low = sorted[lower] as DecimalValue;
  const high = sorted[upper] as DecimalValue;
  return low.add(high.sub(low).mul(position.sub(lower)));
}

/** Seconds as hours, rounded half up to 2 decimals. */
export function hoursOf(seconds: DecimalValue): string {
  return seconds.div(3600).toDecimalPlaces(2, Dec.ROUND_HALF_UP).toFixed(2);
}
