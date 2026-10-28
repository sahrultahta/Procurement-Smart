import { z } from 'zod';

/** Longest date range a report or search accepts: about ten years. */
export const MAX_RANGE_DAYS = 3660;

const date = z.iso.date('Enter a date as YYYY-MM-DD');

/** `from` and `to`: org dates, both inclusive. */
export function dateRangeShape<R extends boolean>(required: R) {
  return (required ? { from: date, to: date } : { from: date.optional(), to: date.optional() }) as R extends true
    ? { from: typeof date; to: typeof date }
    : { from: z.ZodOptional<typeof date>; to: z.ZodOptional<typeof date> };
}

export function checkDateRange(value: { from?: string | undefined; to?: string | undefined }, ctx: z.core.$RefinementCtx): void {
  if (!value.from || !value.to) return;
  const days = (Date.parse(value.to) - Date.parse(value.from)) / 86_400_000;
  if (days < 0) ctx.addIssue({ code: 'custom', path: ['to'], message: 'The end date must be on or after the start date' });
  else if (days > MAX_RANGE_DAYS) ctx.addIssue({ code: 'custom', path: ['to'], message: `The range can be at most ${MAX_RANGE_DAYS} days` });
}
