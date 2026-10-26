import 'server-only';
import { dec, toFixedScale } from '@/shared/decimal/decimal';
import type { Database, Tx } from '@/shared/db/transaction';
import { isRequisitionStatus, type RequisitionStatus } from '../domain/requisition';
import { findLines, findRequisition, lockRequisition, releaseLineQuantity, reserveLineQuantity, type RequisitionRow } from '../infrastructure/requisition-repository';

/*
 * What purchase orders (Phase 7) need from a requisition: its department, currency, and lines with
 * the estimate and what is left to order, and the ordered-quantity counter that only purchase
 * orders move (PR-I1, ADR 0008 C2). Quantities and prices are decimal strings without trailing zeros.
 */

export type PurchasingLine = {
  id: string;
  lineNo: number;
  description: string;
  quantity: string;
  uom: string;
  estimatedUnitPrice: string;
  orderedQty: string;
  remainingQty: string;
};

export type RequisitionForPurchasing = {
  id: string;
  number: string;
  title: string;
  status: RequisitionStatus;
  departmentId: string;
  currencyCode: string;
  currencyScale: number;
  /** As approved, at the currency scale; `RFQ_REQUIRED` compares it with `rfq_required_above`. */
  estimatedTotal: string;
  lines: PurchasingLine[];
};

/** Locks the requisition row first (ADR 0008 C8: requisition before purchase order). Null if it does not exist. */
export async function lockRequisitionForPurchasing(tx: Tx, requisitionId: string): Promise<RequisitionForPurchasing | null> {
  return forPurchasing(tx, await lockRequisition(tx, requisitionId));
}

/** The same, without a lock, for read-only queries. */
export async function findRequisitionForPurchasing(db: Database | Tx, requisitionId: string): Promise<RequisitionForPurchasing | null> {
  return forPurchasing(db, await findRequisition(db, requisitionId));
}

async function forPurchasing(db: Database | Tx, row: RequisitionRow | null): Promise<RequisitionForPurchasing | null> {
  if (!row) return null;
  if (!isRequisitionStatus(row.status)) throw new Error(`Unknown requisition status ${row.status}`);
  const lines = await findLines(db, row.id);
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    status: row.status,
    departmentId: row.departmentId,
    currencyCode: row.currencyCode,
    currencyScale: row.currencyScale,
    estimatedTotal: toFixedScale(dec(row.estimatedTotal), row.currencyScale),
    lines: lines.map((l) => ({
      id: l.id,
      lineNo: l.lineNo,
      description: l.description,
      quantity: dec(l.quantity).toString(),
      uom: l.uom,
      estimatedUnitPrice: dec(l.estimatedUnitPrice).toString(),
      orderedQty: dec(l.orderedQty).toString(),
      remainingQty: dec(l.quantity).sub(dec(l.orderedQty)).toString(),
    })),
  };
}

/**
 * PO-T01 / T02: reserves `quantity` of a requisition line for a purchase order, only if no more
 * than requested is ordered in all. False means `OVER_ORDER`. The caller holds the requisition's
 * lock and reserves lines in ascending id order (ADR 0008 C8).
 */
export async function reserveOrderedQuantity(tx: Tx, requisitionLineId: string, quantity: string): Promise<boolean> {
  return reserveLineQuantity(tx, requisitionLineId, quantity);
}

/** Gives reserved quantity back (an edit that orders less, a cancelled, rejected, or closed order). */
export async function releaseOrderedQuantity(tx: Tx, requisitionLineId: string, quantity: string): Promise<void> {
  if (!(await releaseLineQuantity(tx, requisitionLineId, quantity))) {
    throw new Error(`requisition line ${requisitionLineId} has less than ${quantity} ordered to release`);
  }
}
