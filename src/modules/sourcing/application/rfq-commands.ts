import 'server-only';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { auditChanges, recordAuditEvent } from '@/modules/audit';
import { findOrganizationTimezone, instantOfLocalDateTime, localDateTimeIn, todayIn } from '@/modules/organization';
import { lockRequisitionForSourcing, type RequisitionForSourcing } from '@/modules/requisitions';
import { findSuppliersByIds } from '@/modules/suppliers';
import { defineCommand } from '@/shared/application/runner';
import { dec } from '@/shared/decimal/decimal';
import { allocateDocumentNumber, formatDocumentNumber } from '@/shared/db/document-numbers';
import { idempotencyKeyField, withIdempotency } from '@/shared/db/idempotency';
import type { Tx } from '@/shared/db/transaction';
import { AppFailure, fail, failBusinessRule } from '@/shared/result';
import { isRfqStatus, nextRfqStatus, type RfqCommand, type RfqStatus } from '../domain/rfq';
import {
  findInvitations,
  findLinesOnOtherRfqs,
  findRfq,
  findRfqLines,
  insertRfq,
  lockRfq,
  replaceRfqLines,
  syncInvitations,
  updateRfq,
  type RfqLineValues,
  type RfqRow,
} from '../infrastructure/rfq-repository';
import { reasonField, rfqAudit, rfqFields, versionField } from './rfq-input';

/*
 * The RFQ lifecycle (US-SRC-01; RFQ-T01 to T04, T06). Award (RFQ-T05) arrives with quotations
 * in Phase 6b. Lock order (ADR 0008 C8): the requisition, then the RFQ.
 */

type DraftInput = { title: string; responseDueAt: string; lines: z.output<typeof rfqFields.lines>; supplierIds: string[] };
type LoadedRfq = RfqRow & { status: RfqStatus };

const STATUS_LABEL: Record<RfqStatus, string> = {
  draft: 'a draft',
  issued: 'issued',
  closed: 'closed',
  awarded: 'awarded',
  cancelled: 'cancelled',
};

function invalid(fieldErrors: Record<string, string[]>): never {
  throw new AppFailure({ code: 'VALIDATION_FAILED', message: 'Some fields are invalid.', fieldErrors });
}

function assertTransition(row: LoadedRfq, command: RfqCommand, verb: string): RfqStatus {
  const status = nextRfqStatus(row.status, command);
  if (!status) fail('INVALID_TRANSITION', `An RFQ that is ${STATUS_LABEL[row.status]} cannot be ${verb}.`);
  return status;
}

function assertVersion(row: RfqRow, expectedVersion: number): void {
  if (row.version !== expectedVersion) fail('CONFLICT', 'This RFQ was changed since you loaded it. Reload the page and try again.');
}

async function lockLoaded(tx: Tx, id: string): Promise<LoadedRfq> {
  const row = await lockRfq(tx, id);
  if (!row) fail('NOT_FOUND', 'RFQ not found.');
  if (!isRfqStatus(row.status)) throw new Error(`Unknown RFQ status ${row.status}`);
  return { ...row, status: row.status };
}

/** The requisition first, then the RFQ (C8). The RFQ is read once without a lock to find its requisition. */
async function lockWithRequisition(tx: Tx, id: string): Promise<{ row: LoadedRfq; requisition: RequisitionForSourcing }> {
  const found = await findRfq(tx, id);
  if (!found) fail('NOT_FOUND', 'RFQ not found.');
  const requisition = await lockRequisitionForSourcing(tx, found.requisitionId);
  if (!requisition) throw new Error(`requisition ${found.requisitionId} of RFQ ${id} is missing`);
  return { row: await lockLoaded(tx, id), requisition };
}

function assertApproved(requisition: RequisitionForSourcing): void {
  if (requisition.status !== 'approved') {
    failBusinessRule('REQUISITION_NOT_APPROVED', `Requisition ${requisition.number} is not approved, so it cannot be sourced.`);
  }
}

