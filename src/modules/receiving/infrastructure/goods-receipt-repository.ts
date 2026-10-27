import 'server-only';
import { and, asc, desc, eq, ilike, inArray, lt, sql, type SQL } from 'drizzle-orm';
import type { Database, Tx } from '@/shared/db/transaction';
import { goodsReceiptLines, goodsReceipts } from './schema';

type Queryable = Database | Tx;

export type GoodsReceiptRow = typeof goodsReceipts.$inferSelect;
export type GoodsReceiptLineRow = typeof goodsReceiptLines.$inferSelect;

export async function insertGoodsReceipt(
  tx: Tx,
  values: Pick<
    GoodsReceiptRow,
    'number' | 'purchaseOrderId' | 'kind' | 'reversesGoodsReceiptId' | 'receivedOn' | 'deliveryNoteRef' | 'notes' | 'reason' | 'createdByUserId'
  >,
): Promise<string> {
  const [row] = await tx.insert(goodsReceipts).values(values).returning({ id: goodsReceipts.id });
  if (!row) throw new Error('goods receipt insert returned no row');
  return row.id;
}

/** Lines are added once, to a draft (the trigger refuses anything else). */
export async function insertGoodsReceiptLines(
  tx: Tx,
  goodsReceiptId: string,
  lines: readonly Pick<GoodsReceiptLineRow, 'purchaseOrderLineId' | 'quantity' | 'note'>[],
): Promise<void> {
  await tx.insert(goodsReceiptLines).values(lines.map((line) => ({ ...line, goodsReceiptId })));
}

export async function findGoodsReceipt(db: Queryable, id: string): Promise<GoodsReceiptRow | null> {
  const [row] = await db.select().from(goodsReceipts).where(eq(goodsReceipts.id, id));
  return row ?? null;
}

export async function lockGoodsReceipt(tx: Tx, id: string): Promise<GoodsReceiptRow | null> {
  const [row] = await tx.select().from(goodsReceipts).where(eq(goodsReceipts.id, id)).for('update');
  return row ?? null;
}

export async function findGoodsReceiptLines(db: Queryable, goodsReceiptId: string): Promise<GoodsReceiptLineRow[]> {
  return db.select().from(goodsReceiptLines).where(eq(goodsReceiptLines.goodsReceiptId, goodsReceiptId)).orderBy(asc(goodsReceiptLines.id));
}

/** The reversals of these receipts (GR-I3: at most one each), by the receipt they reverse. */
export async function findReversalsOf(db: Queryable, goodsReceiptIds: readonly string[]): Promise<Map<string, GoodsReceiptRow>> {
  if (goodsReceiptIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(goodsReceipts)
    .where(inArray(goodsReceipts.reversesGoodsReceiptId, [...new Set(goodsReceiptIds)]));
  return new Map(rows.flatMap((row) => (row.reversesGoodsReceiptId ? [[row.reversesGoodsReceiptId, row] as const] : [])));
}

export async function findGoodsReceiptsByIds(db: Queryable, ids: readonly string[]): Promise<GoodsReceiptRow[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(goodsReceipts)
    .where(inArray(goodsReceipts.id, [...new Set(ids)]));
}

export async function updateGoodsReceipt(
  tx: Tx,
  id: string,
  expectedVersion: number,
  values: Partial<Pick<GoodsReceiptRow, 'status' | 'postedByUserId' | 'cancelledByUserId' | 'cancelReason'>> & { postedAt?: SQL; cancelledAt?: SQL },
): Promise<number> {
  const [row] = await tx
    .update(goodsReceipts)
    .set({ ...values, updatedAt: sql`now()`, version: sql`${goodsReceipts.version} + 1` })
    .where(and(eq(goodsReceipts.id, id), eq(goodsReceipts.version, expectedVersion)))
    .returning({ version: goodsReceipts.version });
  if (!row) throw new Error('goods_receipts row changed under its lock');
  return row.version;
}

function contains(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export async function searchGoodsReceipts(
  db: Queryable,
  search: {
    status: string | undefined;
    kind: string | undefined;
    purchaseOrderId: string | undefined;
    q: string;
    beforeNumber: string | undefined;
    limit: number;
  },
): Promise<GoodsReceiptRow[]> {
  const q = search.q.trim();
  return db
    .select()
    .from(goodsReceipts)
    .where(
      and(
        search.status ? eq(goodsReceipts.status, search.status) : undefined,
        search.kind ? eq(goodsReceipts.kind, search.kind) : undefined,
        search.purchaseOrderId ? eq(goodsReceipts.purchaseOrderId, search.purchaseOrderId) : undefined,
        q ? ilike(goodsReceipts.number, contains(q)) : undefined,
        search.beforeNumber ? lt(goodsReceipts.number, search.beforeNumber) : undefined,
      ),
    )
    .orderBy(desc(goodsReceipts.number))
    .limit(search.limit);
}
