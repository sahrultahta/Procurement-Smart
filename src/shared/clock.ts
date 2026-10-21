/** Injectable time source so business-date logic is testable. */
export type Clock = { now(): Date };

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(isoInstant: string): Clock {
  const instant = new Date(isoInstant);
  if (Number.isNaN(instant.getTime())) throw new Error(`Invalid instant: ${isoInstant}`);
  return { now: () => new Date(instant.getTime()) };
}

/** Calendar date (YYYY-MM-DD) of `clock.now()` in an IANA time zone, e.g. 'Asia/Jakarta'. */
export function businessDate(clock: Clock, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(clock.now());
}

export function businessYear(clock: Clock, timeZone: string): number {
  return Number(businessDate(clock, timeZone).slice(0, 4));
}
