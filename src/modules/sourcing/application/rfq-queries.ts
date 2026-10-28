import 'server-only';
import { z } from 'zod';
import { findEntityHistory, type HistoryEntryDto } from '@/modules/audit';
import { findUserDisplayNames } from '@/modules/identity';
import { findSourcingRules, todayIn } from '@/modules/organization';
import { findRequisitionForSourcing, findRequisitionHeaders, type RequisitionStatus } from '@/modules/requisitions';
import { findActiveSuppliers, findSuppliersByIds, type SupplierStatus } from '@/modules/suppliers';
import { defineQuery } from '@/shared/application/runner';
import { dec, toFixedScale } from '@/shared/decimal/decimal';
import { fail } from '@/shared/result';
import { compareQuotations } from '../domain/comparison';
import { isLate, rfqAllows, type QuotationStatus, type Validity } from '../domain/quotation';
import { RFQ_STATUSES, nextRfqStatus, type RfqStatus } from '../domain/rfq';
import { findQuotationLines, findQuotations } from '../infrastructure/quotation-repository';
import { findInvitations, findLinesOnOtherRfqs, findRfq, findRfqLines, searchRfqs, type RfqSummaryRow } from '../infrastructure/rfq-repository';
import { toCompared } from './award';

/*
 * RFQ read models. Everyone with `rfq.read` (procurement, finance, auditor; ADR 0006 amendment)
 * sees every RFQ, with its quotations and their comparison: these roles also read every
 * requisition. User names, never ids, reach clients.
 */

export const RFQ_ACTIONS = ['edit', 'issue', 'close', 'cancel', 'record', 'award'] as const;
export type RfqAction = (typeof RFQ_ACTIONS)[number];

export type RfqSummaryDto = {
  id: string;
  number: string;
  title: string;
  status: RfqStatus;
  requisitionId: string;
  requisitionNumber: string;
  responseDueAt: string;
  lineCount: number;
  supplierCount: number;
  createdAt: string;
};
export const RFQ_SUMMARY_KEYS = [
  'id',
  'number',
  'title',
  'status',
  'requisitionId',
  'requisitionNumber',
  'responseDueAt',
  'lineCount',
  'supplierCount',
  'createdAt',
] as const;

export type RfqLineDto = { id: string; lineNo: number; requisitionLineNo: number; description: string; quantity: string; uom: string };
export const RFQ_LINE_KEYS = ['id', 'lineNo', 'requisitionLineNo', 'description', 'quantity', 'uom'] as const;

export type InvitedSupplierDto = { id: string; code: string; legalName: string; status: SupplierStatus; invitedAt: string };
export const INVITED_SUPPLIER_KEYS = ['id', 'code', 'legalName', 'status', 'invitedAt'] as const;

export const QUOTATION_ACTIONS = ['edit', 'submit', 'discard', 'withdraw'] as const;
export type QuotationActionDto = (typeof QUOTATION_ACTIONS)[number];

/** Prices without trailing zeros, line totals at the currency scale. */
export type QuotationLineDto = { rfqLineId: string; rfqLineNo: number; unitPrice: string; lineTotal: string; lowestOnLine: boolean };
export const QUOTATION_LINE_KEYS = ['rfqLineId', 'rfqLineNo', 'unitPrice', 'lineTotal', 'lowestOnLine'] as const;

export type QuotationDto = {
  id: string;
  supplierId: string;
  supplierCode: string;
  supplierName: string;
  supplierStatus: SupplierStatus;
  supplierReference: string | null;
  status: QuotationStatus;
  validUntil: string;
  leadTimeDays: number;
  total: string;
  recordedBy: string;
  recordedAt: string;
  submittedAt: string | null;
  submittedBy: string | null;
  /** Submitted after the RFQ's due time. */
  late: boolean;
  withdrawnAt: string | null;
  withdrawnBy: string | null;
  withdrawReason: string | null;
  /** Today, in the organization's time zone. */
  validity: Validity;
  /** The lowest total among valid quotations (ties included). */
  lowest: boolean;
  version: number;
  lines: QuotationLineDto[];
  callerActions: QuotationActionDto[];
};
export const QUOTATION_KEYS = [
  'id',
  'supplierId',
  'supplierCode',
  'supplierName',
  'supplierStatus',
  'supplierReference',
  'status',
  'validUntil',
  'leadTimeDays',
  'total',
  'recordedBy',
  'recordedAt',
  'submittedAt',
  'submittedBy',
  'late',
  'withdrawnAt',
  'withdrawnBy',
  'withdrawReason',
  'validity',
  'lowest',
  'version',
  'lines',
  'callerActions',
] as const;

