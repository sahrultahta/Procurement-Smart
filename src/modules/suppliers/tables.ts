/*
 * Public table declarations of the suppliers module, for foreign keys in other modules'
 * schemas only (docs/architecture.md). Declarations, no I/O and no `server-only`, so
 * drizzle-kit can load them. Queries on these tables stay inside the suppliers module.
 */
export { suppliers } from './infrastructure/schema';
