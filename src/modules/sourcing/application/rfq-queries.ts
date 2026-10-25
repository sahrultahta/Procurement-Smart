import 'server-only';
import { z } from 'zod';
import { findUserDisplayNames } from '@/modules/identity';
import { findRequisitionForSourcing, findRequisitionHeaders, type RequisitionStatus } from '@/modules/requisitions';
import { findActiveSuppliers, findSuppliersByIds, type SupplierStatus } from '@/modules/suppliers';
import { defineQuery } from '@/shared/application/runner';
import { dec } from '@/shared/decimal/decimal';
import { fail } from '@/shared/result';
import { RFQ_STATUSES, nextRfqStatus, type RfqStatus } from '../domain/rfq';
import { findInvitations, findLinesOnOtherRfqs, findRfq, findRfqLines, searchRfqs, type RfqSummaryRow } from '../infrastructure/rfq-repository';

/*
 * RFQ read models. Everyone with `rfq.read` (procurement, finance, auditor; ADR 0006 amendment)
 * sees every RFQ: these roles also read every requisition. User names, never ids, reach clients.
 */

export const RFQ_ACTIONS = ['edit', 'issue', 'close', 'cancel'] as const;
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

export type RfqLineDto = { lineNo: number; requisitionLineNo: number; description: string; quantity: string; uom: string };
export const RFQ_LINE_KEYS = ['lineNo', 'requisitionLineNo', 'description', 'quantity', 'uom'] as const;

export type InvitedSupplierDto = { id: string; code: string; legalName: string; status: SupplierStatus; invitedAt: string };
export const INVITED_SUPPLIER_KEYS = ['id', 'code', 'legalName', 'status', 'invitedAt'] as const;

export type RfqDetailDto = Omit<RfqSummaryDto, 'lineCount' | 'supplierCount'> & {
  requisitionTitle: string;
  requisitionStatus: RequisitionStatus;
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
  callerActions: RfqAction[];
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
  'callerActions',
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

function actionsFor(status: RfqStatus, canManage: boolean): RfqAction[] {
  if (!canManage) return [];
  const actions: RfqAction[] = [];
  if (nextRfqStatus(status, 'update')) actions.push('edit');
  if (nextRfqStatus(status, 'issue')) actions.push('issue');
  if (nextRfqStatus(status, 'close')) actions.push('close');
  if (nextRfqStatus(status, 'cancel')) actions.push('cancel');
  return actions;
}

export const getRfq = defineQuery({
  name: 'rfq.get',
  permission: 'rfq.read',
  input: z.strictObject({ rfqId: z.uuid() }),
  handler: async ({ tx, actor }, input): Promise<RfqDetailDto> => {
    const row = await findRfq(tx, input.rfqId);
    if (!row) fail('NOT_FOUND', 'RFQ not found.');
    const requisition = await findRequisitionForSourcing(tx, row.requisitionId);
    if (!requisition) throw new Error(`requisition ${row.requisitionId} of RFQ ${row.id} is missing`);
    const lines = await findRfqLines(tx, row.id);
    const invitations = await findInvitations(tx, row.id);
    const suppliers = await findSuppliersByIds(tx, invitations.map((i) => i.supplierId));
    const userIds = [row.createdByUserId, row.issuedByUserId, row.closedByUserId, row.cancelledByUserId].filter((id): id is string => id !== null);
    const names = await findUserDisplayNames(tx, userIds);
    const nameOf = (id: string | null) => (id ? (names.get(id) ?? 'Unknown user') : null);
    const lineNo = new Map(requisition.lines.map((l) => [l.id, l.lineNo]));
    const status = row.status as RfqStatus;
    return {
      id: row.id,
      number: row.number,
      title: row.title,
      status,
      requisitionId: requisition.id,
      requisitionNumber: requisition.number,
      requisitionTitle: requisition.title,
      requisitionStatus: requisition.status,
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
      callerActions: actionsFor(status, actor.permissions.has('rfq.manage')),
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
