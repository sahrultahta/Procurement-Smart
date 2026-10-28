import 'server-only';
import { z } from 'zod';
import { findEntityHistory, type HistoryEntryDto } from '@/modules/audit';
import { findUserDisplayNames } from '@/modules/identity';
import { findPurchasingRules, todayIn } from '@/modules/organization';
import {
  findOrderForReceiving,
  findOrderHeadersForReceiving,
  ISSUED_ORDER_STATUSES,
  takesReceipts,
  takesReversals,
  type PurchaseOrderStatus,
} from '@/modules/purchasing';
import { defineQuery } from '@/shared/application/runner';
import { dec } from '@/shared/decimal/decimal';
import { fail } from '@/shared/result';
import {
  GOODS_RECEIPT_KINDS,
  GOODS_RECEIPT_STATUSES,
  nextGoodsReceiptStatus,
  remainingReceivable,
  type GoodsReceiptKind,
  type GoodsReceiptStatus,
} from '../domain/goods-receipt';
import { findGoodsReceipt, findGoodsReceiptLines, findGoodsReceiptsByIds, findReversalsOf, searchGoodsReceipts } from '../infrastructure/goods-receipt-repository';

/*
 * Goods-receipt read models. `receipt.read` (procurement, receivers, finance, auditors) reads every
 * goods receipt, drafts included (decision 6). User names, never ids, reach clients.
 */

export const GR_ACTIONS = ['post', 'cancel', 'reverse'] as const;
export type GoodsReceiptAction = (typeof GR_ACTIONS)[number];

export type GoodsReceiptSummaryDto = {
  id: string;
  number: string;
  kind: GoodsReceiptKind;
  status: GoodsReceiptStatus;
  purchaseOrderId: string;
  purchaseOrderNumber: string;
  supplierCode: string;
  supplierName: string;
  receivedOn: string;
  createdBy: string;
  createdAt: string;
  /** For a reversal: the receipt it reverses. */
  reversesNumber: string | null;
  /** For a receipt: the reversal that undid it, if any. */
  reversedByNumber: string | null;
};
export const GR_SUMMARY_KEYS = [
  'id',
  'number',
  'kind',
  'status',
  'purchaseOrderId',
  'purchaseOrderNumber',
  'supplierCode',
  'supplierName',
  'receivedOn',
  'createdBy',
  'createdAt',
  'reversesNumber',
  'reversedByNumber',
] as const;

export const listGoodsReceipts = defineQuery({
  name: 'receipt.list',
  permission: 'receipt.read',
  input: z.strictObject({
    status: z.enum(GOODS_RECEIPT_STATUSES).optional(),
    kind: z.enum(GOODS_RECEIPT_KINDS).optional(),
    purchaseOrderId: z.uuid().optional(),
    q: z.string().trim().max(100).optional(),
    cursor: z
      .string()
      .regex(/^GR-[0-9]{4}-[0-9]{6}$/, 'Invalid cursor')
      .optional(),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  handler: async ({ tx }, input): Promise<{ items: GoodsReceiptSummaryDto[]; nextCursor: string | null }> => {
    const rows = await searchGoodsReceipts(tx, {
      status: input.status,
      kind: input.kind,
      purchaseOrderId: input.purchaseOrderId,
      q: input.q ?? '',
      beforeNumber: input.cursor,
      limit: input.limit + 1,
    });
    const page = rows.slice(0, input.limit);
    const orders = await findOrderHeadersForReceiving(tx, page.map((r) => r.purchaseOrderId));
    const names = await findUserDisplayNames(tx, page.map((r) => r.createdByUserId));
    const reversals = await findReversalsOf(tx, page.map((r) => r.id));
    const reversed = new Map((await findGoodsReceiptsByIds(tx, page.flatMap((r) => (r.reversesGoodsReceiptId ? [r.reversesGoodsReceiptId] : [])))).map((r) => [r.id, r.number]));
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        number: row.number,
        kind: row.kind as GoodsReceiptKind,
        status: row.status as GoodsReceiptStatus,
        purchaseOrderId: row.purchaseOrderId,
        purchaseOrderNumber: orders.get(row.purchaseOrderId)?.number ?? '',
        supplierCode: orders.get(row.purchaseOrderId)?.supplierCode ?? '',
        supplierName: orders.get(row.purchaseOrderId)?.supplierName ?? 'Unknown supplier',
        receivedOn: row.receivedOn,
        createdBy: names.get(row.createdByUserId) ?? 'Unknown user',
        createdAt: row.createdAt.toISOString(),
        reversesNumber: row.reversesGoodsReceiptId ? (reversed.get(row.reversesGoodsReceiptId) ?? null) : null,
        reversedByNumber: reversals.get(row.id)?.number ?? null,
      })),
      nextCursor: rows.length > input.limit && last ? last.number : null,
    };
  },
});

