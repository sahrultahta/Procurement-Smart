import { describe, expect, it } from 'vitest';
import { currencyCodes, isCurrencyCode, isTimeZone, timeZones, todayIn } from '@/modules/organization/domain/settings';
import {
  REQUISITION_COMMANDS,
  REQUISITION_STATUSES,
  cancelNeedsReason,
  isEditable,
  nextRequisitionStatus,
  type RequisitionCommand,
  type RequisitionStatus,
} from '@/modules/requisitions/domain/requisition';

// P5a-AC4: docs/state-machines.md §1, written out independently of the implementation.
const EXPECTED: Record<string, RequisitionStatus> = {
  'draft × update': 'draft', // PR-T02
  'draft × submit': 'pending_approval', // PR-T03
  'draft × cancel': 'cancelled', // PR-T07
  'returned × update': 'returned', // PR-T02
  'returned × submit': 'pending_approval', // PR-T03 (new round)
  'returned × cancel': 'cancelled', // PR-T07
  'pending_approval × approve': 'approved', // PR-T04
  'pending_approval × reject': 'rejected', // PR-T05
  'pending_approval × return': 'returned', // PR-T06
  'pending_approval × cancel': 'cancelled', // PR-T08
  'approved × cancel': 'cancelled', // PR-T09
  'approved × close': 'closed', // PR-T10
};

describe('P5a-AC4: requisition state machine, exhaustively', () => {
  const pairs = REQUISITION_STATUSES.flatMap((s) => REQUISITION_COMMANDS.map((c) => [s, c] as const));

  it('has 7 statuses × 7 commands', () => {
    expect(pairs).toHaveLength(49);
  });

  it.each(pairs)('%s × %s', (status: RequisitionStatus, command: RequisitionCommand) => {
    expect(nextRequisitionStatus(status, command)).toBe(EXPECTED[`${status} × ${command}`] ?? null);
  });

  it('lists only real pairs, and the terminal states accept nothing', () => {
    const real = new Set(pairs.map(([s, c]) => `${s} × ${c}`));
    for (const key of Object.keys(EXPECTED)) expect(real.has(key)).toBe(true);
    for (const terminal of ['rejected', 'cancelled', 'closed'] as const) {
      expect(REQUISITION_COMMANDS.map((c) => nextRequisitionStatus(terminal, c))).toEqual(Array(7).fill(null));
    }
  });

  it('lines are editable only in draft and returned; withdrawing after submit needs a reason', () => {
    expect(REQUISITION_STATUSES.filter(isEditable)).toEqual(['draft', 'returned']);
    expect(REQUISITION_STATUSES.filter(cancelNeedsReason)).toEqual(['pending_approval', 'approved']);
  });
});

describe('organization settings rules', () => {
  it('knows IANA time zones and ISO 4217 currencies from ICU', () => {
    for (const zone of ['UTC', 'Asia/Jakarta', 'America/New_York', 'Europe/Berlin']) expect(isTimeZone(zone)).toBe(true);
    for (const zone of ['Mars/Olympus', 'GMT+7', '', 'asia/jakarta']) expect(isTimeZone(zone)).toBe(false);
    for (const code of ['USD', 'IDR', 'EUR', 'JPY']) expect(isCurrencyCode(code)).toBe(true);
    for (const code of ['usd', 'XXX1', 'ABC', '']) expect(isCurrencyCode(code)).toBe(false);
  });

  it('offers sorted lists for the settings screen that the validators accept', () => {
    const zones = timeZones();
    const currencies = currencyCodes();
    expect(zones).toEqual([...zones].sort());
    expect(currencies).toEqual([...currencies].sort());
    expect(zones).toContain('UTC');
    expect(currencies).toEqual(expect.arrayContaining(['USD', 'IDR']));
    expect(zones.every(isTimeZone) && currencies.every(isCurrencyCode)).toBe(true);
  });

  it('computes "today" in the organization time zone, across the date line', () => {
    const instant = new Date('2026-10-22T20:30:00Z');
    expect(todayIn('UTC', instant)).toBe('2026-10-22');
    expect(todayIn('Asia/Jakarta', instant)).toBe('2026-10-23');
    expect(todayIn('America/Los_Angeles', instant)).toBe('2026-10-22');
    expect(todayIn('Pacific/Kiritimati', new Date('2026-12-31T10:30:00Z'))).toBe('2027-01-01');
  });
});
