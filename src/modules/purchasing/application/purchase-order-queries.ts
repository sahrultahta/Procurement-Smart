import 'server-only';
import { z } from 'zod';
import { findApprovalHistory, findOpenDecision, type ApprovalRoundDto, type OpenDecisionDto } from '@/modules/approvals';
import { findDepartmentDirectory, findUserDisplayNames } from '@/modules/identity';
import { findPurchasingRules, todayIn } from '@/modules/organization';
import { findRequisitionForPurchasing, findRequisitionHeaders, type RequisitionStatus } from '@/modules/requisitions';
import { findAwardedQuotations, findQuotationForPurchasing } from '@/modules/sourcing';
import { findActiveSuppliers, findSupplierContact, findSuppliersByIds, type SupplierStatus } from '@/modules/suppliers';
import { defineQuery } from '@/shared/application/runner';
import { dec, toFixedScale } from '@/shared/decimal/decimal';
import { compareAmounts } from '@/shared/decimal/pricing';
import { fail } from '@/shared/result';
import { PURCHASE_ORDER_STATUSES, nextPurchaseOrderStatus, takesReceipts, type ApprovalReason, type PurchaseOrderStatus } from '../domain/purchase-order';
import {
  findLinesOfOrders,
  findPurchaseOrder,
  findPurchaseOrderLines,
  isVisible,
  searchPurchaseOrders,
  searchReceivableOrders,
  type PurchaseOrderRow,
} from '../infrastructure/purchase-order-repository';
import { READ_PERMISSIONS, visibilityFor } from './visibility';

/*
 * Purchase-order read models. Who sees which order is decided in SQL (lists) or right after the
 * read (by id, NOT_FOUND otherwise), per ADR 0006 and its Phase 7 amendment. User names, never
 * ids, reach clients.
 */

export const PO_ACTIONS = ['edit', 'submit', 'issue', 'cancel', 'close', 'receive'] as const;
export type PurchaseOrderAction = (typeof PO_ACTIONS)[number];

export type PurchaseOrderSummaryDto = {
  id: string;
  number: string;
  status: PurchaseOrderStatus;
  supplierId: string;
  supplierCode: string;
  supplierName: string;
  requisitionId: string;
  requisitionNumber: string;
  total: string;
  currencyCode: string;
  currencyScale: number;
  createdAt: string;
};
export const PO_SUMMARY_KEYS = [
  'id',
  'number',
  'status',
  'supplierId',
  'supplierCode',
  'supplierName',
  'requisitionId',
  'requisitionNumber',
  'total',
  'currencyCode',
  'currencyScale',
  'createdAt',
] as const;

/** Quantities and prices without trailing zeros, amounts at the currency scale. */
export type PurchaseOrderLineDto = {
  id: string;
  lineNo: number;
  requisitionLineId: string;
  requisitionLineNo: number;
  quotationLineId: string | null;
  description: string;
  uom: string;
  quantity: string;
  unitPrice: string;
  /** The requisition line's estimate, for comparing prices (PO-T03). */
  estimatedUnitPrice: string;
  taxRatePct: string;
  lineSubtotal: string;
  lineTax: string;
  lineTotal: string;
  receivedQty: string;
  /** Null until the order is issued. */
  maxReceivableQty: string | null;
};
export const PO_LINE_KEYS = [
  'id',
  'lineNo',
  'requisitionLineId',
  'requisitionLineNo',
  'quotationLineId',
  'description',
  'uom',
  'quantity',
  'unitPrice',
  'estimatedUnitPrice',
  'taxRatePct',
  'lineSubtotal',
  'lineTax',
  'lineTotal',
  'receivedQty',
  'maxReceivableQty',
] as const;

/** What the order prints about its supplier. */
export type PurchaseOrderSupplierDto = {
  id: string;
  code: string;
  legalName: string;
  status: SupplierStatus;
  taxId: string | null;
  email: string | null;
  phone: string | null;
  addressLines: string[];
  countryCode: string;
};
export const PO_SUPPLIER_KEYS = ['id', 'code', 'legalName', 'status', 'taxId', 'email', 'phone', 'addressLines', 'countryCode'] as const;