type PreparedDraft = { responseDueAt: Date; lines: RfqLineValues[]; supplierIds: string[]; audit: { lines: string[]; suppliers: string[]; responseDueAt: string } };

/** The rules shared by create and update (RFQ-T01 / T02), checked under the requisition's lock. */
async function prepareDraft(tx: Tx, requisition: RequisitionForSourcing, input: DraftInput, exceptRfqId: string | null): Promise<PreparedDraft> {
  assertApproved(requisition);
  const timezone = await findOrganizationTimezone(tx);
  const responseDueAt = instantOfLocalDateTime(timezone, input.responseDueAt);
  if (!responseDueAt) invalid({ responseDueAt: [`This time does not exist in ${timezone}.`] });

  const byId = new Map(requisition.lines.map((l) => [l.id, l]));
  const foreign: Record<string, string[]> = {};
  input.lines.forEach((line, i) => {
    if (!byId.has(line.requisitionLineId)) foreign[`lines.${i}.requisitionLineId`] = [`This line is not on requisition ${requisition.number}.`];
  });
  if (Object.keys(foreign).length > 0) invalid(foreign);
  const chosen = input.lines.map((line) => ({ input: line, source: byId.get(line.requisitionLineId) as RequisitionForSourcing['lines'][number] }));

  const tooMuch = chosen.filter(({ input: line, source }) => dec(line.quantity).gt(dec(source.remainingQty)));
  if (tooMuch.length > 0) {
    const [first] = tooMuch;
    failBusinessRule(
      'QUANTITY_EXCEEDS_REMAINING',
      `Requisition line ${first?.source.lineNo} has only ${first?.source.remainingQty} ${first?.source.uom} left to order.`,
      tooMuch.map(({ source }) => ({ lineNo: source.lineNo, remaining: source.remainingQty })),
    );
  }

  const taken = await findLinesOnOtherRfqs(tx, chosen.map((c) => c.source.id), exceptRfqId);
  if (taken.size > 0) {
    const [lineId, number] = [...taken][0] ?? [];
    failBusinessRule('LINE_ALREADY_IN_RFQ', `Requisition line ${byId.get(lineId ?? '')?.lineNo} is already on ${number}. Cancel that RFQ first.`);
  }

  const suppliers = await findSuppliersByIds(tx, input.supplierIds);
  const notActive = input.supplierIds.filter((id) => suppliers.get(id)?.status !== 'active');
  if (notActive.length > 0) {
    const known = suppliers.get(notActive[0] ?? '');
    failBusinessRule(
      'SUPPLIER_NOT_ACTIVE',
      known ? `${known.legalName} (${known.code}) is not active, so it cannot be invited.` : 'A selected supplier does not exist or is not active.',
    );
  }

  return {
    responseDueAt,
    lines: chosen.map(({ input: line, source }) => ({ requisitionLineId: source.id, description: source.description, quantity: line.quantity, uom: source.uom })),
    supplierIds: input.supplierIds,
    audit: {
      lines: chosen.map(({ input: line, source }, i) => `${i + 1}. ${dec(line.quantity).toString()} ${source.uom} ${source.description} (requisition line ${source.lineNo})`),
      // Sorted, so the same invitations in another order compare equal.
      suppliers: input.supplierIds.map((id) => `${suppliers.get(id)?.code ?? id} ${suppliers.get(id)?.legalName ?? ''}`.trim()).sort(),
      responseDueAt: responseDueAt.toISOString(),
    },
  };
}

