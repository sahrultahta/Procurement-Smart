import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from '../../identity/tables';

/*
 * Supplier master data (docs/schema.md, Phase 4). Declarations only (no I/O, no
 * `server-only`), so drizzle-kit can load this file. No bank or payment details, on purpose.
 */
const tz = { withTimezone: true, mode: 'date' } as const;

export const suppliers = pgTable(
  'suppliers',
  {
    id: uuid('id').default(sql`uuidv7()`).primaryKey(),
    code: text('code').notNull().unique(),
    legalName: text('legal_name').notNull(),
    /** Duplicate key: see normalizeSupplierName. */
    normalizedName: text('normalized_name').notNull(),
    /** As typed, for display. */
    taxId: text('tax_id'),
    /** Duplicate key: letters and digits only, uppercase. */
    taxIdNormalized: text('tax_id_normalized'),
    email: text('email'),
    phone: text('phone'),
    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    region: text('region'),
    postalCode: text('postal_code'),
    countryCode: text('country_code').notNull(),
    status: text('status').notNull().default('pending_review'),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    identityChangedByUserId: uuid('identity_changed_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    reviewedAt: timestamp('reviewed_at', tz),
    reviewNote: text('review_note'),
    /** Why it was last rejected, blocked, or deactivated. */
    statusReason: text('status_reason'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    check('suppliers_status', sql`${t.status} IN ('pending_review', 'active', 'blocked', 'inactive')`),
    check('suppliers_code_format', sql`${t.code} ~ '^SUP-[0-9]{6}$'`),
    check('suppliers_legal_name_length', sql`char_length(${t.legalName}) BETWEEN 1 AND 200`),
    check('suppliers_normalized_name_length', sql`char_length(${t.normalizedName}) BETWEEN 1 AND 200`),
    check(
      'suppliers_tax_id_pair',
      sql`(${t.taxId} IS NULL) = (${t.taxIdNormalized} IS NULL) AND (${t.taxId} IS NULL OR char_length(${t.taxId}) <= 40)`,
    ),
    check('suppliers_tax_id_normalized_format', sql`${t.taxIdNormalized} IS NULL OR ${t.taxIdNormalized} ~ '^[A-Z0-9]{5,30}$'`),
    check(
      'suppliers_text_lengths',
      sql`coalesce(char_length(${t.email}), 0) <= 254 AND coalesce(char_length(${t.phone}), 0) <= 30
        AND coalesce(char_length(${t.addressLine1}), 0) <= 200 AND coalesce(char_length(${t.addressLine2}), 0) <= 200
        AND coalesce(char_length(${t.city}), 0) <= 100 AND coalesce(char_length(${t.region}), 0) <= 100
        AND coalesce(char_length(${t.postalCode}), 0) <= 20 AND coalesce(char_length(${t.reviewNote}), 0) <= 2000
        AND coalesce(char_length(${t.statusReason}), 0) <= 2000`,
    ),
    check('suppliers_country_code_format', sql`${t.countryCode} ~ '^[A-Z]{2}$'`),
    check('suppliers_review_consistent', sql`(${t.reviewedByUserId} IS NULL) = (${t.reviewedAt} IS NULL)`),
    // SOD-03 backstop: the reviewer is never the creator or the last identity changer.
    check(
      'suppliers_maker_checker',
      sql`${t.reviewedByUserId} IS NULL OR (${t.reviewedByUserId} <> ${t.createdByUserId} AND ${t.reviewedByUserId} IS DISTINCT FROM ${t.identityChangedByUserId})`,
    ),
    // AB-04 backstop: an active supplier always carries the review of its current identity.
    check('suppliers_active_is_reviewed', sql`${t.status} <> 'active' OR ${t.reviewedByUserId} IS NOT NULL`),
    // Duplicates (US-SUP-01): names among suppliers that are not inactive; tax IDs always.
    uniqueIndex('suppliers_normalized_name_live_unique').on(t.normalizedName).where(sql`${t.status} <> 'inactive'`),
    uniqueIndex('suppliers_tax_id_normalized_unique').on(t.taxIdNormalized).where(sql`${t.taxIdNormalized} IS NOT NULL`),
    index('suppliers_status_code_idx').on(t.status, t.code),
  ],
);
