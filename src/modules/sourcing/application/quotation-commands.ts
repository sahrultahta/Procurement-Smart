import 'server-only';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { auditChanges, recordAuditEvent } from '@/modules/audit';
import { findSourcingRules, todayIn } from '@/modules/organization';
import { findRequisitionForSourcing, type RequisitionForSourcing } from '@/modules/requisitions';
import { findSuppliersByIds, type SupplierRecord } from '@/modules/suppliers';
import { defineCommand } from '@/shared/application/runner';
import { dec, toFixedScale } from '@/shared/decimal/decimal';
import { priceDocument } from '@/shared/decimal/pricing';
import { idempotencyKeyField, withIdempotency } from '@/shared/db/idempotency';
import type { Tx } from '@/shared/db/transaction';
import { AppFailure, fail, failBusinessRule } from '@/shared/result';
import { isLate, isQuotationStatus, nextQuotationStatus, rfqAllows, type QuotationAction, type QuotationCommand, type QuotationStatus } from '../domain/quotation';
import {
  findLiveQuotation,
  findQuotation,
  findQuotationLines,
  insertQuotation,
  lockQuotation,
  replaceQuotationLines,
  updateQuotation,
  type QuotationLineValues,
  type QuotationRow,
} from '../infrastructure/quotation-repository';
import { findInvitations, findRfqLines, type RfqLineRow } from '../infrastructure/rfq-repository';
import { quotationAudit, quotationFields, quotationLineSummary } from './quotation-input';
import { reasonField, versionField } from './rfq-input';
import { RFQ_STATUS_LABEL, lockRfqRow, type LoadedRfq } from './rfq-locks';

/*
 * Quotations (US-SRC-02; QUO-T01 to T04). The buyer records what an invited supplier sent, edits
 * it while it is a draft, and submits it once it is complete. Lock order (ADR 0008 C8): the RFQ,
 * then the quotation; the RFQ row lock makes one supplier's parallel recordings queue up.
 */

type LoadedQuotation = QuotationRow & { status: QuotationStatus };
type Fields = { supplierReference: string | null; validUntil: string; leadTimeDays: number; lines: z.output<typeof quotationFields.lines> };

const STATUS_LABEL: Record<QuotationStatus, string> = {
  draft: 'a draft',
  submitted: 'submitted',
  withdrawn: 'withdrawn',
  awarded: 'awarded',
  not_awarded: 'not awarded',
};

const RFQ_GATE: Record<QuotationAction, string> = {
  record: 'Quotations can be recorded only while the RFQ is issued',
  update: 'A draft quotation can be edited only while the RFQ is issued',
  submit: 'A quotation can be submitted only while the RFQ is issued',
  discard: 'A draft quotation can be discarded only while the RFQ is issued',
  withdraw: 'A submitted quotation can be withdrawn only until the RFQ is awarded',
  award: 'A quotation can be awarded only once the RFQ is closed',
};

function invalid(fieldErrors: Record<string, string[]>): never {
  throw new AppFailure({ code: 'VALIDATION_FAILED', message: 'Some fields are invalid.', fieldErrors });
}

function assertRfqAllows(rfq: LoadedRfq, action: QuotationAction): void {
  if (!rfqAllows(action, rfq.status)) fail('INVALID_TRANSITION', `${RFQ_GATE[action]}; ${rfq.number} is ${RFQ_STATUS_LABEL[rfq.status]}.`);
}

function assertTransition(row: LoadedQuotation, command: QuotationCommand, verb: string): QuotationStatus {
  const status = nextQuotationStatus(row.status, command);
  if (!status) fail('INVALID_TRANSITION', `A quotation that is ${STATUS_LABEL[row.status]} cannot be ${verb}.`);
  return status;
}

function assertVersion(row: QuotationRow, expectedVersion: number): void {
  if (row.version !== expectedVersion) fail('CONFLICT', 'This quotation was changed since you loaded it. Reload the page and try again.');
}

