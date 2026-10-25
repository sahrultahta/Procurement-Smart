import { describe, expect, it } from 'vitest';
import { instantOfLocalDateTime, localDateTimeIn } from '@/modules/organization/domain/settings';
import { RFQ_COMMANDS, RFQ_STATUSES, holdsRequisitionLines, nextRfqStatus, type RfqCommand, type RfqStatus } from '@/modules/sourcing/domain/rfq';

// P6a-AC1: docs/state-machines.md §4, written out independently of the implementation.
const EXPECTED: Record<string, RfqStatus> = {
  'draft × update': 'draft', // RFQ-T02
  'draft × issue': 'issued', // RFQ-T03
  'draft × cancel': 'cancelled', // RFQ-T06
  'issued × close': 'closed', // RFQ-T04
  'issued × cancel': 'cancelled', // RFQ-T06
  'closed × award': 'awarded', // RFQ-T05 (command in Phase 6b)
  'closed × cancel': 'cancelled', // RFQ-T06
};

describe('P6a-AC1: RFQ state machine, exhaustively', () => {
  const pairs = RFQ_STATUSES.flatMap((s) => RFQ_COMMANDS.map((c) => [s, c] as const));

  it('has 5 statuses × 5 commands', () => {
    expect(pairs).toHaveLength(25);
  });

  it.each(pairs)('%s × %s', (status: RfqStatus, command: RfqCommand) => {
    expect(nextRfqStatus(status, command)).toBe(EXPECTED[`${status} × ${command}`] ?? null);
  });

  it('awarded and cancelled are terminal; only cancelled RFQs free their requisition lines', () => {
    for (const terminal of ['awarded', 'cancelled'] as const) {
      expect(RFQ_COMMANDS.map((c) => nextRfqStatus(terminal, c))).toEqual(Array(5).fill(null));
    }
    expect(RFQ_STATUSES.filter(holdsRequisitionLines)).toEqual(['draft', 'issued', 'closed', 'awarded']);
  });
});

describe('local times in the organization time zone (RFQ due times)', () => {
  it('converts a wall-clock time to the instant, and back', () => {
    expect(instantOfLocalDateTime('UTC', '2030-03-15T17:00')?.toISOString()).toBe('2030-03-15T17:00:00.000Z');
    expect(instantOfLocalDateTime('Asia/Jakarta', '2030-03-15T17:00')?.toISOString()).toBe('2030-03-15T10:00:00.000Z');
    expect(instantOfLocalDateTime('Pacific/Kiritimati', '2030-01-01T00:00')?.toISOString()).toBe('2029-12-31T10:00:00.000Z');
    expect(instantOfLocalDateTime('Asia/Kolkata', '2030-07-01T09:30')?.toISOString()).toBe('2030-07-01T04:00:00.000Z');
    expect(localDateTimeIn('Asia/Jakarta', new Date('2030-03-15T10:00:00Z'))).toBe('2030-03-15T17:00');
    expect(localDateTimeIn('UTC', new Date('2030-12-31T23:59:59.999Z'))).toBe('2030-12-31T23:59');
  });

  it('handles daylight-saving changes: a skipped time is refused, a repeated one is the earlier instant', () => {
    expect(instantOfLocalDateTime('America/New_York', '2030-03-10T02:30')).toBeNull();
    expect(instantOfLocalDateTime('America/New_York', '2030-03-10T03:00')?.toISOString()).toBe('2030-03-10T07:00:00.000Z');
    expect(instantOfLocalDateTime('America/New_York', '2030-11-03T01:30')?.toISOString()).toBe('2030-11-03T05:30:00.000Z');
    expect(instantOfLocalDateTime('America/New_York', '2030-07-01T09:15')?.toISOString()).toBe('2030-07-01T13:15:00.000Z');
    // Lord Howe Island moves its clocks by 30 minutes.
    expect(instantOfLocalDateTime('Australia/Lord_Howe', '2030-04-07T01:45')?.toISOString()).toBe('2030-04-06T14:45:00.000Z');
  });

  it('refuses malformed or impossible values', () => {
    for (const value of ['2030-02-30T10:00', '2030-13-01T10:00', '2030-01-01T24:00', '2030-01-01 10:00', '2030-01-01T10:00Z', '2030-01-01T10:00:00', '']) {
      expect(instantOfLocalDateTime('UTC', value)).toBeNull();
    }
  });
});
