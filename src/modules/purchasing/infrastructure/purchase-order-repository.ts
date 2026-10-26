import 'server-only';
import { and, asc, desc, eq, ilike, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import type { Database, Tx } from '@/shared/db/transaction';
import { purchaseOrderLines, purchaseOrders } from './schema';

type Queryable = Database | Tx;

export type PurchaseOrderRow = typeof purchaseOrders.$inferSelect;
export type PurchaseOrderLineRow = typeof purchaseOrderLines.$inferSelect;
export type PurchaseOrderLineValues = Pick<
  PurchaseOrderLineRow,
  'requisitionLineId' | 'quotationLineId' | 'description' | 'uom' | 'quantity' | 'unitPrice' | 'taxRatePct' | 'lineSubtotal' | 'lineTax' | 'lineTotal'
>;
export type PurchaseOrderTerms = Pick<PurchaseOrderRow, 'paymentTerms' | 'deliveryAddress' | 'expectedDeliveryDate' | 'subtotal' | 'taxTotal' | 'total'>;

export async function insertPurchaseOrder(
  tx: Tx,
  values: PurchaseOrderTerms &
    Pick<PurchaseOrderRow, 'number' | 'requisitionId' | 'departmentId' | 'supplierId' | 'quotationId' | 'currencyCode' | 'currencyScale' | 'createdByUserId'>,
): Promise<string> {
  const [row] = await tx.insert(purchaseOrders).values(values).returning({ id: purchaseOrders.id });
  if (!row) throw new Error('purchase order insert returned no row');
  return row.id;
}

/** Draft lines are replaced wholesale on edit (the trigger allows it only for drafts). */
export async function replacePurchaseOrderLines(tx: Tx, purchaseOrderId: string, lines: readonly PurchaseOrderLineValues[]): Promise<void> {
  await tx.delete(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId));
  if (lines.length > 0) await tx.insert(purchaseOrderLines).values(lines.map((line, i) => ({ ...line, purchaseOrderId, lineNo: i + 1 })));
}

export async function findPurchaseOrder(db: Queryable, id: string): Promise<PurchaseOrderRow | null> {
  const [row] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, id));
  return row ?? null;
}

export async function lockPurchaseOrder(tx: Tx, id: string): Promise<PurchaseOrderRow | null> {
  const [row] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, id)).for('update');
  return row ?? null;
}

export async function findPurchaseOrderLines(db: Queryable, purchaseOrderId: string): Promise<PurchaseOrderLineRow[]> {
  return db.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId)).orderBy(asc(purchaseOrderLines.lineNo));
}

/** PO-T05: each line's receivable quantity, fixed once after the header is issued (the trigger checks the value). */
export async function setMaxReceivable(tx: Tx, lineId: string, maxReceivableQty: string): Promise<void> {
  const rows = await tx
    .update(purchaseOrderLines)
    .set({ maxReceivableQty })
    .where(and(eq(purchaseOrderLines.id, lineId), sql`${purchaseOrderLines.maxReceivableQty} IS NULL`))
    .returning({ id: purchaseOrderLines.id });
  if (rows.length !== 1) throw new Error(`purchase order line ${lineId} already has its receivable quantity`);
}

export async function updatePurchaseOrder(
  tx: Tx,
  id: string,
  expectedVersion: number,
  values: Partial<
    PurchaseOrderTerms &
      Pick<
        PurchaseOrderRow,
        | 'status'
        | 'approvalReasons'
        | 'approvalThreshold'
        | 'priceTolerancePct'
        | 'currentApprovalRequestId'
        | 'submittedByUserId'
        | 'issuedByUserId'
        | 'receiptTolerancePct'
        | 'closedByUserId'
        | 'closeReason'
        | 'cancelledByUserId'
        | 'cancelReason'
      > & { submittedAt: SQL; approvedAt: SQL; issuedAt: SQL; closedAt: SQL; cancelledAt: SQL }
  >,
): Promise<number> {
  const [row] = await tx
    .update(purchaseOrders)
    .set({ ...values, updatedAt: sql`now()`, version: sql`${purchaseOrders.version} + 1` })
    .where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.version, expectedVersion)))
    .returning({ version: purchaseOrders.version });
  if (!row) throw new Error('purchase_orders row changed under its lock');
  return row.version;
}

/**
 * Who may see which purchase orders (ADR 0006 and its Phase 7 amendment), always applied in SQL:
 * all of them, those of some departments (approvers), and issued ones for receiving.
 */
export type Visibility = { all: true } | { all: false; departmentIds: readonly string[]; issued: boolean };

export const RECEIVABLE_VIEW_STATUSES = ['issued', 'partially_received', 'received', 'closed'] as const;

export function visibilityCondition(visibility: Visibility): SQL | undefined {
  if (visibility.all) return undefined;
  const parts = [
    visibility.departmentIds.length > 0 ? inArray(purchaseOrders.departmentId, [...visibility.departmentIds]) : undefined,
    visibility.issued ? inArray(purchaseOrders.status, [...RECEIVABLE_VIEW_STATUSES]) : undefined,
  ].filter((p) => p !== undefined);
  return parts.length > 0 ? or(...parts) : sql`false`;
}

export function isVisible(visibility: Visibility, row: Pick<PurchaseOrderRow, 'departmentId' | 'status'>): boolean {
  if (visibility.all) return true;
  return visibility.departmentIds.includes(row.departmentId) || (visibility.issued && (RECEIVABLE_VIEW_STATUSES as readonly string[]).includes(row.status));
}

function contains(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export async function searchPurchaseOrders(
  db: Queryable,
  search: {
    visibility: Visibility;
    status: string | undefined;
    requisitionId: string | undefined;
    supplierId: string | undefined;
    q: string;
    beforeNumber: string | undefined;
    limit: number;
  },
): Promise<PurchaseOrderRow[]> {
  const q = search.q.trim();
  return db
    .select()
    .from(purchaseOrders)
    .where(
      and(
        visibilityCondition(search.visibility),
        search.status ? eq(purchaseOrders.status, search.status) : undefined,
        search.requisitionId ? eq(purchaseOrders.requisitionId, search.requisitionId) : undefined,
        search.supplierId ? eq(purchaseOrders.supplierId, search.supplierId) : undefined,
        q ? ilike(purchaseOrders.number, contains(q)) : undefined,
        search.beforeNumber ? lt(purchaseOrders.number, search.beforeNumber) : undefined,
      ),
    )
    .orderBy(desc(purchaseOrders.number))
    .limit(search.limit);
}