function loaded(row: QuotationRow): LoadedQuotation {
  if (!isQuotationStatus(row.status)) throw new Error(`Unknown quotation status ${row.status}`);
  return { ...row, status: row.status };
}

/** The RFQ, then the quotation (C8). The quotation is read once without a lock to find its RFQ. */
export async function lockQuotationWithRfq(tx: Tx, quotationId: string): Promise<{ rfq: LoadedRfq; row: LoadedQuotation }> {
  const found = await findQuotation(tx, quotationId);
  if (!found) fail('NOT_FOUND', 'Quotation not found.');
  const rfq = await lockRfqRow(tx, found.rfqId);
  const row = await lockQuotation(tx, quotationId);
  if (!row) throw new Error(`quotation ${quotationId} disappeared under its RFQ's lock`);
  return { rfq, row: loaded(row) };
}

async function requisitionOf(tx: Tx, rfq: LoadedRfq): Promise<RequisitionForSourcing> {
  const requisition = await findRequisitionForSourcing(tx, rfq.requisitionId);
  if (!requisition) throw new Error(`requisition ${rfq.requisitionId} of RFQ ${rfq.id} is missing`);
  return requisition;
}

function supplierName(supplier: SupplierRecord | undefined, id: string): string {
  return supplier ? `${supplier.code} ${supplier.legalName}` : id;
}

type Priced = { lines: QuotationLineValues[]; total: string; summary: string[] };

/**
 * Server-side pricing (ADR 0007): quantities come from the RFQ, never from input, and every RFQ
 * line is priced exactly once. Totals are rounded to the requisition's currency scale.
 */
function price(rfq: LoadedRfq, rfqLines: readonly RfqLineRow[], input: Fields['lines'], scale: number): Priced {
  const byId = new Map(rfqLines.map((l) => [l.id, l]));
  const foreign: Record<string, string[]> = {};
  input.forEach((line, i) => {
    if (!byId.has(line.rfqLineId)) foreign[`lines.${i}.rfqLineId`] = [`This line is not on ${rfq.number}.`];
  });
  if (Object.keys(foreign).length > 0) invalid(foreign);
  const priceOf = new Map(input.map((l) => [l.rfqLineId, l.unitPrice]));
  const missing = rfqLines.filter((l) => !priceOf.has(l.id));
  if (missing.length > 0) invalid({ lines: [`Enter a unit price for every line: line ${missing.map((l) => l.lineNo).join(', ')} is missing.`] });

  const priced = priceDocument(
    rfqLines.map((l) => ({ quantity: l.quantity, unitPrice: priceOf.get(l.id) as string })),
    scale,
  );
  return {
    total: priced.total,
    lines: rfqLines.map((l, i) => ({ rfqLineId: l.id, quantity: l.quantity, unitPrice: priceOf.get(l.id) as string, lineTotal: priced.lines[i]?.lineTotal ?? '0' })),
    summary: rfqLines.map((l, i) =>
      quotationLineSummary(l.lineNo, { ...l, unitPrice: priceOf.get(l.id) as string, lineTotal: priced.lines[i]?.lineTotal ?? '0' }),
    ),
  };
}

/** Audit summaries of the stored lines, comparable with Priced['summary']. */
async function storedSummary(tx: Tx, row: QuotationRow, rfqLines: readonly RfqLineRow[], scale: number): Promise<string[]> {
  const stored = new Map((await findQuotationLines(tx, [row.id])).map((l) => [l.rfqLineId, l]));
  return rfqLines.flatMap((l) => {
    const line = stored.get(l.id);
    return line ? [quotationLineSummary(l.lineNo, { ...l, unitPrice: line.unitPrice, lineTotal: toFixedScale(dec(line.lineTotal), scale) })] : [];
  });
}

