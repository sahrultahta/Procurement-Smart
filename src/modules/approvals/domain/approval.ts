import type { StepRole } from '@/modules/organization';

export type { StepRole };

/**
 * Approval request and step rules with no I/O (docs/state-machines.md §2), shared by every
 * document type that needs approval (requisitions, and purchase orders from Phase 7).
 */
export const APPROVAL_DOCUMENT_TYPES = ['requisition', 'purchase_order'] as const;
export type ApprovalDocumentType = (typeof APPROVAL_DOCUMENT_TYPES)[number];

export const REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'returned', 'cancelled'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const STEP_STATUSES = ['waiting', 'pending', 'approved', 'rejected', 'returned', 'cancelled'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const DECISIONS = ['approve', 'reject', 'return'] as const;
export type Decision = (typeof DECISIONS)[number];

/** Everything that can happen to a step: opened (the previous step was approved), decided, or cancelled. */
export const STEP_EVENTS = ['activate', 'approve', 'reject', 'return', 'cancel'] as const;
export type StepEvent = (typeof STEP_EVENTS)[number];

const STEP_TRANSITIONS: Readonly<Record<StepStatus, Partial<Record<StepEvent, StepStatus>>>> = {
  waiting: { activate: 'pending', cancel: 'cancelled' },
  pending: { approve: 'approved', reject: 'rejected', return: 'returned', cancel: 'cancelled' },
  approved: {},
  rejected: {},
  returned: {},
  cancelled: {},
};

export function nextStepStatus(from: StepStatus, event: StepEvent): StepStatus | null {
  return STEP_TRANSITIONS[from][event] ?? null;
}

/** A request ends when its last step is approved (AP-T02), any step is rejected or returned (AP-T03/T04), or it is withdrawn (AP-T05). */
export const REQUEST_EVENTS = ['approve', 'reject', 'return', 'cancel'] as const;
export type RequestEvent = (typeof REQUEST_EVENTS)[number];

const REQUEST_TRANSITIONS: Readonly<Record<RequestStatus, Partial<Record<RequestEvent, RequestStatus>>>> = {
  pending: { approve: 'approved', reject: 'rejected', return: 'returned', cancel: 'cancelled' },
  approved: {},
  rejected: {},
  returned: {},
  cancelled: {},
};

export function nextRequestStatus(from: RequestStatus, event: RequestEvent): RequestStatus | null {
  return REQUEST_TRANSITIONS[from][event] ?? null;
}

export function isRequestStatus(value: string): value is RequestStatus {
  return (REQUEST_STATUSES as readonly string[]).includes(value);
}

export function isStepStatus(value: string): value is StepStatus {
  return (STEP_STATUSES as readonly string[]).includes(value);
}

export type StepState = { readonly stepNo: number; readonly status: StepStatus };
export type StepChange = { readonly stepNo: number; readonly from: StepStatus; readonly to: StepStatus };

/** AP-T01: step 1 is open for a decision, later steps wait their turn. */
export function initialStepStatuses(count: number): StepStatus[] {
  if (!Number.isInteger(count) || count < 1) throw new Error('An approval request needs at least one step');
  return Array.from({ length: count }, (_, i) => (i === 0 ? 'pending' : 'waiting'));
}

export type DecisionOutcome = {
  readonly changes: readonly StepChange[];
  /** The request's new status when the decision ends it; null while later steps remain. */
  readonly requestStatus: Exclude<RequestStatus, 'pending' | 'cancelled'> | null;
};

/**
 * AP-T02 to AP-T04 on a consistent request (earlier steps approved, this one pending, later
 * ones waiting). Returns null when the step is not open for a decision.
 */
export function applyDecision(steps: readonly StepState[], stepNo: number, decision: Decision): DecisionOutcome | null {
  const step = steps.find((s) => s.stepNo === stepNo);
  const decided = step ? nextStepStatus(step.status, decision) : null;
  if (!step || !decided) return null;
  const later = steps.filter((s) => s.stepNo > stepNo).sort((a, b) => a.stepNo - b.stepNo);
  const changes: StepChange[] = [{ stepNo, from: step.status, to: decided }];
  if (decision === 'approve') {
    const next = later[0];
    if (!next) return { changes, requestStatus: 'approved' };
    changes.push(transition(next, 'activate'));
    return { changes, requestStatus: null };
  }
  for (const s of later) changes.push(transition(s, 'cancel'));
  return { changes, requestStatus: decision === 'reject' ? 'rejected' : 'returned' };
}

/** AP-T05: the document was withdrawn; every step still open is cancelled. */
export function cancelOpenSteps(steps: readonly StepState[]): StepChange[] {
  return steps.filter((s) => nextStepStatus(s.status, 'cancel') !== null).map((s) => transition(s, 'cancel'));
}

function transition(step: StepState, event: StepEvent): StepChange {
  const to = nextStepStatus(step.status, event);
  if (!to) throw new Error(`Approval step ${step.stepNo} cannot ${event} from ${step.status}`);
  return { stepNo: step.stepNo, from: step.status, to };
}

export type RoleScope = { readonly organizationWide: boolean; readonly departmentIds: readonly string[] };
export type StepAssignment = { readonly requiredRole: StepRole; readonly scopeDepartmentId: string | null };

/**
 * Eligibility (docs/state-machines.md §2): an org-wide assignment of the step's role always
 * qualifies; a department assignment qualifies only for a step scoped to that department.
 */
export function holdsStepRole(step: StepAssignment, scope: RoleScope): boolean {
  if (scope.organizationWide) return true;
  return step.scopeDepartmentId !== null && scope.departmentIds.includes(step.scopeDepartmentId);
}

export type SodRule = 'SELF_APPROVAL' | 'DUPLICATE_APPROVER';

/**
 * Separation of duties for one decision. SOD-01: the submitter never decides (nor, for
 * purchase orders, the buyer who awarded the quotation, SOD-06). SOD-02: one person decides
 * at most one step per round.
 */
export function sodBlocker(
  request: { readonly submittedByUserId: string; readonly awardedByUserId: string | null },
  steps: readonly { readonly decidedByUserId: string | null }[],
  userId: string,
): SodRule | null {
  if (request.submittedByUserId === userId || request.awardedByUserId === userId) return 'SELF_APPROVAL';
  if (steps.some((s) => s.decidedByUserId === userId)) return 'DUPLICATE_APPROVER';
  return null;
}

export const MAX_COMMENT = 2000;
