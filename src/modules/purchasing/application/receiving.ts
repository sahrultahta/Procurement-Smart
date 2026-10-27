import 'server-only';
import { auditChanges, recordAuditEvent } from '@/modules/audit';
import { findSuppliersByIds } from '@/modules/suppliers';
import type { RequestContext } from '@/shared/application/context';
import { Dec, dec } from '@/shared/decimal/decimal';
import type { Database, Tx } from '@/shared/db/transaction';
import { isPurchaseOrderStatus, receiptStatus, type PurchaseOrderStatus } from '../domain/purchase-order';
import {
  addReceivedQuantity,
  findLinesOfOrders,
  findPurchaseOrder,
  findPurchaseOrderLines,
  findPurchaseOrdersByIds,
  lockPurchaseOrder,
  subtractReceivedQuantity,
  updatePurchaseOrder,
  type PurchaseOrderLineRow,
  type PurchaseOrderRow,
} from '../infrastructure/purchase-order-repository';
import { purchaseOrderAudit } from './purchase-order-input';

/*
 * What goods receipts (Phase 8) need from a purchase order: its status, its creator (SOD-04), when
 * it was issued, its supplier, and its lines with what each can still take; and the received
 * quantity, which only posted goods receipts move (GR-I1, ADR 0008 C2). Quantities are decimal
 * strings without trailing zeros.
 */

export type ReceivingLine = {
  id: string;
  lineNo: number;
  description: string;
  uom: string;
  quantity: string;
  receivedQty: string;
  /** Null until the order is issued. */
  maxReceivableQty: string | null;
};

export type OrderForReceiving = {
  id: string;
  number: string;
  status: PurchaseOrderStatus;
  version: number;
  createdByUserId: string;
  supplierCode: string;
  supplierName: string;
  issuedAt: Date | null;
  expectedDeliveryDate: string | null;
  lines: ReceivingLine[];
};

function receivingLine(line: PurchaseOrderLineRow): ReceivingLine {
  return {
    id: line.id,
    lineNo: line.lineNo,
    description: line.description,
    uom: line.uom,
    quantity: dec(line.quantity).toString(),
    receivedQty: dec(line.receivedQty).toString(),
    maxReceivableQty: line.maxReceivableQty === null ? null : dec(line.maxReceivableQty).toString(),
  };
}

async function forReceiving(db: Database | Tx, row: PurchaseOrderRow | null): Promise<OrderForReceiving | null> {
  if (!row) return null;
  if (!isPurchaseOrderStatus(row.status)) throw new Error(`Unknown purchase order status ${row.status}`);
  const supplier = (await findSuppliersByIds(db, [row.supplierId])).get(row.supplierId);
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    version: row.version,
    createdByUserId: row.createdByUserId,
    supplierCode: supplier?.code ?? '',
    supplierName: supplier?.legalName ?? 'Unknown supplier',
    issuedAt: row.issuedAt,
    expectedDeliveryDate: row.expectedDeliveryDate,
    lines: (await findPurchaseOrderLines(db, row.id)).map(receivingLine),
  };
}

/** Locks the purchase order first (ADR 0008 C8: the order before its goods receipts). Null if it does not exist. */
export async function lockOrderForReceiving(tx: Tx, purchaseOrderId: string): Promise<OrderForReceiving | null> {
  return forReceiving(tx, await lockPurchaseOrder(tx, purchaseOrderId));
}

/** The same, without a lock, for read-only queries. */
export async function findOrderForReceiving(db: Database | Tx, purchaseOrderId: string): Promise<OrderForReceiving | null> {
  return forReceiving(db, await findPurchaseOrder(db, purchaseOrderId));
}

export type ReceivingOrderHeader = { id: string; number: string; status: PurchaseOrderStatus; supplierCode: string; supplierName: string; lines: ReceivingLine[] };

/** Number, status, supplier, and lines of several orders, for lists and receipt pages. */
export async function findOrderHeadersForReceiving(db: Database | Tx, purchaseOrderIds: readonly string[]): Promise<Map<string, ReceivingOrderHeader>> {
  const rows = await findPurchaseOrdersByIds(db, purchaseOrderIds);
  const suppliers = await findSuppliersByIds(db, rows.map((r) => r.supplierId));
  const lines = await findLinesOfOrders(db, purchaseOrderIds);
  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        number: row.number,
        status: row.status as PurchaseOrderStatus,
        supplierCode: suppliers.get(row.supplierId)?.code ?? '',
        supplierName: suppliers.get(row.supplierId)?.legalName ?? 'Unknown supplier',
        lines: lines.filter((l) => l.purchaseOrderId === row.id).map(receivingLine),
      },
    ]),
  );
}

export type ReceivedQuantityChange = { purchaseOrderLineId: string; quantity: string };

export type ReceivedQuantitiesResult =
  | { ok: true; status: PurchaseOrderStatus; previousStatus: PurchaseOrderStatus; version: number }
  /** OVER_RECEIPT: the conditional update refused this line. */
  | { ok: false; lineNo: number; remaining: string };

/**
 * GR-T02 / T04: moves each line's received quantity by a posted receipt (adding) or reversal
 * (subtracting), in ascending line id order, with the conditional update (C2) as the guard; then
 * re-derives the order's status (PO-T06) and changes its version, so a buyer acting on what they
 * saw before gets CONFLICT. A status change is audited on the order. The caller holds the order's
 * lock and has posted the goods receipt first (the database compares the two, GR-I1).
 */
export async function applyReceivedQuantities(
  tx: Tx,
  request: RequestContext,
  order: OrderForReceiving,
  changes: readonly ReceivedQuantityChange[],
  document: { number: string; kind: 'receipt' | 'reversal' },
): Promise<ReceivedQuantitiesResult> {
  const byId = new Map(order.lines.map((l) => [l.id, l]));
  for (const change of [...changes].sort((a, b) => (a.purchaseOrderLineId < b.purchaseOrderLineId ? -1 : 1))) {
    const line = byId.get(change.purchaseOrderLineId);
    if (!line) throw new Error(`line ${change.purchaseOrderLineId} is not on purchase order ${order.number}`);
    if (document.kind === 'receipt') {
      if (!(await addReceivedQuantity(tx, line.id, change.quantity))) {
        const remaining = Dec.max(dec(line.maxReceivableQty ?? '0').sub(dec(line.receivedQty)), 0).toString();
        return { ok: false, lineNo: line.lineNo, remaining };
      }
    } else if (!(await subtractReceivedQuantity(tx, line.id, change.quantity))) {
      throw new Error(`purchase order line ${line.id} has less than ${change.quantity} received to reverse`);
    }
  }
  const status = receiptStatus(await findPurchaseOrderLines(tx, order.id));
  const version = await updatePurchaseOrder(tx, order.id, order.version, status === order.status ? {} : { status });
  if (status !== order.status) {
    await recordAuditEvent(tx, request, {
      action: 'po.receiptStatusChanged',
      entityType: 'purchase_order',
      entityId: order.id,
      changes: auditChanges(purchaseOrderAudit, { status: order.status }, { status, goodsReceipt: document.number }),
    });
  }
  return { ok: true, status, previousStatus: order.status, version };
}
