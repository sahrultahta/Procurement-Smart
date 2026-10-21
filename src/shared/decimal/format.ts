/**
 * Display formatting for decimal strings. Passes the string itself to
 * Intl.NumberFormat (string numeric literals keep full precision) instead of
 * converting to a float first.
 */
export function formatDecimal(value: string, options: { locale: string; scale: number }): string {
  const formatter = new Intl.NumberFormat(options.locale, {
    minimumFractionDigits: options.scale,
    maximumFractionDigits: options.scale,
  });
  return formatter.format(value as Intl.StringNumericLiteral);
}
