import 'server-only';
import { and, asc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import type { Database, Tx } from '@/shared/db/transaction';
import { quotationLines, quotations } from './schema';

type Queryable = Database | Tx;

export type QuotationRow = typeof quotations.$inferSelect;
export type QuotationLineRow = typeof quotationLines.$inferSelect;
export type QuotationLineValues = Pick<QuotationLineRow, 'rfqLineId' | 'quantity' | 'unitPrice' | 'lineTotal'>;
export type QuotationTerms = Pick<QuotationRow, 'supplierReference' | 'validUntil' | 'leadTimeDays' | 'total'>;

export async function insertQuotation(
  tx: Tx,
  values: QuotationTerms & Pick<QuotationRow, 'rfqId' | 'supplierId' | 'currencyCode' | 'recordedByUserId'>,
): Promise<string> {
  const [row] = await tx.insert(quotations).values(values).returning({ id: quotations.id });
  if (!row) throw new Error('quotation insert returned no row');
  return row.id;
}

/** Draft lines are replaced wholesale on edit (the trigger allows it only for drafts). */
export async function replaceQuotationLines(tx: Tx, quotationId: string, lines: readonly QuotationLineValues[]): Promise<void> {
  await tx.delete(quotationLines).where(eq(quotationLines.quotationId, quotationId));
  if (lines.length > 0) await tx.insert(quotationLines).values(lines.map((line) => ({ ...line, quotationId })));
}

export async function findQuotation(db: Queryable, id: string): Promise<QuotationRow | null> {
  const [row] = await db.select().from(quotations).where(eq(quotations.id, id));
  return row ?? null;
}

export async function lockQuotation(tx: Tx, id: string): Promise<QuotationRow | null> {
  const [row] = await tx.select().from(quotations).where(eq(quotations.id, id)).for('update');
  return row ?? null;
}

/** An RFQ's quotations in the order they were recorded. */
export async function findQuotations(db: Queryable, rfqId: string): Promise<QuotationRow[]> {
  return db.select().from(quotations).where(eq(quotations.rfqId, rfqId)).orderBy(asc(quotations.createdAt), asc(quotations.id));
}

/** All quotations of an RFQ, locked in id order (after the RFQ row: ADR 0008 C8). */
export async function lockQuotations(tx: Tx, rfqId: string): Promise<QuotationRow[]> {
  return tx.select().from(quotations).where(eq(quotations.rfqId, rfqId)).orderBy(asc(quotations.id)).for('update');
}

/** The supplier's quotation on this RFQ that is not withdrawn, if any (one at most: unique index). */
export async function findLiveQuotation(db: Queryable, rfqId: string, supplierId: string): Promise<QuotationRow | null> {
  const [row] = await db
    .select()
    .from(quotations)
    .where(and(eq(quotations.rfqId, rfqId), eq(quotations.supplierId, supplierId), ne(quotations.status, 'withdrawn')));
  return row ?? null;
}

export async function findQuotationLines(db: Queryable, quotationIds: readonly string[]): Promise<QuotationLineRow[]> {
  if (quotationIds.length === 0) return [];
  return db.select().from(quotationLines).where(inArray(quotationLines.quotationId, [...quotationIds]));
}

export async function updateQuotation(
  tx: Tx,
  id: string,
  expectedVersion: number,
  values: Partial<
    QuotationTerms &
      Pick<QuotationRow, 'status' | 'submittedAt' | 'submittedByUserId' | 'withdrawnByUserId' | 'withdrawReason'> & {
        withdrawnAt: SQL;
      }
  >,
): Promise<number> {
  const [row] = await tx
    .update(quotations)
    .set({ ...values, updatedAt: sql`now()`, version: sql`${quotations.version} + 1` })
    .where(and(eq(quotations.id, id), eq(quotations.version, expectedVersion)))
    .returning({ version: quotations.version });
  if (!row) throw new Error('quotations row changed under its lock');
  return row.version;
}
