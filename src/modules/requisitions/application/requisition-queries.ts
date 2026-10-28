import 'server-only';
import { z } from 'zod';
import { findEntityHistory, type HistoryEntryDto } from '@/modules/audit';
import { findApprovalHistory, findOpenDecision, type ApprovalRoundDto, type OpenDecisionDto } from '@/modules/approvals';
import { findDepartmentDirectory, findUserDisplayNames } from '@/modules/identity';
import { defineQuery } from '@/shared/application/runner';
import { dec, toFixedScale } from '@/shared/decimal/decimal';
import { fail } from '@/shared/result';
import { REQUISITION_STATUSES, isEditable, nextRequisitionStatus, type RequisitionStatus } from '../domain/requisition';
import { findLines, findRequisition, isVisible, searchRequisitions, type RequisitionRow } from '../infrastructure/requisition-repository';
import { READ_PERMISSIONS, visibilityFor } from './visibility';

/*
 * Requisition read models. Visibility is applied in SQL for lists and checked for single
 * reads; a requisition the caller may not see is NOT_FOUND, never FORBIDDEN (no existence leak).
 */

/** What the caller can do with a requisition now. The commands check again on their own. */
export const REQUISITION_ACTIONS = ['edit', 'submit', 'cancel', 'close'] as const;
export type RequisitionAction = (typeof REQUISITION_ACTIONS)[number];

export type RequisitionSummaryDto = {
  id: string;
  number: string;
  title: string;
  status: RequisitionStatus;
  requester: string;
  departmentCode: string;
  neededBy: string;
  estimatedTotal: string;
  currencyCode: string;
  currencyScale: number;
  createdAt: string;
};
export const REQUISITION_SUMMARY_KEYS = [
  'id',
  'number',
  'title',
  'status',
  'requester',
  'departmentCode',
  'neededBy',
  'estimatedTotal',
  'currencyCode',
  'currencyScale',
  'createdAt',
] as const;

export type RequisitionLineDto = {
  lineNo: number;
  description: string;
  quantity: string;
  uom: string;
  estimatedUnitPrice: string;
  lineTotal: string;
  orderedQty: string;
  remainingQty: string;
};
export const REQUISITION_LINE_KEYS = ['lineNo', 'description', 'quantity', 'uom', 'estimatedUnitPrice', 'lineTotal', 'orderedQty', 'remainingQty'] as const;

export type RequisitionDetailDto = RequisitionSummaryDto & {
  departmentName: string;
  justification: string | null;
  updatedAt: string;
  version: number;
  submittedAt: string | null;
  approvedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  closedAt: string | null;
  closeReason: string | null;
  lines: RequisitionLineDto[];
  /** Every approval round, oldest first (US-AP-04). */
  approvalHistory: ApprovalRoundDto[];
  /** The approval step the caller may decide right now, if any (US-AP-02). */
  openDecision: OpenDecisionDto | null;
  /** The caller is the requester and the requisition can still be edited (draft or returned). */
  callerCanEdit: boolean;
  callerActions: RequisitionAction[];
  /** The document's own audit trail, oldest first (Phase 9). */
  history: HistoryEntryDto[];
};
export const REQUISITION_DETAIL_KEYS = [
  ...REQUISITION_SUMMARY_KEYS,
  'departmentName',
  'justification',
  'updatedAt',
  'version',
  'submittedAt',
  'approvedAt',
  'cancelledAt',
  'cancelReason',
  'closedAt',
  'closeReason',
  'lines',
  'approvalHistory',
  'openDecision',
  'callerCanEdit',
  'callerActions',
  'history',
] as const;

const money = (value: string, scale: number) => toFixedScale(dec(value), scale);
const quantity = (value: string) => dec(value).toString();

