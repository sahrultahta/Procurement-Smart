import { sql } from 'drizzle-orm';
import { check, integer, pgTable, primaryKey, smallint, text } from 'drizzle-orm/pg-core';

/*
 * Table declarations only (no I/O), so drizzle-kit can load this file directly.
 * That is why it has no `server-only` import.
 */

/** Gapless per-type, per-year document counters (ADR 0008 C5). year = 0 means "not yearly". */
export const documentSequences = pgTable(
  'document_sequences',
  {
    docType: text('doc_type').notNull(),
    year: smallint('year').notNull(),
    lastValue: integer('last_value').notNull().default(0),
  },
  (t) => [
    primaryKey({ name: 'document_sequences_pkey', columns: [t.docType, t.year] }),
    check('document_sequences_doc_type_format', sql`${t.docType} ~ '^[A-Z]{2,4}$'`),
    check('document_sequences_year_range', sql`${t.year} = 0 OR ${t.year} BETWEEN 2000 AND 2999`),
    check('document_sequences_last_value_non_negative', sql`${t.lastValue} >= 0`),
  ],
);
