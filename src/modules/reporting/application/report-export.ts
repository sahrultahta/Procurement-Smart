import 'server-only';
import { z } from 'zod';
import { defineQuery, type HandlerContext } from '@/shared/application/runner';
import { AppFailure } from '@/shared/result';
import { number, text, toCsv, type CsvColumn } from '../domain/csv';
import type { SplitGroup } from '../domain/split-purchases';
import {
  REPORT_INPUTS,
  computeApprovalAging,
  computeOpenPurchaseOrders,
  computePotentialSplitPurchases,
  computeRequisitionCycleTime,
  computeSpendByDepartment,
  computeSpendBySupplier,
  type AgingRowDto,
  type CycleRowDto,
  type OpenOrderDto,
  type OpenOrderLineDto,
  type SpendRowDto,
} from './reports';

/*
 * CSV export (P9-AC5): the same permission and the same validated parameters as the report on
 * screen; the file is built from the report's own result, so both always agree.
 */

export const REPORT_NAMES = ['spendBySupplier', 'spendByDepartment', 'requisitionCycleTime', 'approvalAging', 'openPurchaseOrders', 'potentialSplitPurchases'] as const;
export type ReportName = (typeof REPORT_NAMES)[number];

/** Parameters that arrive as text (a URL query) but are whole numbers in the report input. */
const NUMBER_PARAMS = new Set(['olderThanDays', 'windowDays']);

type Ctx = Pick<HandlerContext, 'tx' | 'clock'>;
type Built = { asOf: string; csv: string };

function asOfColumn<Row>(asOf: string): CsvColumn<Row> {
  return { header: 'As of', cell: () => text(asOf) };
}

const spendColumns = (label: string, asOf: string, basis: string): CsvColumn<SpendRowDto>[] => [
  { header: `${label} code`, cell: (r) => text(r.code) },
  { header: label, cell: (r) => text(r.name) },
  { header: 'Basis', cell: () => text(basis) },
  { header: 'Purchase orders', cell: (r) => number(String(r.poCount)) },
  { header: 'Currency', cell: (r) => text(r.currencyCode) },
  { header: 'Total', cell: (r) => number(r.total) },
  asOfColumn(asOf),
];

