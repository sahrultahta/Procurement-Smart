/**
 * Composition root for database table definitions. drizzle-kit reads this file
 * to generate migrations. Relative paths, because drizzle-kit does not resolve
 * the `@/` alias.
 */
export * from '../shared/db/tables';
export * from '../modules/audit/infrastructure/schema';
export * from '../modules/identity/infrastructure/auth-schema';
export * from '../modules/identity/infrastructure/schema';
export * from '../modules/suppliers/infrastructure/schema';
export * from '../modules/organization/infrastructure/schema';
export * from '../modules/approvals/infrastructure/schema';
export * from '../modules/requisitions/infrastructure/schema';
export * from '../modules/sourcing/infrastructure/schema';
