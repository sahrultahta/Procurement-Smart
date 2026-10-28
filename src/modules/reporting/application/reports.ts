import 'server-only';
import { z } from 'zod';
import { findDepartmentDirectory } from '@/modules/identity';
import { defineQuery, type HandlerContext } from '@/shared/application/runner';
import { Dec, dec, toFixedScale } from '@/shared/decimal/decimal';
import { hoursOf, percentile } from '../domain/statistics';
import { findSplitGroups, type SplitGroup } from '../domain/split-purchases';
import {
  readOpenOrderLines,
  readOpenOrderSuppliers,
  readOrgSettings,
  readPendingSteps,
  readRequisitionCycles,
  readSpend,
  readSplitCandidates,
  type SpendBasis,
  type SpendDimension,
} from '../infrastructure/report-views';
import { checkDateRange, dateRangeShape } from './report-input';

/*
 * Reports (P9-AC2 to AC4, AC6): `report.view` (procurement, finance, auditors). Every figure comes
 * from a reporting view at the moment of the request, and every response says when (`asOf`).
 * Amounts are exact decimal strings at the currency's scale.
 */

type Ctx = Pick<HandlerContext, 'tx' | 'clock'>;

export const SPEND_BASES = ['issued', 'received'] as const;

const spendInput = z
  .strictObject({ ...dateRangeShape(true), basis: z.enum(SPEND_BASES).default('issued') })
  .superRefine(checkDateRange);
export type SpendInput = z.output<typeof spendInput>;

export type SpendRowDto = { id: string; code: string; name: string; currencyCode: string; currencyScale: number; poCount: number; total: string };
export type CurrencyTotalDto = { currencyCode: string; currencyScale: number; total: string };
export type SpendReportDto = {
  asOf: string;
  from: string;
  to: string;
  basis: SpendBasis;
  rows: SpendRowDto[];
  totals: CurrencyTotalDto[];
};
export const SPEND_REPORT_KEYS = ['asOf', 'from', 'to', 'basis', 'rows', 'totals'] as const;
export const SPEND_ROW_KEYS = ['id', 'code', 'name', 'currencyCode', 'currencyScale', 'poCount', 'total'] as const;

async function spend({ tx, clock }: Ctx, by: SpendDimension, input: SpendInput): Promise<SpendReportDto> {
  const asOf = clock.now().toISOString();
  const rows = (await readSpend(tx, input.basis, by, input.from, input.to)).map((r) => ({
    id: r.key,
    code: r.code,
    name: r.name,
    currencyCode: r.currencyCode,
    currencyScale: r.currencyScale,
    poCount: r.poCount,
    total: toFixedScale(dec(r.total), r.currencyScale),
  }));
  const totals = new Map<string, CurrencyTotalDto>();
  for (const row of rows) {
    const current = totals.get(row.currencyCode);
    const sum = dec(current?.total ?? '0').add(dec(row.total));
    totals.set(row.currencyCode, { currencyCode: row.currencyCode, currencyScale: row.currencyScale, total: toFixedScale(sum, row.currencyScale) });
  }
  return { asOf, from: input.from, to: input.to, basis: input.basis, rows, totals: [...totals.values()] };
}

export const computeSpendBySupplier = (ctx: Ctx, input: SpendInput) => spend(ctx, 'supplier', input);
export const computeSpendByDepartment = (ctx: Ctx, input: SpendInput) => spend(ctx, 'department', input);

export const spendBySupplier = defineQuery({
  name: 'report.spendBySupplier',
  permission: 'report.view',
  input: spendInput,
  handler: computeSpendBySupplier,
});

export const spendByDepartment = defineQuery({
  name: 'report.spendByDepartment',
  permission: 'report.view',
  input: spendInput,
  handler: computeSpendByDepartment,
});

const cycleInput = z.strictObject({ ...dateRangeShape(true), departmentId: z.uuid().optional() }).superRefine(checkDateRange);
export type CycleInput = z.output<typeof cycleInput>;

export type CycleRowDto = { requisitionId: string; number: string; departmentName: string; submittedAt: string; approvedAt: string; hours: string };
export type CycleTimeReportDto = {
  asOf: string;
  from: string;
  to: string;
  departmentId: string | null;
  /** Hours, 2 decimals; null when no requisition was approved in the range. */
  medianHours: string | null;
  p90Hours: string | null;
  count: number;
  rows: CycleRowDto[];
  departments: { id: string; code: string; name: string }[];
};
export const CYCLE_REPORT_KEYS = ['asOf', 'from', 'to', 'departmentId', 'medianHours', 'p90Hours', 'count', 'rows', 'departments'] as const;
export const CYCLE_ROW_KEYS = ['requisitionId', 'number', 'departmentName', 'submittedAt', 'approvedAt', 'hours'] as const;