/** QUO-T01: a draft, from an invited and active supplier without another live quotation on this RFQ. */
export const recordQuotation = defineCommand({
  name: 'quotation.record',
  permission: 'quotation.record',
  input: z.strictObject({ rfqId: z.uuid(), supplierId: z.uuid(), ...quotationFields, idempotencyKey: idempotencyKeyField }),
  handler: async ({ tx, actor, request }, input) => {
    const { idempotencyKey, ...fields } = input;
    return withIdempotency(tx, { userId: actor.userId, key: idempotencyKey, operation: 'quotation.record', input: fields }, async () => {
      const rfq = await lockRfqRow(tx, fields.rfqId);
      assertRfqAllows(rfq, 'record');
      if (!(await findInvitations(tx, rfq.id)).some((i) => i.supplierId === fields.supplierId)) {
        failBusinessRule('SUPPLIER_NOT_INVITED', `This supplier was not invited to ${rfq.number}, so its quotation cannot be recorded.`);
      }
      const supplier = (await findSuppliersByIds(tx, [fields.supplierId])).get(fields.supplierId);
      if (supplier?.status !== 'active') {
        failBusinessRule('SUPPLIER_NOT_ACTIVE', `${supplierName(supplier, fields.supplierId)} is no longer active, so its quotation cannot be recorded.`);
      }
      // While the RFQ is issued, a live quotation is a draft or submitted.
      const live = await findLiveQuotation(tx, rfq.id, supplier.id);
      if (live) {
        failBusinessRule(
          'SUPPLIER_ALREADY_QUOTED',
          `${supplier.legalName} already has a ${live.status === 'draft' ? 'draft' : 'submitted'} quotation on ${rfq.number}. Edit it, or withdraw it before recording a new one.`,
        );
      }

      const requisition = await requisitionOf(tx, rfq);
      const priced = price(rfq, await findRfqLines(tx, rfq.id), fields.lines, requisition.currencyScale);
      const quotationId = await insertQuotation(tx, {
        rfqId: rfq.id,
        supplierId: supplier.id,
        supplierReference: fields.supplierReference,
        currencyCode: requisition.currencyCode,
        validUntil: fields.validUntil,
        leadTimeDays: fields.leadTimeDays,
        total: priced.total,
        recordedByUserId: actor.userId,
      });
      await replaceQuotationLines(tx, quotationId, priced.lines);
      await recordAuditEvent(tx, request, {
        action: 'quotation.recorded',
        entityType: 'quotation',
        entityId: quotationId,
        changes: auditChanges(quotationAudit, null, {
          rfqNumber: rfq.number,
          supplier: supplierName(supplier, supplier.id),
          supplierReference: fields.supplierReference,
          currencyCode: requisition.currencyCode,
          validUntil: fields.validUntil,
          leadTimeDays: fields.leadTimeDays,
          lines: priced.summary,
          total: priced.total,
          status: 'draft',
        }),
      });
      return { quotationId, version: 1 };
    });
  },
});

/** QUO-T02: replace the terms and prices while the quotation is a draft. */
export const updateQuotationDraft = defineCommand({
  name: 'quotation.update',
  permission: 'quotation.record',
  input: z.strictObject({ quotationId: z.uuid(), expectedVersion: versionField, ...quotationFields }),
  handler: async ({ tx, request }, input): Promise<{ version: number; rfqId: string }> => {
    const { rfq, row } = await lockQuotationWithRfq(tx, input.quotationId);
    assertVersion(row, input.expectedVersion);
    assertTransition(row, 'update', 'edited');
    assertRfqAllows(rfq, 'update');
    const { currencyScale } = await requisitionOf(tx, rfq);
    const rfqLines = await findRfqLines(tx, rfq.id);
    const priced = price(rfq, rfqLines, input.lines, currencyScale);
    const changes = auditChanges(
      quotationAudit,
      {
        supplierReference: row.supplierReference,
        validUntil: row.validUntil,
        leadTimeDays: row.leadTimeDays,
        lines: await storedSummary(tx, row, rfqLines, currencyScale),
        total: toFixedScale(dec(row.total), currencyScale),
      },
      { supplierReference: input.supplierReference, validUntil: input.validUntil, leadTimeDays: input.leadTimeDays, lines: priced.summary, total: priced.total },
    );
    if (Object.keys(changes).length === 0) return { version: row.version, rfqId: rfq.id };

    if (changes.lines) await replaceQuotationLines(tx, row.id, priced.lines);
    const version = await updateQuotation(tx, row.id, row.version, {
      supplierReference: input.supplierReference,
      validUntil: input.validUntil,
      leadTimeDays: input.leadTimeDays,
      total: priced.total,
    });
    await recordAuditEvent(tx, request, { action: 'quotation.updated', entityType: 'quotation', entityId: row.id, changes });
    return { version, rfqId: rfq.id };
  },
});