const BUILDERS: Record<ReportName, (ctx: Ctx, input: never) => Promise<Built>> = {
  spendBySupplier: async (ctx, input: z.output<typeof REPORT_INPUTS.spendBySupplier>) => {
    const r = await computeSpendBySupplier(ctx, input);
    return { asOf: r.asOf, csv: toCsv(spendColumns('Supplier', r.asOf, r.basis), r.rows) };
  },
  spendByDepartment: async (ctx, input: z.output<typeof REPORT_INPUTS.spendByDepartment>) => {
    const r = await computeSpendByDepartment(ctx, input);
    return { asOf: r.asOf, csv: toCsv(spendColumns('Department', r.asOf, r.basis), r.rows) };
  },
  requisitionCycleTime: async (ctx, input: z.output<typeof REPORT_INPUTS.requisitionCycleTime>) => {
    const r = await computeRequisitionCycleTime(ctx, input);
    const columns: CsvColumn<CycleRowDto>[] = [
      { header: 'Requisition', cell: (row) => text(row.number) },
      { header: 'Department', cell: (row) => text(row.departmentName) },
      { header: 'First submitted', cell: (row) => text(row.submittedAt) },
      { header: 'Approved', cell: (row) => text(row.approvedAt) },
      { header: 'Hours', cell: (row) => number(row.hours) },
      asOfColumn(r.asOf),
    ];
    return { asOf: r.asOf, csv: toCsv(columns, r.rows) };
  },
  approvalAging: async (ctx, input: z.output<typeof REPORT_INPUTS.approvalAging>) => {
    const r = await computeApprovalAging(ctx, input);
    const columns: CsvColumn<AgingRowDto>[] = [
      { header: 'Document type', cell: (row) => text(row.documentType) },
      { header: 'Document', cell: (row) => text(row.documentNumber) },
      { header: 'Title', cell: (row) => text(row.documentTitle) },
      { header: 'Department', cell: (row) => text(row.departmentName) },
      { header: 'Step', cell: (row) => number(String(row.stepNo)) },
      { header: 'Role', cell: (row) => text(row.requiredRole) },
      { header: 'Pending since', cell: (row) => text(row.pendingSince) },
      { header: 'Age (days)', cell: (row) => number(String(row.ageDays)) },
      { header: 'Currency', cell: (row) => text(row.currencyCode) },
      { header: 'Amount', cell: (row) => number(row.amount) },
      asOfColumn(r.asOf),
    ];
    return { asOf: r.asOf, csv: toCsv(columns, r.rows) };
  },
  openPurchaseOrders: async (ctx, input: z.output<typeof REPORT_INPUTS.openPurchaseOrders>) => {
    const r = await computeOpenPurchaseOrders(ctx, input);
    type Row = { order: OpenOrderDto; line: OpenOrderLineDto };
    const columns: CsvColumn<Row>[] = [
      { header: 'Purchase order', cell: ({ order }) => text(order.number) },
      { header: 'Status', cell: ({ order }) => text(order.status) },
      { header: 'Supplier code', cell: ({ order }) => text(order.supplierCode) },
      { header: 'Supplier', cell: ({ order }) => text(order.supplierName) },
      { header: 'Department', cell: ({ order }) => text(order.departmentName) },
      { header: 'Issued on', cell: ({ order }) => text(order.issuedOn) },
      { header: 'Expected delivery', cell: ({ order }) => text(order.expectedDeliveryDate) },
      { header: 'Line', cell: ({ line }) => number(String(line.lineNo)) },
      { header: 'Description', cell: ({ line }) => text(line.description) },
      { header: 'Unit', cell: ({ line }) => text(line.uom) },
      { header: 'Ordered', cell: ({ line }) => number(line.quantity) },
      { header: 'Received', cell: ({ line }) => number(line.receivedQty) },
      { header: 'Outstanding', cell: ({ line }) => number(line.outstandingQty) },
      { header: 'Currency', cell: ({ order }) => text(order.currencyCode) },
      { header: 'Outstanding amount', cell: ({ line }) => number(line.outstandingAmount) },
      asOfColumn(r.asOf),
    ];
    return { asOf: r.asOf, csv: toCsv(columns, r.rows.flatMap((order) => order.lines.map((line) => ({ order, line })))) };
  },
  potentialSplitPurchases: async (ctx, input: z.output<typeof REPORT_INPUTS.potentialSplitPurchases>) => {
    const r = await computePotentialSplitPurchases(ctx, input);
    type Row = { group: SplitGroup; order: SplitGroup['orders'][number] };
    const columns: CsvColumn<Row>[] = [
      { header: 'Threshold', cell: ({ group }) => text(group.threshold) },
      { header: 'Threshold amount', cell: ({ group }) => number(group.thresholdAmount) },
      { header: 'Requester', cell: ({ group }) => text(group.requesterName) },
      { header: 'Supplier code', cell: ({ group }) => text(group.supplierCode) },
      { header: 'Supplier', cell: ({ group }) => text(group.supplierName) },
      { header: 'Combined amount', cell: ({ group }) => number(group.combinedAmount) },
      { header: 'Purchase order', cell: ({ order }) => text(order.number) },
      { header: 'Requisition', cell: ({ order }) => text(order.requisitionNumber) },
      { header: 'Approved on', cell: ({ order }) => text(order.approvedOn) },
      { header: 'Currency', cell: ({ group }) => text(group.currencyCode) },
      { header: 'Amount', cell: ({ order }) => number(order.amount) },
      asOfColumn(r.asOf),
    ];
    return { asOf: r.asOf, csv: toCsv(columns, r.groups.flatMap((group) => group.orders.map((order) => ({ group, order })))) };
  },
};

export type ReportExportDto = { filename: string; contentType: 'text/csv; charset=utf-8'; csv: string };

export const exportReport = defineQuery({
  name: 'report.export',
  permission: 'report.view',
  input: z.strictObject({
    report: z.enum(REPORT_NAMES),
    params: z.record(z.string().max(32), z.string().max(64)).refine((p) => Object.keys(p).length <= 8, 'Too many parameters'),
  }),
  handler: async ({ tx, clock }, input): Promise<ReportExportDto> => {
    const raw: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input.params)) {
      if (value === '') continue;
      raw[key] = NUMBER_PARAMS.has(key) && /^[0-9]{1,4}$/.test(value) ? Number(value) : value;
    }
    const parsed = REPORT_INPUTS[input.report].safeParse(raw);
    if (!parsed.success) {
      const fieldErrors: Record<string, string[]> = {};
      for (const issue of parsed.error.issues) (fieldErrors[`params.${issue.path.join('.') || '_form'}`] ??= []).push(issue.message);
      throw new AppFailure({ code: 'VALIDATION_FAILED', message: 'Some report parameters are invalid.', fieldErrors });
    }
    const built = await BUILDERS[input.report]({ tx, clock }, parsed.data as never);
    return { filename: `${input.report}-${built.asOf.slice(0, 10)}.csv`, contentType: 'text/csv; charset=utf-8', csv: built.csv };
  },
});
