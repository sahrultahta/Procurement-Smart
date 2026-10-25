import 'server-only';
import { auditChanges, recordAuditEvent } from '@/modules/audit';
import { findDepartmentDirectory, findRoleScope, findUserDisplayNames } from '@/modules/identity';
import type { PolicyStep } from '@/modules/organization';
import type { Actor, RequestContext } from '@/shared/application/context';
import { dec, toFixedScale } from '@/shared/decimal/decimal';
import type { Database, Tx } from '@/shared/db/transaction';
import {
  cancelOpenSteps,
  initialStepStatuses,
  type ApprovalDocumentType,
  type RequestStatus,
  type RoleScope,
  type StepRole,
  type StepStatus,
} from '../domain/approval';
import {
  findRequestsWithSteps,
  findSteps,
  insertRequest,
  insertSteps,
  lastRound,
  lockRequest,
  searchInbox,
  updateRequest,
  updateStep,
} from '../infrastructure/approval-repository';
import { approvalAudit, stepSummaries } from './approval-audit';

/*
 * What document modules call inside their own commands: open a request at submit (AP-T01),
 * cancel it on withdrawal (AP-T05), and read the history and the caller's open decision.
 */

export function stepLabel(requiredRole: StepRole, scopeDepartmentCode: string | null): string {
  if (requiredRole === 'finance') return 'Finance';
  return scopeDepartmentCode ? `Approver for ${scopeDepartmentCode}` : 'Any approver (organization-wide)';
}

async function departmentCodes(db: Database | Tx): Promise<Map<string, string>> {
  return new Map((await findDepartmentDirectory(db)).map((d) => [d.id, d.code]));
}

export type OpenedApprovalRequest = { approvalRequestId: string; round: number; route: string[] };

/** AP-T01, inside PR-T03 (and PO-T03 later): a new round with a snapshot of the policy route. */
export async function openApprovalRequest(
  tx: Tx,
  request: RequestContext,
  input: {
    documentType: ApprovalDocumentType;
    documentId: string;
    documentNumber: string;
    documentTitle: string;
    amount: string;
    currencyCode: string;
    currencyScale: number;
    departmentId: string;
    submittedByUserId: string;
    route: { policyId: string; versionNo: number; steps: readonly PolicyStep[] };
  },
): Promise<OpenedApprovalRequest> {
  const round = (await lastRound(tx, input.documentType, input.documentId)) + 1;
  const approvalRequestId = await insertRequest(tx, {
    documentType: input.documentType,
    documentId: input.documentId,
    round,
    documentNumber: input.documentNumber,
    documentTitle: input.documentTitle,
    amountSnapshot: input.amount,
    currencyCode: input.currencyCode,
    currencyScale: input.currencyScale,
    departmentId: input.departmentId,
    policyId: input.route.policyId,
    policyVersionNo: input.route.versionNo,
    submittedByUserId: input.submittedByUserId,
  });
  const statuses = initialStepStatuses(input.route.steps.length);
  const steps = input.route.steps.map((s, i) => ({
    stepNo: i + 1,
    requiredRole: s.role,
    // A department-scoped step belongs to the document's department, frozen now.
    scopeDepartmentId: s.scopeMode === 'document_department' ? input.departmentId : null,
    status: statuses[i] ?? 'waiting',
  }));
  await insertSteps(tx, approvalRequestId, steps);

  const codes = await departmentCodes(tx);
  const route = steps.map((s) => `${s.stepNo}. ${stepLabel(s.requiredRole, s.scopeDepartmentId ? (codes.get(s.scopeDepartmentId) ?? null) : null)}`);
  await recordAuditEvent(tx, request, {
    action: 'approval.requested',
    entityType: 'approval_request',
    entityId: approvalRequestId,
    changes: auditChanges(approvalAudit, null, {
      documentNumber: input.documentNumber,
      round,
      amount: toFixedScale(dec(input.amount), input.currencyScale),
      route,
      steps: stepSummaries(steps),
      status: 'pending',
    }),
  });
  return { approvalRequestId, round, route };
}

/**
 * AP-T05, inside a withdrawal (PR-T08): the pending request and its open steps are cancelled.
 * The caller has locked the document first (ADR 0008 C8).
 */
export async function cancelApprovalRequest(tx: Tx, request: RequestContext, approvalRequestId: string, reason: string): Promise<void> {
  const row = await lockRequest(tx, approvalRequestId);
  if (!row || row.status !== 'pending') throw new Error(`approval request ${approvalRequestId} is not pending`);
  const steps = (await findSteps(tx, row.id)).map((s) => ({ stepNo: s.stepNo, status: s.status as StepStatus }));
  const changes = cancelOpenSteps(steps);
  for (const change of changes) await updateStep(tx, row.id, change.stepNo, change.from, { status: change.to });
  await updateRequest(tx, row.id, row.version, { status: 'cancelled', completed: true });
  const after = steps.map((s) => ({ stepNo: s.stepNo, status: changes.find((c) => c.stepNo === s.stepNo)?.to ?? s.status }));
  await recordAuditEvent(tx, request, {
    action: 'approval.cancelled',
    entityType: 'approval_request',
    entityId: row.id,
    changes: auditChanges(approvalAudit, { steps: stepSummaries(steps), status: 'pending' }, { steps: stepSummaries(after), status: 'cancelled' }),
    reason,
  });
}