/** Quantities without trailing zeros. `orderedQty`, `receivedQty`, and `maxReceivableQty` are the order line's now. */
export type GoodsReceiptLineDto = {
  id: string;
  purchaseOrderLineId: string;
  lineNo: number;
  description: string;
  uom: string;
  quantity: string;
  note: string | null;
  orderedQty: string;
  receivedQty: string;
  maxReceivableQty: string | null;
};
export const GR_LINE_KEYS = ['id', 'purchaseOrderLineId', 'lineNo', 'description', 'uom', 'quantity', 'note', 'orderedQty', 'receivedQty', 'maxReceivableQty'] as const;

export type GoodsReceiptOrderDto = { id: string; number: string; status: PurchaseOrderStatus; supplierCode: string; supplierName: string };
export const GR_ORDER_KEYS = ['id', 'number', 'status', 'supplierCode', 'supplierName'] as const;

export type GoodsReceiptDetailDto = {
  id: string;
  number: string;
  kind: GoodsReceiptKind;
  status: GoodsReceiptStatus;
  purchaseOrder: GoodsReceiptOrderDto;
  receivedOn: string;
  deliveryNoteRef: string | null;
  notes: string | null;
  /** Why a reversal was made. */
  reason: string | null;
  reverses: { id: string; number: string } | null;
  reversedBy: { id: string; number: string } | null;
  createdBy: string;
  createdAt: string;
  postedBy: string | null;
  postedAt: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  updatedAt: string;
  version: number;
  lines: GoodsReceiptLineDto[];
  callerActions: GoodsReceiptAction[];
  /** The document's own audit trail, oldest first (Phase 9). */
  history: HistoryEntryDto[];
};
export const GR_DETAIL_KEYS = [
  'id',
  'number',
  'kind',
  'status',
  'purchaseOrder',
  'receivedOn',
  'deliveryNoteRef',
  'notes',
  'reason',
  'reverses',
  'reversedBy',
  'createdBy',
  'createdAt',
  'postedBy',
  'postedAt',
  'cancelledBy',
  'cancelledAt',
  'cancelReason',
  'updatedAt',
  'version',
  'lines',
  'callerActions',
  'history',
] as const;

export const getGoodsReceipt = defineQuery({
  name: 'receipt.get',
  permission: 'receipt.read',
  input: z.strictObject({ goodsReceiptId: z.uuid() }),
  handler: async ({ tx, actor }, input): Promise<GoodsReceiptDetailDto> => {
    const row = await findGoodsReceipt(tx, input.goodsReceiptId);
    if (!row) fail('NOT_FOUND', 'Goods receipt not found.');
    const kind = row.kind as GoodsReceiptKind;
    const status = row.status as GoodsReceiptStatus;
    const order = await findOrderForReceiving(tx, row.purchaseOrderId);
    if (!order) throw new Error(`purchase order ${row.purchaseOrderId} of goods receipt ${row.id} is missing`);
    const reverses = row.reversesGoodsReceiptId ? (await findGoodsReceiptsByIds(tx, [row.reversesGoodsReceiptId]))[0] : undefined;
    const reversedBy = (await findReversalsOf(tx, [row.id])).get(row.id);
    const names = await findUserDisplayNames(
      tx,
      [row.createdByUserId, row.postedByUserId, row.cancelledByUserId].filter((id): id is string => id !== null),
    );
    const nameOf = (id: string | null) => (id ? (names.get(id) ?? 'Unknown user') : null);
    const orderLines = new Map(order.lines.map((l) => [l.id, l]));
    const lines = (await findGoodsReceiptLines(tx, row.id))
      .map((line) => {
        const source = orderLines.get(line.purchaseOrderLineId);
        return {
          id: line.id,
          purchaseOrderLineId: line.purchaseOrderLineId,
          lineNo: source?.lineNo ?? 0,
          description: source?.description ?? '',
          uom: source?.uom ?? '',
          quantity: dec(line.quantity).toString(),
          note: line.note,
          orderedQty: source?.quantity ?? '0',
          receivedQty: source?.receivedQty ?? '0',
          maxReceivableQty: source?.maxReceivableQty ?? null,
        };
      })
      .sort((a, b) => a.lineNo - b.lineNo);

    const canReceive = actor.permissions.has('receipt.create');
    const orderCreator = order.createdByUserId === actor.userId;
    const callerActions: GoodsReceiptAction[] = [];
    if (canReceive && !orderCreator && nextGoodsReceiptStatus(kind, status, 'post') && kind === 'receipt' && takesReceipts(order.status)) callerActions.push('post');
    if (canReceive && row.createdByUserId === actor.userId && nextGoodsReceiptStatus(kind, status, 'cancel')) callerActions.push('cancel');
    if (canReceive && !orderCreator && nextGoodsReceiptStatus(kind, status, 'reverse') && !reversedBy && takesReversals(order.status)) callerActions.push('reverse');

    return {
      id: row.id,
      number: row.number,
      kind,
      status,
      purchaseOrder: { id: order.id, number: order.number, status: order.status, supplierCode: order.supplierCode, supplierName: order.supplierName },
      receivedOn: row.receivedOn,
      deliveryNoteRef: row.deliveryNoteRef,
      notes: row.notes,
      reason: row.reason,
      reverses: reverses ? { id: reverses.id, number: reverses.number } : null,
      reversedBy: reversedBy ? { id: reversedBy.id, number: reversedBy.number } : null,
      createdBy: nameOf(row.createdByUserId) ?? 'Unknown user',
      createdAt: row.createdAt.toISOString(),
      postedBy: nameOf(row.postedByUserId),
      postedAt: row.postedAt?.toISOString() ?? null,
      cancelledBy: nameOf(row.cancelledByUserId),
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      cancelReason: row.cancelReason,
      updatedAt: row.updatedAt.toISOString(),
      version: row.version,
      lines,
      callerActions,
      history: await findEntityHistory(tx, [{ entityType: 'goods_receipt', entityId: row.id }], (ids) => findUserDisplayNames(tx, ids)),
    };
  },
});