export const listRequisitions = defineQuery({
  name: 'requisition.list',
  permission: READ_PERMISSIONS,
  input: z.strictObject({
    status: z.enum(REQUISITION_STATUSES).optional(),
    departmentCode: z
      .string()
      .regex(/^[A-Z0-9-]{2,16}$/)
      .optional(),
    q: z.string().trim().max(100).optional(),
    cursor: z
      .string()
      .regex(/^PR-[0-9]{4}-[0-9]{6}$/, 'Invalid cursor')
      .optional(),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  handler: async ({ tx, actor }, input): Promise<{ items: RequisitionSummaryDto[]; nextCursor: string | null }> => {
    const directory = await findDepartmentDirectory(tx);
    const department = input.departmentCode ? directory.find((d) => d.code === input.departmentCode) : undefined;
    if (input.departmentCode && !department) return { items: [], nextCursor: null };
    const rows = await searchRequisitions(tx, {
      visibility: await visibilityFor(tx, actor),
      status: input.status,
      departmentId: department?.id,
      q: input.q ?? '',
      beforeNumber: input.cursor,
      limit: input.limit + 1,
    });
    const page = rows.slice(0, input.limit);
    const names = await findUserDisplayNames(tx, page.map((r) => r.requesterUserId));
    const codes = new Map(directory.map((d) => [d.id, d.code]));
    const last = page.at(-1);
    return {
      items: page.map((row) => summary(row, names.get(row.requesterUserId) ?? 'Unknown user', codes.get(row.departmentId) ?? '')),
      nextCursor: rows.length > input.limit && last ? last.number : null,
    };
  },
});

function summary(row: RequisitionRow, requester: string, departmentCode: string): RequisitionSummaryDto {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    status: row.status as RequisitionStatus,
    requester,
    departmentCode,
    neededBy: row.neededBy,
    estimatedTotal: money(row.estimatedTotal, row.currencyScale),
    currencyCode: row.currencyCode,
    currencyScale: row.currencyScale,
    createdAt: row.createdAt.toISOString(),
  };
}

export const getRequisition = defineQuery({
  name: 'requisition.get',
  permission: READ_PERMISSIONS,
  input: z.strictObject({ requisitionId: z.uuid() }),
  handler: async ({ tx, actor }, input): Promise<RequisitionDetailDto> => {
    const row = await findRequisition(tx, input.requisitionId);
    if (!row || !isVisible(await visibilityFor(tx, actor), row)) fail('NOT_FOUND', 'Requisition not found.');
    // One transaction, one connection: these run one after another.
    const lines = await findLines(tx, row.id);
    const names = await findUserDisplayNames(tx, [row.requesterUserId]);
    const directory = await findDepartmentDirectory(tx);
    const approvalHistory = await findApprovalHistory(tx, 'requisition', row.id);
    const openDecision = await findOpenDecision(tx, actor, 'requisition', row.id);
    const department = directory.find((d) => d.id === row.departmentId);
    const status = row.status as RequisitionStatus;
    const owner = row.requesterUserId === actor.userId && actor.permissions.has('requisition.create');
    const purchasing = actor.permissions.has('po.create');
    const ordered = lines.some((l) => dec(l.orderedQty).gt(0));
    const callerActions: RequisitionAction[] = [];
    if (owner && isEditable(status)) callerActions.push('edit', 'submit');
    // PR-T07/T08 for the requester; PR-T09 (approved, nothing ordered) also for procurement.
    if (nextRequisitionStatus(status, 'cancel') && (owner || (purchasing && status === 'approved')) && !(status === 'approved' && ordered)) {
      callerActions.push('cancel');
    }
    if (purchasing && nextRequisitionStatus(status, 'close')) callerActions.push('close');
    return {
      ...summary(row, names.get(row.requesterUserId) ?? 'Unknown user', department?.code ?? ''),
      departmentName: department?.name ?? '',
      justification: row.justification,
      updatedAt: row.updatedAt.toISOString(),
      version: row.version,
      submittedAt: row.submittedAt?.toISOString() ?? null,
      approvedAt: row.approvedAt?.toISOString() ?? null,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      cancelReason: row.cancelReason,
      closedAt: row.closedAt?.toISOString() ?? null,
      closeReason: row.closeReason,
      lines: lines.map((l) => ({
        lineNo: l.lineNo,
        description: l.description,
        quantity: quantity(l.quantity),
        uom: l.uom,
        estimatedUnitPrice: dec(l.estimatedUnitPrice).toString(),
        lineTotal: money(l.lineTotal, row.currencyScale),
        orderedQty: quantity(l.orderedQty),
        remainingQty: dec(l.quantity).sub(dec(l.orderedQty)).toString(),
      })),
      approvalHistory,
      openDecision,
      callerCanEdit: callerActions.includes('edit'),
      callerActions,
      history: await findEntityHistory(tx, [{ entityType: 'requisition', entityId: row.id }], (ids) => findUserDisplayNames(tx, ids)),
    };
  },
});