/** Audit summaries of what is stored now, comparable with PreparedDraft['audit']. */
async function storedSummary(tx: Tx, row: RfqRow, requisition: RequisitionForSourcing): Promise<{ lines: string[]; suppliers: string[] }> {
  const lineNo = new Map(requisition.lines.map((l) => [l.id, l.lineNo]));
  const lines = await findRfqLines(tx, row.id);
  const invitations = await findInvitations(tx, row.id);
  const suppliers = await findSuppliersByIds(tx, invitations.map((i) => i.supplierId));
  return {
    lines: lines.map((l) => `${l.lineNo}. ${dec(l.quantity).toString()} ${l.uom} ${l.description} (requisition line ${lineNo.get(l.requisitionLineId)})`),
    suppliers: invitations.map((i) => `${suppliers.get(i.supplierId)?.code ?? i.supplierId} ${suppliers.get(i.supplierId)?.legalName ?? ''}`.trim()).sort(),
  };
}

/** RFQ-T01 */
export const createRfq = defineCommand({
  name: 'rfq.create',
  permission: 'rfq.manage',
  input: z.strictObject({ requisitionId: z.uuid(), ...rfqFields, idempotencyKey: idempotencyKeyField }),
  handler: async ({ tx, actor, request, clock }, input) => {
    const { idempotencyKey, ...fields } = input;
    return withIdempotency(tx, { userId: actor.userId, key: idempotencyKey, operation: 'rfq.create', input: fields }, async () => {
      const requisition = await lockRequisitionForSourcing(tx, fields.requisitionId);
      if (!requisition) fail('NOT_FOUND', 'Requisition not found.');
      const draft = await prepareDraft(tx, requisition, fields, null);

      const year = Number(todayIn(await findOrganizationTimezone(tx), clock.now()).slice(0, 4));
      const number = formatDocumentNumber('RFQ', year, await allocateDocumentNumber(tx, 'RFQ', year));
      const rfqId = await insertRfq(tx, {
        number,
        requisitionId: requisition.id,
        title: fields.title,
        responseDueAt: draft.responseDueAt,
        createdByUserId: actor.userId,
      });
      await replaceRfqLines(tx, rfqId, draft.lines);
      await syncInvitations(tx, rfqId, draft.supplierIds, actor.userId);
      await recordAuditEvent(tx, request, {
        action: 'rfq.created',
        entityType: 'rfq',
        entityId: rfqId,
        changes: auditChanges(rfqAudit, null, {
          number,
          requisitionNumber: requisition.number,
          title: fields.title,
          responseDueAt: draft.audit.responseDueAt,
          lines: draft.audit.lines,
          suppliers: draft.audit.suppliers,
          status: 'draft',
        }),
      });
      return { rfqId, number, version: 1 };
    });
  },
});

/** RFQ-T02: replace title, due time, lines, and invitations while the RFQ is a draft. */
export const updateRfqDraft = defineCommand({
  name: 'rfq.update',
  permission: 'rfq.manage',
  input: z.strictObject({ rfqId: z.uuid(), expectedVersion: versionField, ...rfqFields }),
  handler: async ({ tx, actor, request }, input): Promise<{ version: number }> => {
    const { row, requisition } = await lockWithRequisition(tx, input.rfqId);
    assertVersion(row, input.expectedVersion);
    assertTransition(row, 'update', 'edited');
    const draft = await prepareDraft(tx, requisition, input, row.id);
    const stored = await storedSummary(tx, row, requisition);
    const changes = auditChanges(
      rfqAudit,
      { title: row.title, responseDueAt: row.responseDueAt.toISOString(), lines: stored.lines, suppliers: stored.suppliers },
      { title: input.title, responseDueAt: draft.audit.responseDueAt, lines: draft.audit.lines, suppliers: draft.audit.suppliers },
    );
    if (Object.keys(changes).length === 0) return { version: row.version };

    if (changes.lines) await replaceRfqLines(tx, row.id, draft.lines);
    if (changes.suppliers) await syncInvitations(tx, row.id, draft.supplierIds, actor.userId);
    const version = await updateRfq(tx, row.id, row.version, { title: input.title, responseDueAt: draft.responseDueAt });
    await recordAuditEvent(tx, request, { action: 'rfq.updated', entityType: 'rfq', entityId: row.id, changes });
    return { version };
  },
});

