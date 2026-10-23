/*
 * Public table declarations of the identity module, for foreign keys in other modules'
 * schemas only (docs/architecture.md). Declarations, no I/O and no `server-only`, so
 * drizzle-kit can load them. Queries on these tables stay inside the identity module.
 */
export { users } from './infrastructure/auth-schema';
export { departments } from './infrastructure/schema';
