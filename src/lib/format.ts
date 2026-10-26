/*
 * Display formatting. Decimal strings go to Intl.NumberFormat as strings (full precision,
 * ADR 0007); timestamps are shown in the organization's time zone, with its abbreviation.
 */

export function formatTimestamp(iso: string, timeZone = 'UTC'): string {
  return new Intl.DateTimeFormat('en', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  }).format(new Date(iso));
}

/** A calendar date (YYYY-MM-DD) as written, with no time-zone shift. */
export function formatDate(date: string): string {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
}

export function formatMoney(value: string, currency: string, scale: number): string {
  return new Intl.NumberFormat('en', {
    style: 'currency',
    currency,
    minimumFractionDigits: scale,
    maximumFractionDigits: scale,
  }).format(value as Intl.StringNumericLiteral);
}

/** A unit price: at least the currency's decimals, and up to the 4 it may have (ADR 0007). */
export function formatUnitPrice(value: string, scale: number): string {
  return new Intl.NumberFormat('en', { minimumFractionDigits: scale, maximumFractionDigits: Math.max(scale, 4) }).format(
    value as Intl.StringNumericLiteral,
  );
}

/** Amounts without a currency symbol, e.g. policy limits. */
export function formatAmount(value: string, scale: number): string {
  return new Intl.NumberFormat('en', { minimumFractionDigits: scale, maximumFractionDigits: scale }).format(
    value as Intl.StringNumericLiteral,
  );
}