export type PurchaseOrderQuotationDto = { id: string; rfqId: string; rfqNumber: string; supplierReference: string | null; validUntil: string };
export const PO_QUOTATION_KEYS = ['id', 'rfqId', 'rfqNumber', 'supplierReference', 'validUntil'] as const;

export type PurchaseOrderDetailDto = Omit<PurchaseOrderSummaryDto, 'supplierId' | 'supplierCode' | 'supplierName'> & {
  requisitionTitle: string;
  departmentCode: string;
  supplier: PurchaseOrderSupplierDto;
  quotation: PurchaseOrderQuotationDto | null;
  subtotal: string;
  taxTotal: string;
  paymentTerms: string | null;
  deliveryAddress: string | null;
  expectedDeliveryDate: string | null;
  /** The latest submission: why approval was needed (empty: it was not), and the rule then. */
  approvalReasons: ApprovalReason[];
  approvalThreshold: string | null;
  priceTolerancePct: string | null;
  createdBy: string;
  submittedAt: string | null;
  submittedBy: string | null;
  approvedAt: string | null;
  issuedAt: string | null;
  issuedBy: string | null;
  receiptTolerancePct: string | null;
  closedAt: string | null;
  closedBy: string | null;
  closeReason: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancelReason: string | null;
  updatedAt: string;
  version: number;
  lines: PurchaseOrderLineDto[];
  approvalHistory: ApprovalRoundDto[];
  openDecision: OpenDecisionDto | null;
  callerActions: PurchaseOrderAction[];
};
export const PO_DETAIL_KEYS = [
  'id',
  'number',
  'status',
  'requisitionId',
  'requisitionNumber',
  'requisitionTitle',
  'departmentCode',
  'supplier',
  'quotation',
  'currencyCode',
  'currencyScale',
  'subtotal',
  'taxTotal',
  'total',
  'paymentTerms',
  'deliveryAddress',
  'expectedDeliveryDate',
  'approvalReasons',
  'approvalThreshold',
  'priceTolerancePct',
  'createdBy',
  'createdAt',
  'submittedAt',
  'submittedBy',
  'approvedAt',
  'issuedAt',
  'issuedBy',
  'receiptTolerancePct',
  'closedAt',
  'closedBy',
  'closeReason',
  'cancelledAt',
  'cancelledBy',
  'cancelReason',
  'updatedAt',
  'version',
  'lines',
  'approvalHistory',
  'openDecision',
  'callerActions',
] as const;

const plain = (value: string | null) => (value === null ? null : dec(value).toString());

