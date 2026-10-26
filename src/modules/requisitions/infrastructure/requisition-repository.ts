import 'server-only';
import { and, asc, desc, eq, ilike, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import type { Database, Tx } from '@/shared/db/transaction';
import { purchaseRequisitions, requisitionLines } from './schema';

type Queryable = Database | Tx;

export type RequisitionRow = typeof purchaseRequisitions.$inferSelect;
export type LineRow = typeof requisitionLines.$inferSelect;
export type LineValues = Pick<LineRow, 'description' | 'quantity' | 'uom' | 'estimatedUnitPrice' | 'lineTotal'>;

export async function insertRequisition(
  tx: Tx,
  values: Pick<
    RequisitionRow,
    'number' | 'requesterUserId' | 'departmentId' | 'title' | 'justification' | 'neededBy' | 'currencyCode' | 'currencyScale' | 'estimatedTotal'
  >,
): Promise<string> {
  const [row] = await tx.insert(purchaseRequisitions).values(values).returning({ id: purchaseRequisitions.id });
  if (!row) throw new Error('requisition insert returned no row');
  return row.id;
}

export async function insertLines(tx: Tx, requisitionId: string, lines: readonly LineValues[]): Promise<void> {
  if (lines.length === 0) return;
  await tx.insert(requisitionLines).values(lines.map((line, i) => ({ ...line, requisitionId, lineNo: i + 1 })));
}

/** Draft lines are replaced wholesale on edit (the trigger allows it only for drafts). */
export async function replaceLines(tx: Tx, requisitionId: string, lines: readonly LineValues[]): Promise<void> {
  await tx.delete(requisitionLines).where(eq(requisitionLines.requisitionId, requisitionId));
  await insertLines(tx, requisitionId, lines);
}

export async function lockRequisition(tx: Tx, id: string): Promise<RequisitionRow | null> {
  const [row] = await tx.select().from(purchaseRequisitions).where(eq(purchaseRequisitions.id, id)).for('update');
  return row ?? null;
}

export async function findRequisition(db: Queryable, id: string): Promise<RequisitionRow | null> {
  const [row] = await db.select().from(purchaseRequisitions).where(eq(purchaseRequisitions.id, id));
  return row ?? null;
}

export async function findLines(db: Queryable, requisitionId: string): Promise<LineRow[]> {
  return db.select().from(requisitionLines).where(eq(requisitionLines.requisitionId, requisitionId)).orderBy(asc(requisitionLines.lineNo));
}

export async function updateRequisition(
  tx: Tx,
  id: string,
  expectedVersion: number,
  values: Partial<
    Pick<
      RequisitionRow,
      | 'title'
      | 'justification'
      | 'neededBy'
      | 'estimatedTotal'
      | 'status'
      | 'currentApprovalRequestId'
      | 'cancelledByUserId'
      | 'cancelReason'
      | 'closedByUserId'
      | 'closeReason'
    > & { submittedAt: SQL; approvedAt: SQL; cancelledAt: SQL; closedAt: SQL }
  >,
): Promise<number> {
  const [row] = await tx
    .update(purchaseRequisitions)
    .set({ ...values, updatedAt: sql`now()`, version: sql`${purchaseRequisitions.version} + 1` })
    .where(and(eq(purchaseRequisitions.id, id), eq(purchaseRequisitions.version, expectedVersion)))
    .returning({ version: purchaseRequisitions.version });
  if (!row) throw new Error('purchase_requisitions row changed under its lock');
  return row.version;
}

/** Who may see which requisitions (ADR 0006), always applied in SQL (P5-AC10, threat I-01). */
export type Visibility = { all: true } | { all: false; ownerId: string | null; departmentIds: readonly string[] };

export function visibilityCondition(visibility: Visibility): SQL | undefined {
  if (visibility.all) return undefined;
  const parts = [
    visibility.ownerId ? eq(purchaseRequisitions.requesterUserId, visibility.ownerId) : undefined,
    visibility.departmentIds.length > 0 ? inArray(purchaseRequisitions.departmentId, [...visibility.departmentIds]) : undefined,
  ].filter((p) => p !== undefined);
  return parts.length > 0 ? or(...parts) : sql`false`;
}

export function isVisible(visibility: Visibility, row: Pick<RequisitionRow, 'requesterUserId' | 'departmentId'>): boolean {
  if (visibility.all) return true;
  return row.requesterUserId === visibility.ownerId || visibility.departmentIds.includes(row.departmentId);
}

function contains(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export async function searchRequisitions(
  db: Queryable,
  search: {
    visibility: Visibility;
    status: string | undefined;
    departmentId: string | undefined;
    q: string;
    beforeNumber: string | undefined;
    limit: number;
  },
): Promise<RequisitionRow[]> {
  const q = search.q.trim();
  return db
    .select()
    .from(purchaseRequisitions)
    .where(
      and(
        visibilityCondition(search.visibility),
        search.status ? eq(purchaseRequisitions.status, search.status) : undefined,
        search.departmentId ? eq(purchaseRequisitions.departmentId, search.departmentId) : undefined,
        q ? or(ilike(purchaseRequisitions.number, contains(q)), ilike(purchaseRequisitions.title, contains(q))) : undefined,
        search.beforeNumber ? lt(purchaseRequisitions.number, search.beforeNumber) : undefined,
      ),
    )
    .orderBy(desc(purchaseRequisitions.number))
    .limit(search.limit);
}

/**
 * ADR 0008 C2, for purchase orders: adds `quantity` to a line's ordered quantity only if it stays
 * within what was requested. False means it would over-order (the CHECK is the backstop).
 */
export async function reserveLineQuantity(tx: Tx, lineId: string, quantity: string): Promise<boolean> {
  const rows = await tx
    .update(requisitionLines)
    .set({ orderedQty: sql`${requisitionLines.orderedQty} + ${quantity}::numeric` })
    .where(and(eq(requisitionLines.id, lineId), sql`${requisitionLines.orderedQty} + ${quantity}::numeric <= ${requisitionLines.quantity}`))
    .returning({ id: requisitionLines.id });
  return rows.length === 1;
}

/** The reverse of `reserveLineQuantity`, never below zero. False means nothing that large was reserved. */
export async function releaseLineQuantity(tx: Tx, lineId: string, quantity: string): Promise<boolean> {
  const rows = await tx
    .update(requisitionLines)
    .set({ orderedQty: sql`${requisitionLines.orderedQty} - ${quantity}::numeric` })
    .where(and(eq(requisitionLines.id, lineId), sql`${requisitionLines.orderedQty} - ${quantity}::numeric >= 0`))
    .returning({ id: requisitionLines.id });
  return rows.length === 1;
}
