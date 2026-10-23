import 'server-only';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { auditChanges, recordAuditEvent } from '@/modules/audit';
import { findDepartmentDirectory, resolveActor } from '@/modules/identity';
import { findOrganizationTimezone, lockCurrencyForNewDocument, todayIn } from '@/modules/organization';
import type { Actor } from '@/shared/application/context';
import { defineCommand } from '@/shared/application/runner';
import { dec, toFixedScale } from '@/shared/decimal/decimal';
import { priceDocument } from '@/shared/decimal/pricing';
import { allocateDocumentNumber, formatDocumentNumber } from '@/shared/db/document-numbers';
import { idempotencyKeyField, withIdempotency } from '@/shared/db/idempotency';
import type { Tx } from '@/shared/db/transaction';
import { fail, failBusinessRule } from '@/shared/result';
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
import { lineSummaries, requisitionAudit, requisitionFields, versionField } from './requisition-input';
import { visibilityFor } from './visibility';

/*
 * Drafting purchase requisitions (US-PR-01, 02, 04; PR-T01, T02, T07). Submission and the
 * approval-driven transitions arrive in Phase 5b.
 */

type Fields = { title: string; justification: string | null; neededBy: string; lines: z.output<typeof requisitionFields.lines> };

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

/**
 * The requisition for a change by its requester. Someone who may see it but is not the
 * requester gets FORBIDDEN; someone who may not even see it gets NOT_FOUND (ADR 0006 §4).
 */
async function loadOwn(tx: Tx, actor: Actor, id: string, expectedVersion: number): Promise<RequisitionRow & { status: RequisitionStatus }> {
  const row = await lockRequisition(tx, id);
  if (!row || !isVisible(await visibilityFor(tx, actor), row)) fail('NOT_FOUND', 'Requisition not found.');
  if (row.requesterUserId !== actor.userId) fail('FORBIDDEN', 'Only the requester can change this requisition.');
  if (row.version !== expectedVersion) fail('CONFLICT', 'This requisition was changed since you loaded it. Reload the page and try again.');
  if (!isRequisitionStatus(row.status)) throw new Error(`Unknown requisition status ${row.status}`);
  return { ...row, status: row.status };
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

/** PR-T07 (draft / returned). Withdrawing a submitted or approved requisition is Phase 5b. */
export const cancelRequisition = defineCommand({
  name: 'requisition.cancel',
  permission: 'requisition.create',
  input: z.strictObject({
    requisitionId: z.uuid(),
    expectedVersion: versionField,
    reason: z.preprocess(
      (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? null : v),
      z.string().trim().max(500).nullable(),
    ),
  }),
  handler: async ({ tx, actor, request }, input): Promise<{ version: number; status: RequisitionStatus }> => {
    const row = await loadOwn(tx, actor, input.requisitionId, input.expectedVersion);
    const status = nextRequisitionStatus(row.status, 'cancel');
    if (!status || cancelNeedsReason(row.status)) {
      fail('INVALID_TRANSITION', `A requisition that is ${STATUS_LABEL[row.status]} cannot be cancelled here.`);
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
