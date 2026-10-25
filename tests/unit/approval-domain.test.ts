import { describe, expect, it } from 'vitest';
import {
  DECISIONS,
  REQUEST_EVENTS,
  REQUEST_STATUSES,
  STEP_EVENTS,
  STEP_STATUSES,
  applyDecision,
  cancelOpenSteps,
  holdsStepRole,
  initialStepStatuses,
  nextRequestStatus,
  nextStepStatus,
  sodBlocker,
  type RequestEvent,
  type RequestStatus,
  type StepEvent,
  type StepStatus,
} from '@/modules/approvals/domain/approval';

// P5b-AC1: docs/state-machines.md §2, written out independently of the implementation.
const STEP_EXPECTED: Record<string, StepStatus> = {
  'waiting × activate': 'pending', // previous step approved
  'waiting × cancel': 'cancelled', // request ends early
  'pending × approve': 'approved', // AP-T02
  'pending × reject': 'rejected', // AP-T03
  'pending × return': 'returned', // AP-T04
  'pending × cancel': 'cancelled', // AP-T05 / request ends
};
const REQUEST_EXPECTED: Record<string, RequestStatus> = {
  'pending × approve': 'approved', // AP-T02, last step
  'pending × reject': 'rejected', // AP-T03
  'pending × return': 'returned', // AP-T04
  'pending × cancel': 'cancelled', // AP-T05
};

describe('P5b-AC1: approval step machine, exhaustively', () => {
  const pairs = STEP_STATUSES.flatMap((s) => STEP_EVENTS.map((e) => [s, e] as const));

  it('has 6 statuses × 5 events', () => {
    expect(pairs).toHaveLength(30);
  });

  it.each(pairs)('%s × %s', (status: StepStatus, event: StepEvent) => {
    expect(nextStepStatus(status, event)).toBe(STEP_EXPECTED[`${status} × ${event}`] ?? null);
  });

  it('decided and cancelled steps accept nothing', () => {
    for (const terminal of ['approved', 'rejected', 'returned', 'cancelled'] as const) {
      expect(STEP_EVENTS.map((e) => nextStepStatus(terminal, e))).toEqual(Array(5).fill(null));
    }
  });
});

describe('P5b-AC1: approval request machine, exhaustively', () => {
  const pairs = REQUEST_STATUSES.flatMap((s) => REQUEST_EVENTS.map((e) => [s, e] as const));

  it('has 5 statuses × 4 events', () => {
    expect(pairs).toHaveLength(20);
  });

  it.each(pairs)('%s × %s', (status: RequestStatus, event: RequestEvent) => {
    expect(nextRequestStatus(status, event)).toBe(REQUEST_EXPECTED[`${status} × ${event}`] ?? null);
  });
});

const route = (...statuses: StepStatus[]) => statuses.map((status, i) => ({ stepNo: i + 1, status }));

