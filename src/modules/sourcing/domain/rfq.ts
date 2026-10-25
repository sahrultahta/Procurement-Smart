/**
 * Request-for-quotation rules with no I/O (docs/state-machines.md §4).
 */
export const RFQ_STATUSES = ['draft', 'issued', 'closed', 'awarded', 'cancelled'] as const;
export type RfqStatus = (typeof RFQ_STATUSES)[number];

/** Everything that can happen to an existing RFQ (create, RFQ-T01, starts in draft). */
export const RFQ_COMMANDS = ['update', 'issue', 'close', 'award', 'cancel'] as const;
export type RfqCommand = (typeof RFQ_COMMANDS)[number];

/** RFQ-T02 to RFQ-T06. Any (status, command) pair not listed is an invalid transition. */
const TRANSITIONS: Readonly<Record<RfqStatus, Partial<Record<RfqCommand, RfqStatus>>>> = {
  draft: {
    update: 'draft', // RFQ-T02
    issue: 'issued', // RFQ-T03
    cancel: 'cancelled', // RFQ-T06
  },
  issued: {
    close: 'closed', // RFQ-T04
    cancel: 'cancelled', // RFQ-T06
  },
  closed: {
    award: 'awarded', // RFQ-T05 (Phase 6b)
    cancel: 'cancelled', // RFQ-T06
  },
  awarded: {},
  cancelled: {},
};

export function nextRfqStatus(from: RfqStatus, command: RfqCommand): RfqStatus | null {
  return TRANSITIONS[from][command] ?? null;
}

export function isRfqStatus(value: string): value is RfqStatus {
  return (RFQ_STATUSES as readonly string[]).includes(value);
}

/** A requisition line is "on" an RFQ until that RFQ is cancelled (maintainer decision 2026-10-25). */
export function holdsRequisitionLines(status: RfqStatus): boolean {
  return status !== 'cancelled';
}

export const MAX_RFQ_LINES = 200;
export const MAX_INVITED_SUPPLIERS = 50;
