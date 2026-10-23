/*
 * Organization settings rules with no I/O. The runtime's ICU data is the reference for
 * time zones (IANA) and currencies (ISO 4217).
 */
const TIME_ZONES = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']);
const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));

export function isTimeZone(value: string): boolean {
  return TIME_ZONES.has(value);
}

export function isCurrencyCode(value: string): boolean {
  return CURRENCIES.has(value);
}

export function timeZones(): string[] {
  return [...TIME_ZONES].sort();
}

export function currencyCodes(): string[] {
  return [...CURRENCIES].sort();
}

/** The calendar date "today" in the organization's time zone, as YYYY-MM-DD. */
export function todayIn(timeZone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}