describe('P5b-AC1: applying decisions to a route', () => {
  it('AP-T01: step 1 is pending, the rest wait; an empty route is refused', () => {
    expect(initialStepStatuses(1)).toEqual(['pending']);
    expect(initialStepStatuses(3)).toEqual(['pending', 'waiting', 'waiting']);
    for (const count of [0, -1, 1.5]) expect(() => initialStepStatuses(count)).toThrow(/at least one step/);
  });

  it('AP-T02: approving opens the next step, and approving the last step approves the request', () => {
    expect(applyDecision(route('pending', 'waiting', 'waiting'), 1, 'approve')).toEqual({
      changes: [
        { stepNo: 1, from: 'pending', to: 'approved' },
        { stepNo: 2, from: 'waiting', to: 'pending' },
      ],
      requestStatus: null,
    });
    expect(applyDecision(route('approved', 'pending', 'waiting'), 2, 'approve')?.requestStatus).toBeNull();
    expect(applyDecision(route('approved', 'approved', 'pending'), 3, 'approve')).toEqual({
      changes: [{ stepNo: 3, from: 'pending', to: 'approved' }],
      requestStatus: 'approved',
    });
    expect(applyDecision(route('pending'), 1, 'approve')?.requestStatus).toBe('approved');
  });

  it('AP-T03 / AP-T04: rejecting or returning cancels every later step', () => {
    expect(applyDecision(route('approved', 'pending', 'waiting'), 2, 'reject')).toEqual({
      changes: [
        { stepNo: 2, from: 'pending', to: 'rejected' },
        { stepNo: 3, from: 'waiting', to: 'cancelled' },
      ],
      requestStatus: 'rejected',
    });
    expect(applyDecision(route('pending', 'waiting', 'waiting'), 1, 'return')).toEqual({
      changes: [
        { stepNo: 1, from: 'pending', to: 'returned' },
        { stepNo: 2, from: 'waiting', to: 'cancelled' },
        { stepNo: 3, from: 'waiting', to: 'cancelled' },
      ],
      requestStatus: 'returned',
    });
  });

  it('only a pending step can be decided', () => {
    for (const decision of DECISIONS) {
      expect(applyDecision(route('pending', 'waiting'), 2, decision)).toBeNull();
      expect(applyDecision(route('approved', 'pending'), 1, decision)).toBeNull();
      expect(applyDecision(route('pending'), 4, decision)).toBeNull();
      expect(applyDecision(route('cancelled', 'cancelled'), 1, decision)).toBeNull();
    }
  });

  it('a step order is followed even when the input is not sorted', () => {
    const steps = [
      { stepNo: 3, status: 'waiting' as const },
      { stepNo: 1, status: 'pending' as const },
      { stepNo: 2, status: 'waiting' as const },
    ];
    expect(applyDecision(steps, 1, 'approve')?.changes[1]).toEqual({ stepNo: 2, from: 'waiting', to: 'pending' });
  });

  it('an inconsistent route (a decided step after the pending one) is a programming error', () => {
    expect(() => applyDecision(route('pending', 'approved'), 1, 'approve')).toThrow(/cannot activate from approved/);
  });

  it('AP-T05: withdrawing cancels the open steps and leaves decided ones alone', () => {
    expect(cancelOpenSteps(route('approved', 'pending', 'waiting'))).toEqual([
      { stepNo: 2, from: 'pending', to: 'cancelled' },
      { stepNo: 3, from: 'waiting', to: 'cancelled' },
    ]);
    expect(cancelOpenSteps(route('approved', 'rejected', 'cancelled'))).toEqual([]);
  });
});

describe('eligibility and separation of duties', () => {
  const ops = 'ops-id';
  const deptStep = { requiredRole: 'approver' as const, scopeDepartmentId: ops };
  const orgStep = { requiredRole: 'approver' as const, scopeDepartmentId: null };

  it('an org-wide assignment covers any step of its role; a department assignment only that department', () => {
    expect(holdsStepRole(deptStep, { organizationWide: true, departmentIds: [] })).toBe(true);
    expect(holdsStepRole(orgStep, { organizationWide: true, departmentIds: [] })).toBe(true);
    expect(holdsStepRole(deptStep, { organizationWide: false, departmentIds: [ops] })).toBe(true);
    expect(holdsStepRole(deptStep, { organizationWide: false, departmentIds: ['sales-id'] })).toBe(false);
    expect(holdsStepRole(orgStep, { organizationWide: false, departmentIds: [ops] })).toBe(false);
    expect(holdsStepRole(deptStep, { organizationWide: false, departmentIds: [] })).toBe(false);
  });

  it('SOD-01 bars the submitter and the awarding buyer; SOD-02 bars a second decision in one round', () => {
    const request = { submittedByUserId: 'rina', awardedByUserId: 'dewi' };
    const steps = [{ decidedByUserId: 'bayu' }, { decidedByUserId: null }];
    expect(sodBlocker(request, steps, 'rina')).toBe('SELF_APPROVAL');
    expect(sodBlocker(request, steps, 'dewi')).toBe('SELF_APPROVAL');
    expect(sodBlocker(request, steps, 'bayu')).toBe('DUPLICATE_APPROVER');
    expect(sodBlocker(request, steps, 'sari')).toBeNull();
    expect(sodBlocker({ submittedByUserId: 'rina', awardedByUserId: null }, [], 'sari')).toBeNull();
  });
});
