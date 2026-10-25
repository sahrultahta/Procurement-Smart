import 'server-only';
import { inArray } from 'drizzle-orm';
import { dec } from '@/shared/decimal/decimal';
import type { Database, Tx } from '@/shared/db/transaction';
import { isRequisitionStatus, type RequisitionStatus } from '../domain/requisition';
import { findLines, findRequisition, lockRequisition, type RequisitionRow } from '../infrastructure/requisition-repository';
import { purchaseRequisitions } from '../infrastructure/schema';

/*
 * What sourcing (RFQs, Phase 6) needs from a requisition: its approved lines and what is left
 * of each. Quantities are decimal strings without trailing zeros.
 */

export type SourcingLine = {
  id: string;
  lineNo: number;
  description: string;
  quantity: string;
  uom: string;
  orderedQty: string;
  remainingQty: string;
};

export type RequisitionForSourcing = {
  id: string;
  number: string;
  title: string;
  status: RequisitionStatus;
  lines: SourcingLine[];
};

/** Locks the requisition row first (ADR 0008 C8: requisition before RFQ). Null if it does not exist. */
export async function lockRequisitionForSourcing(tx: Tx, requisitionId: string): Promise<RequisitionForSourcing | null> {
  return forSourcing(tx, await lockRequisition(tx, requisitionId));
}

/** The same, without a lock, for read-only queries. */
export async function findRequisitionForSourcing(db: Database | Tx, requisitionId: string): Promise<RequisitionForSourcing | null> {
  return forSourcing(db, await findRequisition(db, requisitionId));
}

async function forSourcing(db: Database | Tx, row: RequisitionRow | null): Promise<RequisitionForSourcing | null> {
  if (!row) return null;
  if (!isRequisitionStatus(row.status)) throw new Error(`Unknown requisition status ${row.status}`);
  const lines = await findLines(db, row.id);
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    status: row.status,
    lines: lines.map((l) => ({
      id: l.id,
      lineNo: l.lineNo,
      description: l.description,
      quantity: dec(l.quantity).toString(),
      uom: l.uom,
      orderedQty: dec(l.orderedQty).toString(),
      remainingQty: dec(l.quantity).sub(dec(l.orderedQty)).toString(),
    })),
  };
}

/** Number, title, and status of requisitions, for display next to RFQs. */
export async function findRequisitionHeaders(
  db: Database | Tx,
  ids: readonly string[],
): Promise<Map<string, { number: string; title: string; status: RequisitionStatus }>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: purchaseRequisitions.id, number: purchaseRequisitions.number, title: purchaseRequisitions.title, status: purchaseRequisitions.status })
    .from(purchaseRequisitions)
    .where(inArray(purchaseRequisitions.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, { number: r.number, title: r.title, status: r.status as RequisitionStatus }]));
}