export async function computeRequisitionCycleTime({ tx, clock }: Ctx, input: CycleInput): Promise<CycleTimeReportDto> {
  const asOf = clock.now().toISOString();
  const cycles = await readRequisitionCycles(tx, input.from, input.to, input.departmentId);
  const seconds = cycles.map((c) => c.cycleSeconds);
  const median = percentile(seconds, 0.5);
  const p90 = percentile(seconds, 0.9);
  return {
    asOf,
    from: input.from,
    to: input.to,
    departmentId: input.departmentId ?? null,
    medianHours: median ? hoursOf(median) : null,
    p90Hours: p90 ? hoursOf(p90) : null,
    count: cycles.length,
    rows: cycles.map((c) => ({
      requisitionId: c.requisitionId,
      number: c.number,
      departmentName: c.departmentName,
      submittedAt: new Date(c.submittedAt).toISOString(),
      approvedAt: new Date(c.approvedAt).toISOString(),
      hours: hoursOf(dec(c.cycleSeconds)),
    })),
    departments: (await findDepartmentDirectory(tx)).map((d) => ({ id: d.id, code: d.code, name: d.name })),
  };
}

export const requisitionCycleTime = defineQuery({
  name: 'report.requisitionCycleTime',
  permission: 'report.view',
  input: cycleInput,
  handler: computeRequisitionCycleTime,
});

const agingInput = z.strictObject({ olderThanDays: z.number().int().min(0).max(365).default(0) });
export type AgingInput = z.output<typeof agingInput>;

export type AgingRowDto = {
  documentType: 'requisition' | 'purchase_order';
  documentId: string;
  documentNumber: string;
  documentTitle: string;
  amount: string;
  currencyCode: string;
  currencyScale: number;
  departmentName: string;
  stepNo: number;
  requiredRole: string;
  pendingSince: string;
  /** Whole days the step has waited. */
  ageDays: number;
};
export type ApprovalAgingReportDto = { asOf: string; olderThanDays: number; rows: AgingRowDto[] };
export const AGING_REPORT_KEYS = ['asOf', 'olderThanDays', 'rows'] as const;
export const AGING_ROW_KEYS = [
  'documentType',
  'documentId',
  'documentNumber',
  'documentTitle',
  'amount',
  'currencyCode',
  'currencyScale',
  'departmentName',
  'stepNo',
  'requiredRole',
  'pendingSince',
  'ageDays',
] as const;

export async function computeApprovalAging({ tx, clock }: Ctx, input: AgingInput): Promise<ApprovalAgingReportDto> {
  const now = clock.now();
  const rows = await readPendingSteps(tx, now, input.olderThanDays);
  return {
    asOf: now.toISOString(),
    olderThanDays: input.olderThanDays,
    rows: rows.map((r) => ({
      documentType: r.documentType,
      documentId: r.documentId,
      documentNumber: r.documentNumber,
      documentTitle: r.documentTitle,
      amount: toFixedScale(dec(r.amount), r.currencyScale),
      currencyCode: r.currencyCode,
      currencyScale: r.currencyScale,
      departmentName: r.departmentName,
      stepNo: r.stepNo,
      requiredRole: r.requiredRole,
      pendingSince: new Date(r.activatedAt).toISOString(),
      ageDays: dec(r.ageSeconds).div(86_400).floor().toNumber(),
    })),
  };
}

export const approvalAging = defineQuery({
  name: 'report.approvalAging',
  permission: 'report.view',
  input: agingInput,
  handler: computeApprovalAging,
});

const openOrdersInput = z.strictObject({ supplierId: z.uuid().optional() });
export type OpenOrdersInput = z.output<typeof openOrdersInput>;

export type OpenOrderLineDto = { lineNo: number; description: string; uom: string; quantity: string; receivedQty: string; outstandingQty: string; outstandingAmount: string };
export type OpenOrderDto = {
  purchaseOrderId: string;
  number: string;
  status: string;
  supplierCode: string;
  supplierName: string;
  departmentName: string;
  currencyCode: string;
  currencyScale: number;
  issuedOn: string;
  expectedDeliveryDate: string | null;
  openLines: number;
  lineCount: number;
  outstandingAmount: string;
  lines: OpenOrderLineDto[];
};
export type OpenOrdersReportDto = {
  asOf: string;
  supplierId: string | null;
  rows: OpenOrderDto[];
  totals: CurrencyTotalDto[];
  suppliers: { id: string; code: string; name: string }[];
};
export const OPEN_ORDERS_REPORT_KEYS = ['asOf', 'supplierId', 'rows', 'totals', 'suppliers'] as const;
export const OPEN_ORDER_KEYS = [
  'purchaseOrderId',
  'number',
  'status',
  'supplierCode',
  'supplierName',
  'departmentName',
  'currencyCode',
  'currencyScale',
  'issuedOn',
  'expectedDeliveryDate',
  'openLines',
  'lineCount',
  'outstandingAmount',
  'lines',
] as const;