/** RFQ-T03: v1 sends nothing to suppliers; the buyer contacts them out of band. */
export const issueRfq = defineCommand({
  name: 'rfq.issue',
  permission: 'rfq.manage',
  input: z.strictObject({ rfqId: z.uuid(), expectedVersion: versionField }),
  handler: async ({ tx, actor, request, clock }, input): Promise<{ version: number; status: RfqStatus }> => {
    const { row, requisition } = await lockWithRequisition(tx, input.rfqId);
    assertVersion(row, input.expectedVersion);
    const status = assertTransition(row, 'issue', 'issued');
    assertApproved(requisition);
    const invitations = await findInvitations(tx, row.id);
    if (invitations.length === 0) failBusinessRule('NO_SUPPLIERS_INVITED', 'Invite at least one supplier before issuing the RFQ.');
    if (row.responseDueAt.getTime() <= clock.now().getTime()) {
      const due = localDateTimeIn(await findOrganizationTimezone(tx), row.responseDueAt).replace('T', ' ');
      failBusinessRule('RESPONSE_DUE_IN_PAST', `The response due time (${due}) has passed. Set a later one before issuing.`);
    }
    const suppliers = await findSuppliersByIds(tx, invitations.map((i) => i.supplierId));
    const inactive = [...suppliers.values()].find((s) => s.status !== 'active');
    if (inactive) failBusinessRule('SUPPLIER_NOT_ACTIVE', `${inactive.legalName} (${inactive.code}) is no longer active. Remove it from the RFQ first.`);

    const version = await updateRfq(tx, row.id, row.version, { status, issuedAt: sql`now()`, issuedByUserId: actor.userId });
    await recordAuditEvent(tx, request, {
      action: 'rfq.issued',
      entityType: 'rfq',
      entityId: row.id,
      changes: auditChanges(rfqAudit, { status: row.status }, { status }),
    });
    return { version, status };
  },
});

/** RFQ-T04: no more quotations. */
export const closeRfq = defineCommand({
  name: 'rfq.close',
  permission: 'rfq.manage',
  input: z.strictObject({ rfqId: z.uuid(), expectedVersion: versionField }),
  handler: async ({ tx, actor, request }, input): Promise<{ version: number; status: RfqStatus }> => {
    const row = await lockLoaded(tx, input.rfqId);
    assertVersion(row, input.expectedVersion);
    const status = assertTransition(row, 'close', 'closed');
    const version = await updateRfq(tx, row.id, row.version, { status, closedAt: sql`now()`, closedByUserId: actor.userId });
    await recordAuditEvent(tx, request, {
      action: 'rfq.closed',
      entityType: 'rfq',
      entityId: row.id,
      changes: auditChanges(rfqAudit, { status: row.status }, { status }),
    });
    return { version, status };
  },
});

/** RFQ-T06: the requisition lines become free for another RFQ. */
export const cancelRfq = defineCommand({
  name: 'rfq.cancel',
  permission: 'rfq.manage',
  input: z.strictObject({ rfqId: z.uuid(), expectedVersion: versionField, reason: reasonField }),
  handler: async ({ tx, actor, request }, input): Promise<{ version: number; status: RfqStatus }> => {
    const row = await lockLoaded(tx, input.rfqId);
    assertVersion(row, input.expectedVersion);
    const status = assertTransition(row, 'cancel', 'cancelled');
    const version = await updateRfq(tx, row.id, row.version, {
      status,
      cancelledAt: sql`now()`,
      cancelledByUserId: actor.userId,
      cancelReason: input.reason,
    });
    await recordAuditEvent(tx, request, {
      action: 'rfq.cancelled',
      entityType: 'rfq',
      entityId: row.id,
      changes: auditChanges(rfqAudit, { status: row.status }, { status }),
      reason: input.reason,
    });
    return { version, status };
  },
});