/** The award rule as it applies today (current settings), for the comparison and the award form. */
export type ComparisonDto = {
  today: string;
  /** The RFQ's due time has passed: what is submitted now is late. */
  pastDue: boolean;
  validCount: number;
  lowestTotal: string | null;
  rfqRequiredAbove: string | null;
  minQuotes: number;
  minQuotesApplies: boolean;
  belowMinQuotes: boolean;
};
export const COMPARISON_KEYS = ['today', 'pastDue', 'validCount', 'lowestTotal', 'rfqRequiredAbove', 'minQuotes', 'minQuotesApplies', 'belowMinQuotes'] as const;

/** What was awarded, and the rule as it stood then. */
export type AwardDto = {
  quotationId: string;
  supplierName: string;
  total: string;
  awardedBy: string;
  awardedAt: string;
  justification: string | null;
  rfqRequiredAbove: string | null;
  minQuotes: number;
  validQuotations: number;
  belowMinQuotes: boolean;
  notLowest: boolean;
};
export const AWARD_KEYS = [
  'quotationId',
  'supplierName',
  'total',
  'awardedBy',
  'awardedAt',
  'justification',
  'rfqRequiredAbove',
  'minQuotes',
  'validQuotations',
  'belowMinQuotes',
  'notLowest',
] as const;

export type RfqDetailDto = Omit<RfqSummaryDto, 'lineCount' | 'supplierCount'> & {
  requisitionTitle: string;
  requisitionStatus: RequisitionStatus;
  requisitionEstimatedTotal: string;
  currencyCode: string;
  currencyScale: number;
  createdBy: string;
  issuedAt: string | null;
  issuedBy: string | null;
  closedAt: string | null;
  closedBy: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancelReason: string | null;
  updatedAt: string;
  version: number;
  lines: RfqLineDto[];
  suppliers: InvitedSupplierDto[];
  quotations: QuotationDto[];
  comparison: ComparisonDto;
  award: AwardDto | null;
  callerActions: RfqAction[];
  /** The RFQ's and its quotations' audit trail, oldest first (Phase 9). */
  history: HistoryEntryDto[];
};
export const RFQ_DETAIL_KEYS = [
  'id',
  'number',
  'title',
  'status',
  'requisitionId',
  'requisitionNumber',
  'requisitionTitle',
  'requisitionStatus',
  'requisitionEstimatedTotal',
  'currencyCode',
  'currencyScale',
  'responseDueAt',
  'createdBy',
  'createdAt',
  'issuedAt',
  'issuedBy',
  'closedAt',
  'closedBy',
  'cancelledAt',
  'cancelledBy',
  'cancelReason',
  'updatedAt',
  'version',
  'lines',
  'suppliers',
  'quotations',
  'comparison',
  'award',
  'callerActions',
  'history',
] as const;

