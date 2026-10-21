import 'server-only';
import { sql } from 'drizzle-orm';
import { documentSequences } from './tables';
import type { Tx } from './transaction';

/** Document number prefixes (docs/state-machines.md). Suppliers are numbered without a year. */
export type DocumentType = 'PR' | 'RFQ' | 'PO' | 'GR' | 'SUP';

/**
 * Allocates the next number for (type, year) inside the caller's transaction.
 * The upsert row-locks the counter, so concurrent allocations serialize, and a
 * rolled-back transaction gives its number back: committed numbers are gapless.
 */
export async function allocateDocumentNumber(tx: Tx, type: DocumentType, year: number): Promise<number> {
  const rows = await tx
    .insert(documentSequences)
    .values({ docType: type, year, lastValue: 1 })
    .onConflictDoUpdate({
      target: [documentSequences.docType, documentSequences.year],
      set: { lastValue: sql`${documentSequences.lastValue} + 1` },
    })
    .returning({ value: documentSequences.lastValue });
  const value = rows[0]?.value;
  if (value === undefined) throw new Error('Document number allocation returned no row');
  return value;
}

/** 'PR-2026-000042', or 'SUP-000042' when year is 0. */
export function formatDocumentNumber(type: DocumentType, year: number, value: number): string {
  if (!Number.isInteger(value) || value < 1) throw new Error(`Invalid document sequence value: ${value}`);
  const serial = String(value).padStart(6, '0');
  return year === 0 ? `${type}-${serial}` : `${type}-${year}-${serial}`;
}