export const listPurchaseOrders = defineQuery({
  name: 'po.list',
  permission: [...READ_PERMISSIONS],
  input: z.strictObject({
    status: z.enum(PURCHASE_ORDER_STATUSES).optional(),
    requisitionId: z.uuid().optional(),
    supplierId: z.uuid().optional(),
    q: z.string().trim().max(100).optional(),
    cursor: z
      .string()
      .regex(/^PO-[0-9]{4}-[0-9]{6}$/, 'Invalid cursor')
      .optional(),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  handler: async ({ tx, actor }, input): Promise<{ items: PurchaseOrderSummaryDto[]; nextCursor: string | null }> => {
    const rows = await searchPurchaseOrders(tx, {
      visibility: await visibilityFor(tx, actor),
      status: input.status,
      requisitionId: input.requisitionId,
      supplierId: input.supplierId,
      q: input.q ?? '',
      beforeNumber: input.cursor,
      limit: input.limit + 1,
    });
    const page = rows.slice(0, input.limit);
    const suppliers = await findSuppliersByIds(tx, page.map((r) => r.supplierId));
    const requisitions = await findRequisitionHeaders(tx, page.map((r) => r.requisitionId));
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        number: row.number,
        status: row.status as PurchaseOrderStatus,
        supplierId: row.supplierId,
        supplierCode: suppliers.get(row.supplierId)?.code ?? '',
        supplierName: suppliers.get(row.supplierId)?.legalName ?? 'Unknown supplier',
        requisitionId: row.requisitionId,
        requisitionNumber: requisitions.get(row.requisitionId)?.number ?? '',
        total: toFixedScale(dec(row.total), row.currencyScale),
        currencyCode: row.currencyCode,
        currencyScale: row.currencyScale,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: rows.length > input.limit && last ? last.number : null,
    };
  },
});

function actionsFor(
  row: PurchaseOrderRow,
  status: PurchaseOrderStatus,
  actor: { userId: string; canBuy: boolean; canReceive: boolean },
  anyReceived: boolean,
): PurchaseOrderAction[] {
  const actions: PurchaseOrderAction[] = [];
  const creator = row.createdByUserId === actor.userId;
  if (actor.canBuy) {
    if (creator && nextPurchaseOrderStatus(status, 'update')) actions.push('edit');
    if (creator && nextPurchaseOrderStatus(status, 'submit')) actions.push('submit');
    if (nextPurchaseOrderStatus(status, 'issue')) actions.push('issue');
    if (nextPurchaseOrderStatus(status, 'cancel') && !anyReceived) actions.push('cancel');
    if (nextPurchaseOrderStatus(status, 'close')) actions.push('close');
  }
  // SOD-04: whoever created the order never receives against it.
  if (actor.canReceive && takesReceipts(status) && !creator) actions.push('receive');
  return actions;
}

export const getPurchaseOrder = defineQuery({
  name: 'po.get',
  permission: [...READ_PERMISSIONS],
  input: z.strictObject({ purchaseOrderId: z.uuid() }),
  handler: async ({ tx, actor }, input): Promise<PurchaseOrderDetailDto> => {
    const row = await findPurchaseOrder(tx, input.purchaseOrderId);
    if (!row || !isVisible(await visibilityFor(tx, actor), row)) fail('NOT_FOUND', 'Purchase order not found.');
    const status = row.status as PurchaseOrderStatus;
    const requisition = await findRequisitionForPurchasing(tx, row.requisitionId);
    if (!requisition) throw new Error(`requisition ${row.requisitionId} of purchase order ${row.id} is missing`);
    const supplier = await findSupplierContact(tx, row.supplierId);
    if (!supplier) throw new Error(`supplier ${row.supplierId} of purchase order ${row.id} is missing`);
    const quotation = row.quotationId ? await findQuotationForPurchasing(tx, row.quotationId) : null;
    const lines = await findPurchaseOrderLines(tx, row.id);
    const names = await findUserDisplayNames(
      tx,
      [row.createdByUserId, row.submittedByUserId, row.issuedByUserId, row.closedByUserId, row.cancelledByUserId].filter((id): id is string => id !== null),
    );
    const nameOf = (id: string | null) => (id ? (names.get(id) ?? 'Unknown user') : null);
    const department = (await findDepartmentDirectory(tx)).find((d) => d.id === row.departmentId);
    const source = new Map(requisition.lines.map((l) => [l.id, l]));
    const money = (value: string) => toFixedScale(dec(value), row.currencyScale);

    return {
      id: row.id,
      number: row.number,
      status,
      requisitionId: requisition.id,
      requisitionNumber: requisition.number,
      requisitionTitle: requisition.title,
      departmentCode: department?.code ?? '',
      supplier: {
        id: supplier.id,
        code: supplier.code,
        legalName: supplier.legalName,
        status: supplier.status,
        taxId: supplier.taxId,
        email: supplier.email,
        phone: supplier.phone,
        addressLines: supplier.addressLines,
        countryCode: supplier.countryCode,
      },
      quotation: quotation
        ? { id: quotation.id, rfqId: quotation.rfqId, rfqNumber: quotation.rfqNumber, supplierReference: quotation.supplierReference, validUntil: quotation.validUntil }
        : null,
      currencyCode: row.currencyCode,
      currencyScale: row.currencyScale,
      subtotal: money(row.subtotal),
      taxTotal: money(row.taxTotal),
      total: money(row.total),
      paymentTerms: row.paymentTerms,
      deliveryAddress: row.deliveryAddress,
      expectedDeliveryDate: row.expectedDeliveryDate,
      approvalReasons: row.approvalReasons as ApprovalReason[],
      approvalThreshold: plain(row.approvalThreshold),
      priceTolerancePct: plain(row.priceTolerancePct),
      createdBy: nameOf(row.createdByUserId) ?? 'Unknown user',
      createdAt: row.createdAt.toISOString(),
      submittedAt: row.submittedAt?.toISOString() ?? null,
      submittedBy: nameOf(row.submittedByUserId),
      approvedAt: row.approvedAt?.toISOString() ?? null,
      issuedAt: row.issuedAt?.toISOString() ?? null,
      issuedBy: nameOf(row.issuedByUserId),
      receiptTolerancePct: plain(row.receiptTolerancePct),
      closedAt: row.closedAt?.toISOString() ?? null,
      closedBy: nameOf(row.closedByUserId),
      closeReason: row.closeReason,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      cancelledBy: nameOf(row.cancelledByUserId),
      cancelReason: row.cancelReason,
      updatedAt: row.updatedAt.toISOString(),
      version: row.version,
      lines: lines.map((l) => ({
        id: l.id,
        lineNo: l.lineNo,
        requisitionLineId: l.requisitionLineId,
        requisitionLineNo: source.get(l.requisitionLineId)?.lineNo ?? 0,
        quotationLineId: l.quotationLineId,
        description: l.description,
        uom: l.uom,
        quantity: dec(l.quantity).toString(),
        unitPrice: dec(l.unitPrice).toString(),
        estimatedUnitPrice: source.get(l.requisitionLineId)?.estimatedUnitPrice ?? '0',
        taxRatePct: dec(l.taxRatePct).toString(),
        lineSubtotal: money(l.lineSubtotal),
        lineTax: money(l.lineTax),
        lineTotal: money(l.lineTotal),
        receivedQty: dec(l.receivedQty).toString(),
        maxReceivableQty: plain(l.maxReceivableQty),
      })),
      // History is part of the document, after its own visibility check (docs/api-contracts.md).
      approvalHistory: await findApprovalHistory(tx, 'purchase_order', row.id),
      openDecision: await findOpenDecision(tx, actor, 'purchase_order', row.id),
      callerActions: actionsFor(
        row,
        status,
        { userId: actor.userId, canBuy: actor.permissions.has('po.create'), canReceive: actor.permissions.has('receipt.create') },
        lines.some((l) => dec(l.receivedQty).gt(0)),
      ),
    };
  },
});

/** An order waiting for goods, for receivers (`po.receivable`). */
export type ReceivableOrderDto = {
  id: string;
  number: string;
  status: PurchaseOrderStatus;
  supplierCode: string;
  supplierName: string;
  expectedDeliveryDate: string | null;
  issuedAt: string;
  /** Lines not yet received in full. */
  openLines: number;
  lineCount: number;
  /** SOD-04: the caller created this order, so someone else must receive it. */
  ownOrder: boolean;
};
export const PO_RECEIVABLE_KEYS = ['id', 'number', 'status', 'supplierCode', 'supplierName', 'expectedDeliveryDate', 'issuedAt', 'openLines', 'lineCount', 'ownOrder'] as const;

/** Issued and partially received orders (GR-T01), newest first: what receivers can record goods against. */
export const listReceivableOrders = defineQuery({
  name: 'po.receivable',
  permission: 'receipt.create',
  input: z.strictObject({
    q: z.string().trim().max(100).optional(),
    cursor: z
      .string()
      .regex(/^PO-[0-9]{4}-[0-9]{6}$/, 'Invalid cursor')
      .optional(),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  handler: async ({ tx, actor }, input): Promise<{ items: ReceivableOrderDto[]; nextCursor: string | null }> => {
    const rows = await searchReceivableOrders(tx, { q: input.q ?? '', beforeNumber: input.cursor, limit: input.limit + 1 });
    const page = rows.slice(0, input.limit);
    const suppliers = await findSuppliersByIds(tx, page.map((r) => r.supplierId));
    const lines = await findLinesOfOrders(tx, page.map((r) => r.id));
    const last = page.at(-1);
    return {
      items: page.map((row) => {
        const own = lines.filter((l) => l.purchaseOrderId === row.id);
        return {
          id: row.id,
          number: row.number,
          status: row.status as PurchaseOrderStatus,
          supplierCode: suppliers.get(row.supplierId)?.code ?? '',
          supplierName: suppliers.get(row.supplierId)?.legalName ?? 'Unknown supplier',
          expectedDeliveryDate: row.expectedDeliveryDate,
          issuedAt: row.issuedAt?.toISOString() ?? '',
          openLines: own.filter((l) => dec(l.receivedQty).lt(dec(l.quantity))).length,
          lineCount: own.length,
          ownOrder: row.createdByUserId === actor.userId,
        };
      }),
      nextCursor: rows.length > input.limit && last ? last.number : null,
    };
  },
});

export type PurchaseOrderFormLineDto = {
  id: string;
  lineNo: number;
  description: string;
  quantity: string;
  uom: string;
  estimatedUnitPrice: string;
  /** What this order may still ask for: what is left, plus what the order being edited already holds. */
  availableQty: string;
};
export type PurchaseOrderFormQuotationDto = {
  id: string;
  rfqId: string;
  rfqNumber: string;
  supplierId: string;
  supplierName: string;
  supplierReference: string | null;
  validUntil: string;
  expired: boolean;
  lines: { id: string; requisitionLineId: string; quantity: string; unitPrice: string }[];
};
export type PurchaseOrderFormOptionsDto = {
  requisition: { id: string; number: string; title: string; status: RequisitionStatus; estimatedTotal: string; currencyCode: string; currencyScale: number };
  /** At or above `rfq_required_above` today: only an awarded quotation can be ordered from. */
  rfqRequired: boolean;
  lines: PurchaseOrderFormLineDto[];
  suppliers: { id: string; code: string; legalName: string }[];
  /** The awarded quotation of each awarded RFQ of the requisition. */
  quotations: PurchaseOrderFormQuotationDto[];
};
export const PO_FORM_OPTIONS_KEYS = ['requisition', 'rfqRequired', 'lines', 'suppliers', 'quotations'] as const;
export const PO_FORM_LINE_KEYS = ['id', 'lineNo', 'description', 'quantity', 'uom', 'estimatedUnitPrice', 'availableQty'] as const;

/** What the purchase-order form offers for a requisition (and, when editing, for one of its orders). */
export const purchaseOrderFormOptions = defineQuery({
  name: 'po.formOptions',
  permission: 'po.create',
  input: z.strictObject({ requisitionId: z.uuid(), purchaseOrderId: z.uuid().optional() }),
  handler: async ({ tx, clock }, input): Promise<PurchaseOrderFormOptionsDto> => {
    const requisition = await findRequisitionForPurchasing(tx, input.requisitionId);
    if (!requisition) fail('NOT_FOUND', 'Requisition not found.');
    const editing = input.purchaseOrderId ? await findPurchaseOrder(tx, input.purchaseOrderId) : null;
    if (input.purchaseOrderId && editing?.requisitionId !== requisition.id) fail('NOT_FOUND', 'Purchase order not found.');
    const held = new Map((editing ? await findPurchaseOrderLines(tx, editing.id) : []).map((l) => [l.requisitionLineId, dec(l.quantity)]));
    const rules = await findPurchasingRules(tx);
    const today = todayIn(rules.timezone, clock.now());
    const awarded = await findAwardedQuotations(tx, requisition.id);
    const suppliers = await findSuppliersByIds(tx, awarded.map((q) => q.supplierId));
    return {
      requisition: {
        id: requisition.id,
        number: requisition.number,
        title: requisition.title,
        status: requisition.status,
        estimatedTotal: requisition.estimatedTotal,
        currencyCode: requisition.currencyCode,
        currencyScale: requisition.currencyScale,
      },
      rfqRequired: rules.rfqRequiredAbove !== null && compareAmounts(requisition.estimatedTotal, rules.rfqRequiredAbove) >= 0,
      lines: requisition.lines.map((l) => ({
        id: l.id,
        lineNo: l.lineNo,
        description: l.description,
        quantity: l.quantity,
        uom: l.uom,
        estimatedUnitPrice: l.estimatedUnitPrice,
        availableQty: dec(l.remainingQty)
          .add(held.get(l.id) ?? 0)
          .toString(),
      })),
      suppliers: await findActiveSuppliers(tx),
      quotations: awarded.map((q) => ({
        id: q.id,
        rfqId: q.rfqId,
        rfqNumber: q.rfqNumber,
        supplierId: q.supplierId,
        supplierName: suppliers.get(q.supplierId)?.legalName ?? 'Unknown supplier',
        supplierReference: q.supplierReference,
        validUntil: q.validUntil,
        expired: q.validUntil < today,
        lines: q.lines,
      })),
    };
  },
});
