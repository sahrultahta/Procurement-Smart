/**
 * Purchase requisition rules with no I/O (docs/state-machines.md §1).
 */
export const REQUISITION_STATUSES = ['draft', 'pending_approval', 'returned', 'approved', 'rejected', 'cancelled', 'closed'] as const;
export type RequisitionStatus = (typeof REQUISITION_STATUSES)[number];

/** Everything that can happen to an existing requisition (create, PR-T01, starts in draft). */
export const REQUISITION_COMMANDS = ['update', 'submit', 'approve', 'reject', 'return', 'cancel', 'close'] as const;
export type RequisitionCommand = (typeof REQUISITION_COMMANDS)[number];

/** PR-T02 to PR-T10. Any (status, command) pair not listed is an invalid transition. */
const TRANSITIONS: Readonly<Record<RequisitionStatus, Partial<Record<RequisitionCommand, RequisitionStatus>>>> = {
  draft: {
    update: 'draft', // PR-T02
    submit: 'pending_approval', // PR-T03
    cancel: 'cancelled', // PR-T07
  },
  returned: {
    update: 'returned', // PR-T02
    submit: 'pending_approval', // PR-T03, new round
    cancel: 'cancelled', // PR-T07
  },
  pending_approval: {
    approve: 'approved', // PR-T04 (system, from the last approved step)
    reject: 'rejected', // PR-T05 (system)
    return: 'returned', // PR-T06 (system)
    cancel: 'cancelled', // PR-T08 (withdraw; reason required)
  },
  approved: {
    cancel: 'cancelled', // PR-T09 (nothing ordered; reason required)
    close: 'closed', // PR-T10 (reason required)
  },
  rejected: {},
  cancelled: {},
  closed: {},
};

export function nextRequisitionStatus(from: RequisitionStatus, command: RequisitionCommand): RequisitionStatus | null {
  return TRANSITIONS[from][command] ?? null;
}

export function isRequisitionStatus(value: string): value is RequisitionStatus {
  return (REQUISITION_STATUSES as readonly string[]).includes(value);
}

/** Lines and header can be edited by the requester only in these states (threat T-02). */
export function isEditable(status: RequisitionStatus): boolean {
  return nextRequisitionStatus(status, 'update') !== null;
}

/** PR-T08 / PR-T09: withdrawing a submitted or approved requisition needs a reason. */
export function cancelNeedsReason(status: RequisitionStatus): boolean {
  return status === 'pending_approval' || status === 'approved';
}

export const MAX_LINES = 200;
