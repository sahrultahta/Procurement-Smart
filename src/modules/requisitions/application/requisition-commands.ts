import 'server-only';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { cancelApprovalRequest, openApprovalRequest } from '@/modules/approvals';
import { auditChanges, recordAuditEvent } from '@/modules/audit';
import { findDepartmentDirectory, resolveActor } from '@/modules/identity';
import { findOrganizationTimezone, lockCurrencyForNewDocument, resolveApprovalRoute, todayIn } from '@/modules/organization';
import type { Actor } from '@/shared/application/context';
import { defineCommand } from '@/shared/application/runner';
import { dec, toFixedScale } from '@/shared/decimal/decimal';
import { priceDocument } from '@/shared/decimal/pricing';
import { allocateDocumentNumber, formatDocumentNumber } from '@/shared/db/document-numbers';
import { idempotencyKeyField, withIdempotency } from '@/shared/db/idempotency';
import type { Tx } from '@/shared/db/transaction';
import { AppFailure, fail, failBusinessRule } from '@/shared/result';
import { cancelNeedsReason, isRequisitionStatus, nextRequisitionStatus, type RequisitionStatus } from '../domain/requisition';
import {
  findLines,
  insertLines,
  insertRequisition,
  isVisible,
  lockRequisition,
  replaceLines,
  updateRequisition,
  type LineValues,
  type RequisitionRow,
} from '../infrastructure/requisition-repository';
import { lineSummaries, reasonField, requiredReasonField, requisitionAudit, requisitionFields, versionField } from './requisition-input';
import { visibilityFor } from './visibility';

/*
 * Purchase requisition commands (US-PR-01 to 04; PR-T01 to T03, T07 to T10). The approval
 * outcomes (PR-T04 to T06) are applied by approval-document.ts when a request ends.
 */

type Fields = { title: string; justification: string | null; neededBy: string; lines: z.output<typeof requisitionFields.lines> };
type LoadedRequisition = RequisitionRow & { status: RequisitionStatus };

/** Server-side pricing (ADR 0007): the browser never supplies a total. */
function price(lines: Fields['lines'], scale: number): { lines: LineValues[]; total: string } {
  const priced = priceDocument(
    lines.map((l) => ({ quantity: l.quantity, unitPrice: l.estimatedUnitPrice })),
    scale,
  );
  return {
    total: priced.total,
    lines: lines.map((l, i) => ({
      description: l.description,
      quantity: l.quantity,
      uom: l.uom,
      estimatedUnitPrice: l.estimatedUnitPrice,
      lineTotal: priced.lines[i]?.lineTotal ?? '0',
    })),
  };
}

async function departmentCodeOf(tx: Tx, departmentId: string): Promise<string> {
  return (await findDepartmentDirectory(tx)).find((d) => d.id === departmentId)?.code ?? departmentId;
}

/** Locks a requisition the actor may see; one they may not see is NOT_FOUND (ADR 0006 §4). */
async function loadVisible(tx: Tx, actor: Actor, id: string): Promise<LoadedRequisition> {
  const row = await lockRequisition(tx, id);
  if (!row || !isVisible(await visibilityFor(tx, actor), row)) fail('NOT_FOUND', 'Requisition not found.');
  if (!isRequisitionStatus(row.status)) throw new Error(`Unknown requisition status ${row.status}`);
  return { ...row, status: row.status };
}

function assertVersion(row: RequisitionRow, expectedVersion: number): void {
  if (row.version !== expectedVersion) fail('CONFLICT', 'This requisition was changed since you loaded it. Reload the page and try again.');
}

function isOwner(actor: Actor, row: RequisitionRow): boolean {
  return row.requesterUserId === actor.userId && actor.permissions.has('requisition.create');
}

/** A change by the requester only: someone who may see it but is not the requester gets FORBIDDEN. */
async function loadOwn(tx: Tx, actor: Actor, id: string, expectedVersion: number): Promise<LoadedRequisition> {
  const row = await loadVisible(tx, actor, id);
  if (!isOwner(actor, row)) fail('FORBIDDEN', 'Only the requester can change this requisition.');
  assertVersion(row, expectedVersion);
  return row;
}

const STATUS_LABEL: Record<RequisitionStatus, string> = {
  draft: 'a draft',
  pending_approval: 'pending approval',
  returned: 'returned',
  approved: 'approved',
  rejected: 'rejected',
  cancelled: 'cancelled',
  closed: 'closed',
};

