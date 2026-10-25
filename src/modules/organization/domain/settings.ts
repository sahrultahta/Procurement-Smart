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

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** The wall-clock reading (YYYY-MM-DDTHH:mm) of an instant in a time zone. */
export function localDateTimeIn(timeZone: string, instant: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

/**
 * The instant at which the clock in `timeZone` shows `local` (YYYY-MM-DDTHH:mm). Null for a
 * malformed value, an impossible date, or a time skipped by a daylight-saving change.
 * For a time that occurs twice (clocks going back), the earlier instant.
 */
export function instantOfLocalDateTime(timeZone: string, local: string): Date | null {
  const m = LOCAL_DATE_TIME.exec(local);
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number) as [number, number, number, number, number];
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  // The zone's offsets near that moment; the right one makes the clock read `local`.
  const candidates = [-36, -12, 0, 12, 36].map((h) => asUtc - offsetMinutes(timeZone, new Date(asUtc + h * 3_600_000)) * 60_000);
  const matches = [...new Set(candidates)].filter((t) => localDateTimeIn(timeZone, new Date(t)) === local).sort((a, b) => a - b);
  return matches.length > 0 ? new Date(matches[0] as number) : null;
}

/** Minutes the zone is ahead of UTC at an instant. */
function offsetMinutes(timeZone: string, instant: Date): number {
  const reading = LOCAL_DATE_TIME.exec(localDateTimeIn(timeZone, instant));
  if (!reading) throw new Error(`Unreadable time in ${timeZone}`);
  const [year, month, day, hour, minute] = reading.slice(1).map(Number) as [number, number, number, number, number];
  const wallClock = Date.UTC(year, month - 1, day, hour, minute);
  return Math.round((wallClock - Math.floor(instant.getTime() / 60_000) * 60_000) / 60_000);
}

/** The calendar date "today" in the organization's time zone, as YYYY-MM-DD. */
export function todayIn(timeZone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}