export type GoodsReceiptFormLineDto = {
  id: string;
  lineNo: number;
  description: string;
  uom: string;
  quantity: string;
  receivedQty: string;
  maxReceivableQty: string;
  /** What the line can still take: its receivable quantity less what was received. */
  remainingQty: string;
};
export type GoodsReceiptFormOptionsDto = {
  purchaseOrder: GoodsReceiptOrderDto & { issuedOn: string; expectedDeliveryDate: string | null };
  /** The org date: goods are received on or before it, and on or after `issuedOn`. */
  today: string;
  /** False when the order no longer takes receipts (PO_NOT_RECEIVABLE). */
  receivable: boolean;
  /** SOD-04: the caller created the order, so someone else must receive it. */
  orderReceiveConflict: boolean;
  lines: GoodsReceiptFormLineDto[];
};
export const GR_FORM_OPTIONS_KEYS = ['purchaseOrder', 'today', 'receivable', 'orderReceiveConflict', 'lines'] as const;
export const GR_FORM_LINE_KEYS = ['id', 'lineNo', 'description', 'uom', 'quantity', 'receivedQty', 'maxReceivableQty', 'remainingQty'] as const;

/** What the goods-receipt form offers for an issued order. */
export const goodsReceiptFormOptions = defineQuery({
  name: 'receipt.formOptions',
  permission: 'receipt.create',
  input: z.strictObject({ purchaseOrderId: z.uuid() }),
  handler: async ({ tx, actor, clock }, input): Promise<GoodsReceiptFormOptionsDto> => {
    const order = await findOrderForReceiving(tx, input.purchaseOrderId);
    if (!order || !(ISSUED_ORDER_STATUSES as readonly string[]).includes(order.status)) fail('NOT_FOUND', 'Purchase order not found.');
    const rules = await findPurchasingRules(tx);
    const today = todayIn(rules.timezone, clock.now());
    return {
      purchaseOrder: {
        id: order.id,
        number: order.number,
        status: order.status,
        supplierCode: order.supplierCode,
        supplierName: order.supplierName,
        issuedOn: order.issuedAt ? todayIn(rules.timezone, order.issuedAt) : today,
        expectedDeliveryDate: order.expectedDeliveryDate,
      },
      today,
      receivable: takesReceipts(order.status),
      orderReceiveConflict: order.createdByUserId === actor.userId,
      lines: order.lines.map((l) => ({
        id: l.id,
        lineNo: l.lineNo,
        description: l.description,
        uom: l.uom,
        quantity: l.quantity,
        receivedQty: l.receivedQty,
        maxReceivableQty: l.maxReceivableQty ?? '0',
        remainingQty: remainingReceivable(l.maxReceivableQty ?? '0', l.receivedQty),
      })),
    };
  },
});