/** PR-T01 */
export const createRequisition = defineCommand({
  name: 'requisition.create',
  permission: 'requisition.create',
  input: z.strictObject({ ...requisitionFields, idempotencyKey: idempotencyKeyField }),
  handler: async ({ tx, actor, request, clock }, input) => {
    const { idempotencyKey, ...fields } = input;
    return withIdempotency(tx, { userId: actor.userId, key: idempotencyKey, operation: 'requisition.create', input: fields }, async () => {
      // The department comes from the requester's profile as it is now, never from input.
      const requester = await resolveActor(tx, actor.userId);
      const departmentId = requester?.departmentId ?? null;
      if (!departmentId) failBusinessRule('NO_DEPARTMENT', 'Your profile has no department. Ask an administrator to set one.');

      const currency = await lockCurrencyForNewDocument(tx);
      const priced = price(fields.lines, currency.scale);
      const year = Number(todayIn(await findOrganizationTimezone(tx), clock.now()).slice(0, 4));
      const number = formatDocumentNumber('PR', year, await allocateDocumentNumber(tx, 'PR', year));
      const id = await insertRequisition(tx, {
        number,
        requesterUserId: actor.userId,
        departmentId,
        title: fields.title,
        justification: fields.justification,
        neededBy: fields.neededBy,
        currencyCode: currency.code,
        currencyScale: currency.scale,
        estimatedTotal: priced.total,
      });
      await insertLines(tx, id, priced.lines);
      await recordAuditEvent(tx, request, {
        action: 'requisition.created',
        entityType: 'requisition',
        entityId: id,
        changes: auditChanges(requisitionAudit, null, {
          number,
          title: fields.title,
          justification: fields.justification,
          neededBy: fields.neededBy,
          estimatedTotal: priced.total,
          currencyCode: currency.code,
          departmentCode: await departmentCodeOf(tx, departmentId),
          lines: lineSummaries(fields.lines),
          status: 'draft',
        }),
      });
      return { requisitionId: id, number, version: 1, estimatedTotal: priced.total };
    });
  },
});

/** PR-T02: replace header and lines while draft or returned; totals recomputed. */
export const updateRequisitionDraft = defineCommand({
  name: 'requisition.update',
  permission: 'requisition.create',
  input: z.strictObject({ requisitionId: z.uuid(), expectedVersion: versionField, ...requisitionFields }),
  handler: async ({ tx, actor, request }, input): Promise<{ version: number; estimatedTotal: string }> => {
    const row = await loadOwn(tx, actor, input.requisitionId, input.expectedVersion);
    if (!nextRequisitionStatus(row.status, 'update')) {
      fail('INVALID_TRANSITION', `A requisition that is ${STATUS_LABEL[row.status]} cannot be edited.`);
    }
    const priced = price(input.lines, row.currencyScale);
    const storedLines = await findLines(tx, row.id);
    const before = {
      title: row.title,
      justification: row.justification,
      neededBy: row.neededBy,
      // Stored with 4 decimals; shown and compared at the currency scale, like new totals.
      estimatedTotal: toFixedScale(dec(row.estimatedTotal), row.currencyScale),
      lines: lineSummaries(storedLines),
    };
    const after = {
      title: input.title,
      justification: input.justification,
      neededBy: input.neededBy,
      estimatedTotal: priced.total,
      lines: lineSummaries(input.lines),
    };
    const changes = auditChanges(requisitionAudit, before, after);
    if (Object.keys(changes).length === 0) return { version: row.version, estimatedTotal: before.estimatedTotal };

    await replaceLines(tx, row.id, priced.lines);
    const version = await updateRequisition(tx, row.id, row.version, {
      title: input.title,
      justification: input.justification,
      neededBy: input.neededBy,
      estimatedTotal: priced.total,
    });
    await recordAuditEvent(tx, request, {
      action: 'requisition.updated',
      entityType: 'requisition',
      entityId: row.id,
      changes,
    });
    return { version, estimatedTotal: priced.total };
  },
});

/**
 * PR-T03 (US-PR-03): the route is resolved from the active policy by department and total and
 * frozen into a new approval round. No route means no submission: a PR is never auto-approved.
 */
export const submitRequisition = defineCommand({
  name: 'requisition.submit',
  permission: 'requisition.create',
  input: z.strictObject({ requisitionId: z.uuid(), expectedVersion: versionField }),
  handler: async (
    { tx, actor, request, clock },
    input,
  ): Promise<{ version: number; status: RequisitionStatus; approvalRequestId: string; round: number }> => {
    const row = await loadOwn(tx, actor, input.requisitionId, input.expectedVersion);
    const status = nextRequisitionStatus(row.status, 'submit');
    if (!status) fail('INVALID_TRANSITION', `A requisition that is ${STATUS_LABEL[row.status]} cannot be submitted.`);

    const lines = await findLines(tx, row.id);
    if (lines.length === 0 || dec(row.estimatedTotal).lte(0)) {
      failBusinessRule('ZERO_TOTAL', 'The estimated total is zero. Enter the expected prices before submitting.');
    }
    const today = todayIn(await findOrganizationTimezone(tx), clock.now());
    if (row.neededBy < today) failBusinessRule('NEEDED_BY_IN_PAST', `The needed-by date (${row.neededBy}) has passed. Change it before submitting.`);
    const route = await resolveApprovalRoute(tx, 'requisition', row.departmentId, row.estimatedTotal);
    if (!route || route.steps.length === 0) {
      failBusinessRule('NO_APPROVAL_ROUTE', 'No approval rule covers this department and amount. Ask an administrator to update the approval policy.');
    }

    const opened = await openApprovalRequest(tx, request, {
      documentType: 'requisition',
      documentId: row.id,
      documentNumber: row.number,
      documentTitle: row.title,
      amount: row.estimatedTotal,
      currencyCode: row.currencyCode,
      currencyScale: row.currencyScale,
      departmentId: row.departmentId,
      submittedByUserId: actor.userId,
      route,
    });
    const version = await updateRequisition(tx, row.id, row.version, {
      status,
      currentApprovalRequestId: opened.approvalRequestId,
      submittedAt: sql`now()`,
    });
    await recordAuditEvent(tx, request, {
      action: 'requisition.submitted',
      entityType: 'requisition',
      entityId: row.id,
      changes: auditChanges(requisitionAudit, { status: row.status }, { status, round: opened.round, approvalRoute: opened.route }),
    });
    return { version, status, approvalRequestId: opened.approvalRequestId, round: opened.round };
  },
});

