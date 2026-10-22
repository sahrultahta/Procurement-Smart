import 'server-only';
import { and, asc, eq, gt, ne, or, sql, type SQL } from 'drizzle-orm';
import type { Database, Tx } from '@/shared/db/transaction';
import { suppliers } from './schema';

type Queryable = Database | Tx;

export type SupplierRow = typeof suppliers.$inferSelect;
type SupplierInsert = typeof suppliers.$inferInsert;

/** The fields a user edits (the rest is set by the commands). */
export type SupplierFields = Pick<
  SupplierRow,
  | 'legalName'
  | 'normalizedName'
  | 'taxId'
  | 'taxIdNormalized'
  | 'email'
  | 'phone'
  | 'addressLine1'
  | 'addressLine2'
  | 'city'
  | 'region'
  | 'postalCode'
  | 'countryCode'
>;

/** Inserts unless a unique key (code, live name, tax ID) is taken; then returns null. */
export async function insertSupplier(
  tx: Tx,
  values: SupplierFields & Pick<SupplierInsert, 'code' | 'createdByUserId'>,
): Promise<string | null> {
  const [row] = await tx.insert(suppliers).values(values).onConflictDoNothing().returning({ id: suppliers.id });
  return row?.id ?? null;
}

export async function lockSupplier(tx: Tx, supplierId: string): Promise<SupplierRow | null> {
  const [row] = await tx.select().from(suppliers).where(eq(suppliers.id, supplierId)).for('update');
  return row ?? null;
}

export async function findSupplier(db: Queryable, supplierId: string): Promise<SupplierRow | null> {
  const [row] = await db.select().from(suppliers).where(eq(suppliers.id, supplierId));
  return row ?? null;
}

/** The non-inactive supplier holding this name key, other than `exceptId`. */
export async function findLiveNameOwner(
  db: Queryable,
  normalizedName: string,
  exceptId: string | null,
): Promise<{ id: string; code: string } | null> {
  const [row] = await db
    .select({ id: suppliers.id, code: suppliers.code })
    .from(suppliers)
    .where(
      and(
        eq(suppliers.normalizedName, normalizedName),
        ne(suppliers.status, 'inactive'),
        exceptId ? ne(suppliers.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Any supplier (whatever its status) holding this tax ID key, other than `exceptId`. */
export async function findTaxIdOwner(
  db: Queryable,
  taxIdNormalized: string,
  exceptId: string | null,
): Promise<{ id: string; code: string } | null> {
  const [row] = await db
    .select({ id: suppliers.id, code: suppliers.code })
    .from(suppliers)
    .where(and(eq(suppliers.taxIdNormalized, taxIdNormalized), exceptId ? ne(suppliers.id, exceptId) : undefined))
    .limit(1);
  return row ?? null;
}

type Changeable = Partial<
  SupplierFields &
    Pick<SupplierRow, 'status' | 'identityChangedByUserId' | 'reviewedByUserId' | 'reviewNote' | 'statusReason'> & {
      reviewedAt: Date | SQL | null;
    }
>;

/** Conditional on the version the caller checked under the row lock; returns the new version. */
export async function updateSupplier(tx: Tx, supplierId: string, expectedVersion: number, values: Changeable): Promise<number> {
  const [row] = await tx
    .update(suppliers)
    .set({ ...values, updatedAt: sql`now()`, version: sql`${suppliers.version} + 1` })
    .where(and(eq(suppliers.id, supplierId), eq(suppliers.version, expectedVersion)))
    .returning({ version: suppliers.version });
  if (!row) throw new Error('suppliers row changed under its lock');
  return row.version;
}

/** Escapes LIKE wildcards so user text always matches literally (threat T-03, P4-AC6). */
function contains(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export type SupplierSearch = {
  status: SupplierRow['status'] | undefined;
  /** Already normalized by the caller; empty strings are ignored. */
  nameKey: string;
  codeTerm: string;
  taxIdKey: string;
  afterCode: string | undefined;
  limit: number;
};

export async function searchSuppliers(db: Queryable, search: SupplierSearch): Promise<SupplierRow[]> {
  const matches = [
    search.nameKey ? sql`${suppliers.normalizedName} LIKE ${contains(search.nameKey)} ESCAPE '\\'` : undefined,
    search.codeTerm ? sql`${suppliers.code} ILIKE ${contains(search.codeTerm)} ESCAPE '\\'` : undefined,
    search.taxIdKey ? sql`${suppliers.taxIdNormalized} LIKE ${contains(search.taxIdKey)} ESCAPE '\\'` : undefined,
  ].filter((m) => m !== undefined);
  const searching = search.nameKey !== '' || search.codeTerm !== '' || search.taxIdKey !== '';
  return db
    .select()
    .from(suppliers)
    .where(
      and(
        search.status ? eq(suppliers.status, search.status) : undefined,
        search.afterCode ? gt(suppliers.code, search.afterCode) : undefined,
        // A search term that normalizes to nothing matches nothing (never "everything").
        searching ? (matches.length > 0 ? or(...matches) : sql`false`) : undefined,
      ),
    )
    .orderBy(asc(suppliers.code))
    .limit(search.limit);
}

export async function listActiveSuppliers(db: Queryable): Promise<Pick<SupplierRow, 'id' | 'code' | 'legalName'>[]> {
  return db
    .select({ id: suppliers.id, code: suppliers.code, legalName: suppliers.legalName })
    .from(suppliers)
    .where(eq(suppliers.status, 'active'))
    .orderBy(asc(suppliers.legalName), asc(suppliers.code));
}