export type ApprovalStepDto = {
  stepNo: number;
  requiredRole: StepRole;
  /** "Approver for OPS", "Any approver (organization-wide)", "Finance". */
  label: string;
  status: StepStatus;
  activatedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  comment: string | null;
};
export const APPROVAL_STEP_KEYS = ['stepNo', 'requiredRole', 'label', 'status', 'activatedAt', 'decidedBy', 'decidedAt', 'comment'] as const;

export type ApprovalRoundDto = {
  round: number;
  status: RequestStatus;
  policyVersionNo: number;
  amount: string;
  submittedBy: string;
  submittedAt: string;
  completedAt: string | null;
  steps: ApprovalStepDto[];
};
export const APPROVAL_ROUND_KEYS = ['round', 'status', 'policyVersionNo', 'amount', 'submittedBy', 'submittedAt', 'completedAt', 'steps'] as const;

/**
 * US-AP-04: every round with who, when, decision, and comment. The caller must already have
 * checked that the actor may see the document; this returns names, never user ids.
 */
export async function findApprovalHistory(db: Database | Tx, documentType: ApprovalDocumentType, documentId: string): Promise<ApprovalRoundDto[]> {
  const rounds = await findRequestsWithSteps(db, documentType, documentId);
  if (rounds.length === 0) return [];
  const userIds = rounds.flatMap(({ request, steps }) => [request.submittedByUserId, ...steps.flatMap((s) => (s.decidedByUserId ? [s.decidedByUserId] : []))]);
  const names = await findUserDisplayNames(db, [...new Set(userIds)]);
  const codes = await departmentCodes(db);
  const nameOf = (id: string) => names.get(id) ?? 'Unknown user';
  return rounds.map(({ request, steps }) => ({
    round: request.round,
    status: request.status as RequestStatus,
    policyVersionNo: request.policyVersionNo,
    amount: toFixedScale(dec(request.amountSnapshot), request.currencyScale),
    submittedBy: nameOf(request.submittedByUserId),
    submittedAt: request.createdAt.toISOString(),
    completedAt: request.completedAt?.toISOString() ?? null,
    steps: steps.map((s) => ({
      stepNo: s.stepNo,
      requiredRole: s.requiredRole as StepRole,
      label: stepLabel(s.requiredRole as StepRole, s.scopeDepartmentId ? (codes.get(s.scopeDepartmentId) ?? null) : null),
      status: s.status as StepStatus,
      activatedAt: s.activatedAt?.toISOString() ?? null,
      decidedBy: s.decidedByUserId ? nameOf(s.decidedByUserId) : null,
      decidedAt: s.decidedAt?.toISOString() ?? null,
      comment: s.comment,
    })),
  }));
}

/** The actor's current role scopes for both step roles, read in the caller's transaction. */
export async function stepRoleScopes(db: Database | Tx, userId: string): Promise<Record<StepRole, RoleScope>> {
  return { approver: await findRoleScope(db, userId, 'approver'), finance: await findRoleScope(db, userId, 'finance') };
}

export type OpenDecisionDto = { approvalRequestId: string; requestVersion: number; stepNo: number; stepCount: number; label: string };
export const OPEN_DECISION_KEYS = ['approvalRequestId', 'requestVersion', 'stepNo', 'stepCount', 'label'] as const;

/** The step of this document the actor may decide right now (same rules as the inbox), if any. */
export async function findOpenDecision(db: Database | Tx, actor: Actor, documentType: ApprovalDocumentType, documentId: string): Promise<OpenDecisionDto | null> {
  if (!actor.permissions.has('approval.decide')) return null;
  const [row] = await searchInbox(db, { userId: actor.userId, scopes: await stepRoleScopes(db, actor.userId), document: { type: documentType, id: documentId }, limit: 1 });
  if (!row) return null;
  const codes = row.step.scopeDepartmentId ? await departmentCodes(db) : new Map<string, string>();
  return {
    approvalRequestId: row.request.id,
    requestVersion: row.request.version,
    stepNo: row.step.stepNo,
    stepCount: row.stepCount,
    label: stepLabel(row.step.requiredRole as StepRole, row.step.scopeDepartmentId ? (codes.get(row.step.scopeDepartmentId) ?? null) : null),
  };
}