function reasonRequired(message: string): never {
  throw new AppFailure({ code: 'VALIDATION_FAILED', message: 'Some fields are invalid.', fieldErrors: { reason: [message] } });
}

/**
 * PR-T07 (draft / returned, reason optional), PR-T08 (withdraw while pending: the approval
 * request and its open steps are cancelled), PR-T09 (approved and nothing ordered, also by
 * procurement). Withdrawing and cancelling after approval need a reason.
 */
export const cancelRequisition = defineCommand({
  name: 'requisition.cancel',
  permission: ['requisition.create', 'po.create'],
  input: z.strictObject({ requisitionId: z.uuid(), expectedVersion: versionField, reason: reasonField }),
  handler: async ({ tx, actor, request }, input): Promise<{ version: number; status: RequisitionStatus }> => {
    const row = await loadVisible(tx, actor, input.requisitionId);
    if (!isOwner(actor, row)) {
      if (!actor.permissions.has('po.create')) fail('FORBIDDEN', 'Only the requester can cancel this requisition.');
      if (row.status !== 'approved') fail('FORBIDDEN', 'Procurement can cancel a requisition only once it is approved. Before that, only the requester can.');
    }
    assertVersion(row, input.expectedVersion);
    const status = nextRequisitionStatus(row.status, 'cancel');
    if (!status) fail('INVALID_TRANSITION', `A requisition that is ${STATUS_LABEL[row.status]} cannot be cancelled.`);
    if (cancelNeedsReason(row.status) && !input.reason) {
      reasonRequired(row.status === 'pending_approval' ? 'Say why you are withdrawing it (required)' : 'Say why it is cancelled (required)');
    }
    if (row.status === 'approved' && (await findLines(tx, row.id)).some((l) => dec(l.orderedQty).gt(0))) {
      failBusinessRule('ALREADY_ORDERED', 'Part of this requisition is already on a purchase order. Close it instead.');
    }
    if (row.status === 'pending_approval') {
      if (!row.currentApprovalRequestId) throw new Error(`pending requisition ${row.id} has no approval request`);
      await cancelApprovalRequest(tx, request, row.currentApprovalRequestId, input.reason ?? '');
    }
    const version = await updateRequisition(tx, row.id, row.version, {
      status,
      cancelledAt: sql`now()`,
      cancelledByUserId: actor.userId,
      cancelReason: input.reason,
    });
    await recordAuditEvent(tx, request, {
      action: 'requisition.cancelled',
      entityType: 'requisition',
      entityId: row.id,
      changes: auditChanges(requisitionAudit, { status: row.status }, { status }),
      ...(input.reason ? { reason: input.reason } : {}),
    });
    return { version, status };
  },
});

/** PR-T10: procurement closes an approved requisition; what was not ordered can no longer be. */
export const closeRequisition = defineCommand({
  name: 'requisition.close',
  permission: 'po.create',
  input: z.strictObject({ requisitionId: z.uuid(), expectedVersion: versionField, reason: requiredReasonField }),
  handler: async ({ tx, actor, request }, input): Promise<{ version: number; status: RequisitionStatus }> => {
    const row = await loadVisible(tx, actor, input.requisitionId);
    assertVersion(row, input.expectedVersion);
    const status = nextRequisitionStatus(row.status, 'close');
    if (!status) fail('INVALID_TRANSITION', `A requisition that is ${STATUS_LABEL[row.status]} cannot be closed. Only approved requisitions can.`);
    const version = await updateRequisition(tx, row.id, row.version, {
      status,
      closedAt: sql`now()`,
      closedByUserId: actor.userId,
      closeReason: input.reason,
    });
    await recordAuditEvent(tx, request, {
      action: 'requisition.closed',
      entityType: 'requisition',
      entityId: row.id,
      changes: auditChanges(requisitionAudit, { status: row.status }, { status }),
      reason: input.reason,
    });
    return { version, status };
  },
});