/** Quantities without trailing zeros. */
const qty = (value: string) => dec(value).toString();

export async function computeOpenPurchaseOrders({ tx, clock }: Ctx, input: OpenOrdersInput): Promise<OpenOrdersReportDto> {
  const asOf = clock.now().toISOString();
  const lines = await readOpenOrderLines(tx, input.supplierId);
  const orders = new Map<string, OpenOrderDto>();
  for (const l of lines) {
    let order = orders.get(l.purchaseOrderId);
    if (!order) {
      order = {
        purchaseOrderId: l.purchaseOrderId,
        number: l.number,
        status: l.status,
        supplierCode: l.supplierCode,
        supplierName: l.supplierName,
        departmentName: l.departmentName,
        currencyCode: l.currencyCode,
        currencyScale: l.currencyScale,
        issuedOn: l.issuedOn,
        expectedDeliveryDate: l.expectedDeliveryDate,
        openLines: 0,
        lineCount: 0,
        outstandingAmount: toFixedScale(new Dec(0), l.currencyScale),
        lines: [],
      };
      orders.set(l.purchaseOrderId, order);
    }
    order.lineCount++;
    if (dec(l.outstandingQty).gt(0)) order.openLines++;
    order.outstandingAmount = toFixedScale(dec(order.outstandingAmount).add(dec(l.outstandingAmount)), l.currencyScale);
    order.lines.push({
      lineNo: l.lineNo,
      description: l.description,
      uom: l.uom,
      quantity: qty(l.quantity),
      receivedQty: qty(l.receivedQty),
      outstandingQty: qty(l.outstandingQty),
      outstandingAmount: toFixedScale(dec(l.outstandingAmount), l.currencyScale),
    });
  }
  const rows = [...orders.values()];
  const totals = new Map<string, CurrencyTotalDto>();
  for (const row of rows) {
    const sum = dec(totals.get(row.currencyCode)?.total ?? '0').add(dec(row.outstandingAmount));
    totals.set(row.currencyCode, { currencyCode: row.currencyCode, currencyScale: row.currencyScale, total: toFixedScale(sum, row.currencyScale) });
  }
  return { asOf, supplierId: input.supplierId ?? null, rows, totals: [...totals.values()], suppliers: await readOpenOrderSuppliers(tx) };
}

export const openPurchaseOrders = defineQuery({
  name: 'report.openPurchaseOrders',
  permission: 'report.view',
  input: openOrdersInput,
  handler: computeOpenPurchaseOrders,
});

export const MAX_WINDOW_DAYS = 90;
const splitInput = z
  .strictObject({ ...dateRangeShape(true), windowDays: z.number().int().min(1).max(MAX_WINDOW_DAYS).default(30) })
  .superRefine(checkDateRange);
export type SplitInput = z.output<typeof splitInput>;

export type SplitPurchasesReportDto = {
  asOf: string;
  from: string;
  to: string;
  windowDays: number;
  /** The current settings; null: that check is off. */
  thresholds: { poApproval: string | null; rfq: string | null };
  groups: SplitGroup[];
};
export const SPLIT_REPORT_KEYS = ['asOf', 'from', 'to', 'windowDays', 'thresholds', 'groups'] as const;
export const SPLIT_GROUP_KEYS = [
  'threshold',
  'thresholdAmount',
  'requesterName',
  'supplierCode',
  'supplierName',
  'currencyCode',
  'currencyScale',
  'firstOn',
  'lastOn',
  'combinedAmount',
  'orders',
] as const;

export async function computePotentialSplitPurchases({ tx, clock }: Ctx, input: SplitInput): Promise<SplitPurchasesReportDto> {
  const asOf = clock.now().toISOString();
  const settings = await readOrgSettings(tx);
  const thresholds = {
    poApproval: settings.poApprovalThreshold === null ? null : toFixedScale(dec(settings.poApprovalThreshold), settings.currencyScale),
    rfq: settings.rfqRequiredAbove === null ? null : toFixedScale(dec(settings.rfqRequiredAbove), settings.currencyScale),
  };
  const candidates = await readSplitCandidates(tx, input.from, input.to);
  return {
    asOf,
    from: input.from,
    to: input.to,
    windowDays: input.windowDays,
    thresholds,
    groups: findSplitGroups(candidates, thresholds, input.windowDays),
  };
}

export const potentialSplitPurchases = defineQuery({
  name: 'report.potentialSplitPurchases',
  permission: 'report.view',
  input: splitInput,
  handler: computePotentialSplitPurchases,
});

export const REPORT_INPUTS = {
  spendBySupplier: spendInput,
  spendByDepartment: spendInput,
  requisitionCycleTime: cycleInput,
  approvalAging: agingInput,
  openPurchaseOrders: openOrdersInput,
  potentialSplitPurchases: splitInput,
} as const;
