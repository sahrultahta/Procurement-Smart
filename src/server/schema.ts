/**
 * Composition root for database table definitions. drizzle-kit reads this file
 * to generate migrations. Relative paths, because drizzle-kit does not resolve
 * the `@/` alias.
 */
export * from '../shared/db/tables';
export * from '../modules/audit/infrastructure/schema';