export const listRfqs = defineQuery({
  name: 'rfq.list',
  permission: 'rfq.read',
  input: z.strictObject({
    status: z.enum(RFQ_STATUSES).optional(),
    requisitionId: z.uuid().optional(),
    q: z.string().trim().max(100).optional(),
    cursor: z
      .string()
      .regex(/^RFQ-[0-9]{4}-[0-9]{6}$/, 'Invalid cursor')
      .optional(),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  handler: async ({ tx }, input): Promise<{ items: RfqSummaryDto[]; nextCursor: string | null }> => {
    const rows = await searchRfqs(tx, {
      status: input.status,
      requisitionId: input.requisitionId,
      q: input.q ?? '',
      beforeNumber: input.cursor,
      limit: input.limit + 1,
    });
    const page = rows.slice(0, input.limit);
    const headers = await findRequisitionHeaders(tx, page.map((r) => r.requisitionId));
    const last = page.at(-1);
    return {
      items: page.map((row) => summary(row, headers.get(row.requisitionId)?.number ?? '')),
      nextCursor: rows.length > input.limit && last ? last.number : null,
    };
  },
});

function summary(row: RfqSummaryRow, requisitionNumber: string): RfqSummaryDto {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    status: row.status as RfqStatus,
    requisitionId: row.requisitionId,
    requisitionNumber,
    responseDueAt: row.responseDueAt.toISOString(),
    lineCount: row.lineCount,
    supplierCount: row.supplierCount,
    createdAt: row.createdAt.toISOString(),
  };
}

function actionsFor(status: RfqStatus, can: { manage: boolean; record: boolean; award: boolean }, requisitionApproved: boolean): RfqAction[] {
  const actions: RfqAction[] = [];
  if (can.manage) {
    if (nextRfqStatus(status, 'update')) actions.push('edit');
    if (nextRfqStatus(status, 'issue')) actions.push('issue');
    if (nextRfqStatus(status, 'close')) actions.push('close');
    if (nextRfqStatus(status, 'cancel')) actions.push('cancel');
  }
  if (can.record && rfqAllows('record', status)) actions.push('record');
  if (can.award && rfqAllows('award', status) && requisitionApproved) actions.push('award');
  return actions;
}

function quotationActionsFor(status: QuotationStatus, rfqStatus: RfqStatus, canRecord: boolean): QuotationActionDto[] {
  if (!canRecord) return [];
  if (status === 'draft') {
    return [
      ...(rfqAllows('update', rfqStatus) ? (['edit'] as const) : []),
      ...(rfqAllows('submit', rfqStatus) ? (['submit'] as const) : []),
      ...(rfqAllows('discard', rfqStatus) ? (['discard'] as const) : []),
    ];
  }
  return status === 'submitted' && rfqAllows('withdraw', rfqStatus) ? ['withdraw'] : [];
}

export const getRfq = defineQuery({
  name: 'rfq.get',
  permission: 'rfq.read',
  input: z.strictObject({ rfqId: z.uuid() }),
  handler: async ({ tx, actor, clock }, input): Promise<RfqDetailDto> => {
    const row = await findRfq(tx, input.rfqId);
    if (!row) fail('NOT_FOUND', 'RFQ not found.');
    const requisition = await findRequisitionForSourcing(tx, row.requisitionId);
    if (!requisition) throw new Error(`requisition ${row.requisitionId} of RFQ ${row.id} is missing`);
    const lines = await findRfqLines(tx, row.id);
    const invitations = await findInvitations(tx, row.id);
    const quotations = await findQuotations(tx, row.id);
    const quotationLines = await findQuotationLines(tx, quotations.map((q) => q.id));
    const suppliers = await findSuppliersByIds(tx, [...invitations.map((i) => i.supplierId), ...quotations.map((q) => q.supplierId)]);
    const userIds = [
      row.createdByUserId,
      row.issuedByUserId,
      row.closedByUserId,
      row.cancelledByUserId,
      row.awardedByUserId,
      ...quotations.flatMap((q) => [q.recordedByUserId, q.submittedByUserId, q.withdrawnByUserId]),
    ].filter((id): id is string => id !== null);
    const names = await findUserDisplayNames(tx, userIds);
    const nameOf = (id: string | null) => (id ? (names.get(id) ?? 'Unknown user') : null);
    const lineNo = new Map(requisition.lines.map((l) => [l.id, l.lineNo]));
    const rfqLineNo = new Map(lines.map((l) => [l.id, l.lineNo]));
    const status = row.status as RfqStatus;
    const scale = requisition.currencyScale;
    const money = (value: string) => toFixedScale(dec(value), scale);

    const rules = await findSourcingRules(tx);
    const today = todayIn(rules.timezone, clock.now());
    const active = new Set([...suppliers.values()].filter((s) => s.status === 'active').map((s) => s.id));
    const comparison = compareQuotations(
      toCompared(quotations, quotationLines, active),
      lines.map((l) => l.id),
      { estimatedTotal: requisition.estimatedTotal, rfqRequiredAbove: rules.rfqRequiredAbove, minQuotes: rules.minQuotes },
      today,
    );
    const canRecord = actor.permissions.has('quotation.record');
    const supplierLabel = (id: string) => suppliers.get(id)?.legalName ?? 'Unknown supplier';
    const awarded = quotations.find((q) => q.id === row.awardedQuotationId);

    return {
      id: row.id,
      number: row.number,
      title: row.title,
      status,
      requisitionId: requisition.id,
      requisitionNumber: requisition.number,
      requisitionTitle: requisition.title,
      requisitionStatus: requisition.status,
      requisitionEstimatedTotal: requisition.estimatedTotal,
      currencyCode: requisition.currencyCode,
      currencyScale: scale,
      responseDueAt: row.responseDueAt.toISOString(),
      createdBy: nameOf(row.createdByUserId) ?? 'Unknown user',
      createdAt: row.createdAt.toISOString(),
      issuedAt: row.issuedAt?.toISOString() ?? null,
      issuedBy: nameOf(row.issuedByUserId),
      closedAt: row.closedAt?.toISOString() ?? null,
      closedBy: nameOf(row.closedByUserId),
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      cancelledBy: nameOf(row.cancelledByUserId),
      cancelReason: row.cancelReason,
      updatedAt: row.updatedAt.toISOString(),
      version: row.version,
      lines: lines.map((l) => ({
        id: l.id,
        lineNo: l.lineNo,
        requisitionLineNo: lineNo.get(l.requisitionLineId) ?? 0,
        description: l.description,
        quantity: dec(l.quantity).toString(),
        uom: l.uom,
      })),
      suppliers: invitations.map((i) => {
        const supplier = suppliers.get(i.supplierId);
        return {
          id: i.supplierId,
          code: supplier?.code ?? '',
          legalName: supplier?.legalName ?? 'Unknown supplier',
          status: supplier?.status ?? 'inactive',
          invitedAt: i.invitedAt.toISOString(),
        };
      }),
      quotations: quotations.map((q) => {
        const qStatus = q.status as QuotationStatus;
        const supplier = suppliers.get(q.supplierId);
        return {
          id: q.id,
          supplierId: q.supplierId,
          supplierCode: supplier?.code ?? '',
          supplierName: supplierLabel(q.supplierId),
          supplierStatus: supplier?.status ?? 'inactive',
          supplierReference: q.supplierReference,
          status: qStatus,
          validUntil: q.validUntil,
          leadTimeDays: q.leadTimeDays,
          total: money(q.total),
          recordedBy: nameOf(q.recordedByUserId) ?? 'Unknown user',
          recordedAt: q.createdAt.toISOString(),
          submittedAt: q.submittedAt?.toISOString() ?? null,
          submittedBy: nameOf(q.submittedByUserId),
          late: isLate(q.submittedAt, row.responseDueAt),
          withdrawnAt: q.withdrawnAt?.toISOString() ?? null,
          withdrawnBy: nameOf(q.withdrawnByUserId),
          withdrawReason: q.withdrawReason,
          validity: comparison.validity.get(q.id) ?? 'draft',
          lowest: comparison.lowestIds.has(q.id),
          version: q.version,
          lines: quotationLines
            .filter((l) => l.quotationId === q.id)
            .map((l) => ({
              rfqLineId: l.rfqLineId,
              rfqLineNo: rfqLineNo.get(l.rfqLineId) ?? 0,
              unitPrice: dec(l.unitPrice).toString(),
              lineTotal: money(l.lineTotal),
              lowestOnLine: comparison.lowestOnLine.get(l.rfqLineId)?.has(q.id) ?? false,
            }))
            .sort((a, b) => a.rfqLineNo - b.rfqLineNo),
          callerActions: quotationActionsFor(qStatus, status, canRecord),
        };
      }),
      comparison: {
        today,
        pastDue: isLate(clock.now(), row.responseDueAt),
        validCount: comparison.validCount,
        lowestTotal: comparison.lowestTotal === null ? null : money(comparison.lowestTotal),
        rfqRequiredAbove: rules.rfqRequiredAbove,
        minQuotes: rules.minQuotes,
        minQuotesApplies: comparison.minQuotesApplies,
        belowMinQuotes: comparison.belowMinQuotes,
      },
      award:
        status === 'awarded' && awarded
          ? {
              quotationId: awarded.id,
              supplierName: supplierLabel(awarded.supplierId),
              total: money(awarded.total),
              awardedBy: nameOf(row.awardedByUserId) ?? 'Unknown user',
              awardedAt: row.awardedAt?.toISOString() ?? '',
              justification: row.awardJustification,
              rfqRequiredAbove: row.awardRfqRequiredAbove === null ? null : dec(row.awardRfqRequiredAbove).toString(),
              minQuotes: row.awardMinQuotes ?? 0,
              validQuotations: row.awardValidQuotes ?? 0,
              belowMinQuotes: row.awardBelowMinQuotes ?? false,
              notLowest: row.awardNotLowest ?? false,
            }
          : null,
      callerActions: actionsFor(
        status,
        { manage: actor.permissions.has('rfq.manage'), record: canRecord, award: actor.permissions.has('quotation.award') },
        requisition.status === 'approved',
      ),
      history: await findEntityHistory(
        tx,
        [{ entityType: 'rfq', entityId: row.id }, ...quotations.map((q) => ({ entityType: 'quotation', entityId: q.id }))],
        (ids) => findUserDisplayNames(tx, ids),
      ),
    };
  },
});

export type SourcingLineOptionDto = {
  id: string;
  lineNo: number;
  description: string;
  quantity: string;
  uom: string;
  remainingQty: string;
  /** The number of another RFQ (not cancelled) this line is already on, if any. */
  onRfq: string | null;
};
export type SourcingOptionsDto = {
  requisition: { id: string; number: string; title: string; status: RequisitionStatus };
  lines: SourcingLineOptionDto[];
  suppliers: { id: string; code: string; legalName: string }[];
};
export const SOURCING_OPTIONS_KEYS = ['requisition', 'lines', 'suppliers'] as const;
export const SOURCING_LINE_OPTION_KEYS = ['id', 'lineNo', 'description', 'quantity', 'uom', 'remainingQty', 'onRfq'] as const;

/** What the RFQ form offers: the requisition's lines (with what is left and where they are sourced) and the active suppliers. */
export const rfqSourcingOptions = defineQuery({
  name: 'rfq.sourcingOptions',
  permission: 'rfq.manage',
  input: z.strictObject({ requisitionId: z.uuid(), rfqId: z.uuid().optional() }),
  handler: async ({ tx }, input): Promise<SourcingOptionsDto> => {
    const requisition = await findRequisitionForSourcing(tx, input.requisitionId);
    if (!requisition) fail('NOT_FOUND', 'Requisition not found.');
    const taken = await findLinesOnOtherRfqs(tx, requisition.lines.map((l) => l.id), input.rfqId ?? null);
    return {
      requisition: { id: requisition.id, number: requisition.number, title: requisition.title, status: requisition.status },
      lines: requisition.lines.map((l) => ({
        id: l.id,
        lineNo: l.lineNo,
        description: l.description,
        quantity: l.quantity,
        uom: l.uom,
        remainingQty: l.remainingQty,
        onRfq: taken.get(l.id) ?? null,
      })),
      suppliers: await findActiveSuppliers(tx),
    };
  },
});
