import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/*
 * Better Auth tables (ADR 0005). Generated with `npx auth generate` from
 * scripts/auth-cli.config.ts (Better Auth 1.7.7), then reviewed:
 *   - timestamps are timestamptz (project convention), not timestamp
 *   - emails are stored lowercase (CHECK)
 *   - unused relation helpers removed
 * Property names must stay as generated: the Better Auth Drizzle adapter maps fields by them.
 * Declarations only (no I/O, no `server-only`), so drizzle-kit can load this file.
 */
const tz = { withTimezone: true, mode: 'date' } as const;

export const users = pgTable(
  'users',
  {
    id: uuid('id').default(sql`pg_catalog.gen_random_uuid()`).primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull().unique(),
    emailVerified: boolean('email_verified').default(false).notNull(),
    image: text('image'),
    createdAt: timestamp('created_at', tz).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', tz)
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    check('users_email_lowercase', sql`${t.email} = lower(${t.email})`),
    check('users_name_length', sql`char_length(${t.name}) BETWEEN 1 AND 120`),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').default(sql`pg_catalog.gen_random_uuid()`).primaryKey(),
    expiresAt: timestamp('expires_at', tz).notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at', tz).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', tz)
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId)],
);

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').default(sql`pg_catalog.gen_random_uuid()`).primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', tz),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', tz),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', tz).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', tz)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index('accounts_user_id_idx').on(t.userId)],
);

export const verifications = pgTable(
  'verifications',
  {
    id: uuid('id').default(sql`pg_catalog.gen_random_uuid()`).primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', tz).notNull(),
    createdAt: timestamp('created_at', tz).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', tz)
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index('verifications_identifier_idx').on(t.identifier)],
);

export const rateLimits = pgTable('rate_limits', {
  id: uuid('id').default(sql`pg_catalog.gen_random_uuid()`).primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
});