/**
 * QUO-T03: the quotation now counts in the comparison and can no longer be edited. Still valid
 * today (org time zone) and from an active supplier. After the RFQ's due time it is accepted and
 * flagged late (maintainer decision 2026-10-25). The submission time comes from the application
 * clock, the same one that decides lateness.
 */
export const submitQuotation = defineCommand({
  name: 'quotation.submit',
  permission: 'quotation.record',
  input: z.strictObject({ quotationId: z.uuid(), expectedVersion: versionField }),
  handler: async ({ tx, actor, request, clock }, input): Promise<{ version: number; status: QuotationStatus; late: boolean; rfqId: string }> => {
    const { rfq, row } = await lockQuotationWithRfq(tx, input.quotationId);
    assertVersion(row, input.expectedVersion);
    const status = assertTransition(row, 'submit', 'submitted');
    assertRfqAllows(rfq, 'submit');
    const supplier = (await findSuppliersByIds(tx, [row.supplierId])).get(row.supplierId);
    if (supplier?.status !== 'active') {
      failBusinessRule('SUPPLIER_NOT_ACTIVE', `${supplierName(supplier, row.supplierId)} is no longer active, so its quotation cannot be submitted.`);
    }
    const now = clock.now();
    const today = todayIn((await findSourcingRules(tx)).timezone, now);
    if (row.validUntil < today) {
      failBusinessRule('QUOTATION_EXPIRED', `This quotation was valid until ${row.validUntil}. Ask the supplier to confirm a new date and edit it before submitting.`);
    }
    const late = isLate(now, rfq.responseDueAt);
    const version = await updateQuotation(tx, row.id, row.version, { status, submittedAt: now, submittedByUserId: actor.userId });
    await recordAuditEvent(tx, request, {
      action: 'quotation.submitted',
      entityType: 'quotation',
      entityId: row.id,
      changes: auditChanges(quotationAudit, { status: row.status }, { status, late }),
    });
    return { version, status, late, rfqId: rfq.id };
  },
});

/**
 * QUO-T04, with a reason: a submitted quotation until the RFQ is awarded; a draft while the RFQ
 * is issued (discarding it). The supplier may then record a new quotation while the RFQ is issued.
 */
export const withdrawQuotation = defineCommand({
  name: 'quotation.withdraw',
  permission: 'quotation.record',
  input: z.strictObject({ quotationId: z.uuid(), expectedVersion: versionField, reason: reasonField }),
  handler: async ({ tx, actor, request }, input): Promise<{ version: number; status: QuotationStatus; rfqId: string }> => {
    const { rfq, row } = await lockQuotationWithRfq(tx, input.quotationId);
    assertVersion(row, input.expectedVersion);
    const status = assertTransition(row, 'withdraw', 'withdrawn');
    assertRfqAllows(rfq, row.status === 'draft' ? 'discard' : 'withdraw');
    const version = await updateQuotation(tx, row.id, row.version, {
      status,
      withdrawnAt: sql`now()`,
      withdrawnByUserId: actor.userId,
      withdrawReason: input.reason,
    });
    await recordAuditEvent(tx, request, {
      action: 'quotation.withdrawn',
      entityType: 'quotation',
      entityId: row.id,
      changes: auditChanges(quotationAudit, { status: row.status }, { status }),
      reason: input.reason,
    });
    return { version, status, rfqId: rfq.id };
  },
});
