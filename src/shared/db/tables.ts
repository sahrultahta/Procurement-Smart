import { sql } from 'drizzle-orm';
import { check, integer, jsonb, pgTable, primaryKey, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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

/**
 * Idempotency keys for create commands (ADR 0008 C6): a repeated (user, key) returns the
 * first result instead of creating a second document. The user id is not a foreign key:
 * src/shared must not depend on the identity module.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    userId: uuid('user_id').notNull(),
    key: text('key').notNull(),
    operation: text('operation').notNull(),
    /** sha256 of the canonical input: the same key with different input is refused. */
    requestHash: text('request_hash').notNull(),
    response: jsonb('response'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'idempotency_keys_pkey', columns: [t.userId, t.key] }),
    check('idempotency_keys_key_format', sql`${t.key} ~ '^[A-Za-z0-9_-]{8,100}$'`),
    check('idempotency_keys_request_hash_format', sql`${t.requestHash} ~ '^[0-9a-f]{64}$'`),
  ],
);
