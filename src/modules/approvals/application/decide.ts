import 'server-only';
import { z } from 'zod';
import { auditChanges, recordAuditEvent } from '@/modules/audit';
import { findRoleScope } from '@/modules/identity';
import { defineCommand } from '@/shared/application/runner';
import { fail, failBusinessRule } from '@/shared/result';
import {
  DECISIONS,
  MAX_COMMENT,
  applyDecision,
  holdsStepRole,
  isRequestStatus,
  sodBlocker,
  type ApprovalDocumentType,
  type RequestStatus,
  type StepRole,
  type StepStatus,
} from '../domain/approval';
import { findRequest, findSteps, lockRequest, updateRequest, updateStep } from '../infrastructure/approval-repository';
import { approvalAudit, stepSummaries } from './approval-audit';
import { approvalDocumentPort } from './document-port';

/*
 * US-AP-02, AP-T02 to AP-T04. Checks, in order, after the document and the request are
 * locked: the caller may see the document, the step is open, the version is current,
 * separation of duties (SOD-01, SOD-02), and the step's role and scope, read fresh.
 */

const blankToNull = (value: unknown) => (value === undefined || (typeof value === 'string' && value.trim() === '') ? null : value);

const SOD_MESSAGES = {
  SELF_APPROVAL: 'You submitted this document, so someone else must decide its approval.',
  DUPLICATE_APPROVER: 'You already decided another step of this approval. A different person must decide this one.',
} as const;

const ROLE_NAMES: Record<StepRole, string> = { approver: 'an approver', finance: 'finance' };

export const decideApproval = defineCommand({
  name: 'approval.decide',
  permission: 'approval.decide',
  input: z
    .strictObject({
      approvalRequestId: z.uuid(),
      stepNo: z.number().int().min(1).max(5),
      expectedVersion: z.number().int().min(1).max(2_147_483_647),
      decision: z.enum(DECISIONS),
      comment: z.preprocess(blankToNull, z.string().trim().max(MAX_COMMENT).nullable()),
    })
    .superRefine((value, ctx) => {
      if (value.decision !== 'approve' && value.comment === null) {
        ctx.addIssue({ code: 'custom', path: ['comment'], message: `Explain why you ${value.decision} it (required)` });
      }
    }),
  handler: async (
    context,
    input,
  ): Promise<{ requestStatus: RequestStatus; documentType: ApprovalDocumentType; documentId: string; documentStatus: string; version: number }> => {
    const { tx, actor, request } = context;
    const found = await findRequest(tx, input.approvalRequestId);
    if (!found) fail('NOT_FOUND', 'Approval not found.');
    const port = approvalDocumentPort(found.documentType as ApprovalDocumentType);
    // The document first, then its request (ADR 0008 C8).
    const document = await port.lockForDecision(tx, actor, found.documentId);
    if (!document?.visible) fail('NOT_FOUND', 'Approval not found.');
    const locked = await lockRequest(tx, found.id);
    if (!locked || !isRequestStatus(locked.status)) throw new Error(`approval request ${found.id} disappeared or has an unknown status`);
    const steps = await findSteps(tx, locked.id);
    const step = steps.find((s) => s.stepNo === input.stepNo);
    if (!step) fail('NOT_FOUND', 'Approval step not found.');

    if (locked.status !== 'pending') fail('INVALID_TRANSITION', 'This approval is already complete.');
    if (step.status !== 'pending') {
      fail(
        'INVALID_TRANSITION',
        step.status === 'waiting' ? 'This step is not open yet: an earlier step is still waiting for a decision.' : 'This step has already been decided.',
      );
    }
    if (locked.version !== input.expectedVersion) fail('CONFLICT', 'This approval changed since you loaded it. Reload the page and try again.');

    const blocker = sodBlocker(locked, steps, actor.userId);
    if (blocker) failBusinessRule(blocker, SOD_MESSAGES[blocker]);
    const role = step.requiredRole as StepRole;
    if (!holdsStepRole({ requiredRole: role, scopeDepartmentId: step.scopeDepartmentId }, await findRoleScope(tx, actor.userId, role))) {
      failBusinessRule(
        'NOT_ELIGIBLE_APPROVER',
        step.scopeDepartmentId ? `This step needs ${ROLE_NAMES[role]} for the document's department.` : `This step needs ${ROLE_NAMES[role]} with organization-wide scope.`,
      );
    }

    const before = steps.map((s) => ({ stepNo: s.stepNo, status: s.status as StepStatus }));
    const outcome = applyDecision(before, step.stepNo, input.decision);
    if (!outcome) throw new Error(`approval step ${step.stepNo} could not take ${input.decision}`);
    for (const change of outcome.changes) {
      const decided = change.stepNo === step.stepNo;
      await updateStep(tx, locked.id, change.stepNo, change.from, {
        status: change.to,
        activate: change.to === 'pending',
        ...(decided ? { decide: true, decidedByUserId: actor.userId, comment: input.comment } : {}),
      });
    }
    const version = await updateRequest(tx, locked.id, locked.version, outcome.requestStatus ? { status: outcome.requestStatus, completed: true } : {});
    const after = before.map((s) => ({ stepNo: s.stepNo, status: outcome.changes.find((c) => c.stepNo === s.stepNo)?.to ?? s.status }));
    const requestStatus: RequestStatus = outcome.requestStatus ?? 'pending';
    await recordAuditEvent(tx, request, {
      action: 'approval.decided',
      entityType: 'approval_request',
      entityId: locked.id,
      changes: auditChanges(approvalAudit, { steps: stepSummaries(before), status: locked.status }, { steps: stepSummaries(after), status: requestStatus }),
      ...(input.comment ? { reason: input.comment } : {}),
    });

    const documentStatus = outcome.requestStatus
      ? await port.applyOutcome(context, { documentId: locked.documentId, approvalRequestId: locked.id, outcome: outcome.requestStatus, comment: input.comment })
      : document.status;
    return { requestStatus, documentType: locked.documentType as ApprovalDocumentType, documentId: locked.documentId, documentStatus, version };
  },
});
