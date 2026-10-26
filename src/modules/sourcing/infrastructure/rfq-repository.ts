import 'server-only';
import { and, asc, count, desc, eq, ilike, inArray, lt, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { Database, Tx } from '@/shared/db/transaction';
import { rfqLines, rfqSuppliers, rfqs } from './schema';

type Queryable = Database | Tx;

export type RfqRow = typeof rfqs.$inferSelect;
export type RfqLineRow = typeof rfqLines.$inferSelect;
export type RfqLineValues = Pick<RfqLineRow, 'requisitionLineId' | 'description' | 'quantity' | 'uom'>;

export async function insertRfq(
  tx: Tx,
  values: Pick<RfqRow, 'number' | 'requisitionId' | 'title' | 'responseDueAt' | 'createdByUserId'>,
): Promise<string> {
  const [row] = await tx.insert(rfqs).values(values).returning({ id: rfqs.id });
  if (!row) throw new Error('rfq insert returned no row');
  return row.id;
}

/** Draft lines and invitations are replaced wholesale on edit (the triggers allow it only for drafts). */
export async function replaceRfqLines(tx: Tx, rfqId: string, lines: readonly RfqLineValues[]): Promise<void> {
  await tx.delete(rfqLines).where(eq(rfqLines.rfqId, rfqId));
  if (lines.length > 0) await tx.insert(rfqLines).values(lines.map((line, i) => ({ ...line, rfqId, lineNo: i + 1 })));
}

/** Makes the invitations equal `supplierIds`; suppliers who stay keep their invitation time. */
export async function syncInvitations(tx: Tx, rfqId: string, supplierIds: readonly string[], invitedByUserId: string): Promise<void> {
  await tx
    .delete(rfqSuppliers)
    .where(and(eq(rfqSuppliers.rfqId, rfqId), supplierIds.length > 0 ? notInArray(rfqSuppliers.supplierId, [...supplierIds]) : undefined));
  if (supplierIds.length > 0) {
    await tx
      .insert(rfqSuppliers)
      .values(supplierIds.map((supplierId) => ({ rfqId, supplierId, invitedByUserId })))
      .onConflictDoNothing();
  }
}

export async function findRfq(db: Queryable, id: string): Promise<RfqRow | null> {
  const [row] = await db.select().from(rfqs).where(eq(rfqs.id, id));
  return row ?? null;
}

export async function lockRfq(tx: Tx, id: string): Promise<RfqRow | null> {
  const [row] = await tx.select().from(rfqs).where(eq(rfqs.id, id)).for('update');
  return row ?? null;
}

export async function findRfqLines(db: Queryable, rfqId: string): Promise<RfqLineRow[]> {
  return db.select().from(rfqLines).where(eq(rfqLines.rfqId, rfqId)).orderBy(asc(rfqLines.lineNo));
}

export async function findInvitations(db: Queryable, rfqId: string): Promise<{ supplierId: string; invitedAt: Date }[]> {
  return db
    .select({ supplierId: rfqSuppliers.supplierId, invitedAt: rfqSuppliers.invitedAt })
    .from(rfqSuppliers)
    .where(eq(rfqSuppliers.rfqId, rfqId))
    .orderBy(asc(rfqSuppliers.invitedAt), asc(rfqSuppliers.supplierId));
}

export async function updateRfq(
  tx: Tx,
  id: string,
  expectedVersion: number,
  values: Partial<
    Pick<
      RfqRow,
      | 'title'
      | 'responseDueAt'
      | 'status'
      | 'issuedByUserId'
      | 'closedByUserId'
      | 'cancelledByUserId'
      | 'cancelReason'
      | 'awardedQuotationId'
      | 'awardedByUserId'
      | 'awardJustification'
      | 'awardRfqRequiredAbove'
      | 'awardMinQuotes'
      | 'awardValidQuotes'
      | 'awardBelowMinQuotes'
      | 'awardNotLowest'
    > & {
      issuedAt: SQL;
      closedAt: SQL;
      cancelledAt: SQL;
      awardedAt: SQL;
    }
  >,
): Promise<number> {
  const [row] = await tx
    .update(rfqs)
    .set({ ...values, updatedAt: sql`now()`, version: sql`${rfqs.version} + 1` })
    .where(and(eq(rfqs.id, id), eq(rfqs.version, expectedVersion)))
    .returning({ version: rfqs.version });
  if (!row) throw new Error('rfqs row changed under its lock');
  return row.version;
}

/**
 * Requisition lines already on another RFQ that is not cancelled, with that RFQ's number.
 * Read under the requisition's row lock, so concurrent drafts of the same lines queue up.
 */
export async function findLinesOnOtherRfqs(
  db: Queryable,
  requisitionLineIds: readonly string[],
  exceptRfqId: string | null,
): Promise<Map<string, string>> {
  if (requisitionLineIds.length === 0) return new Map();
  const rows = await db
    .select({ requisitionLineId: rfqLines.requisitionLineId, number: rfqs.number })
    .from(rfqLines)
    .innerJoin(rfqs, eq(rfqs.id, rfqLines.rfqId))
    .where(
      and(
        inArray(rfqLines.requisitionLineId, [...requisitionLineIds]),
        ne(rfqs.status, 'cancelled'),
        exceptRfqId ? ne(rfqs.id, exceptRfqId) : undefined,
      ),
    )
    .orderBy(asc(rfqs.number));
  const result = new Map<string, string>();
  for (const row of rows) if (!result.has(row.requisitionLineId)) result.set(row.requisitionLineId, row.number);
  return result;
}

function contains(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export type RfqSummaryRow = RfqRow & { lineCount: number; supplierCount: number };

export async function searchRfqs(
  db: Queryable,
  search: { status: string | undefined; requisitionId: string | undefined; q: string; beforeNumber: string | undefined; limit: number },
): Promise<RfqSummaryRow[]> {
  const q = search.q.trim();
  const lineCount = db.select({ n: count() }).from(rfqLines).where(eq(rfqLines.rfqId, rfqs.id));
  const supplierCount = db.select({ n: count() }).from(rfqSuppliers).where(eq(rfqSuppliers.rfqId, rfqs.id));
  const rows = await db
    .select({ rfq: rfqs, lineCount: sql<number>`(${lineCount})::int`, supplierCount: sql<number>`(${supplierCount})::int` })
    .from(rfqs)
    .where(
      and(
        search.status ? eq(rfqs.status, search.status) : undefined,
        search.requisitionId ? eq(rfqs.requisitionId, search.requisitionId) : undefined,
        q ? or(ilike(rfqs.number, contains(q)), ilike(rfqs.title, contains(q))) : undefined,
        search.beforeNumber ? lt(rfqs.number, search.beforeNumber) : undefined,
      ),
    )
    .orderBy(desc(rfqs.number))
    .limit(search.limit);
  return rows.map((r) => ({ ...r.rfq, lineCount: r.lineCount, supplierCount: r.supplierCount }));
}
