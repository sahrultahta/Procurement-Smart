/*
 * Public table declarations of the sourcing module, for foreign keys in other modules'
 * schemas only (docs/architecture.md). Declarations, no I/O and no `server-only`, so
 * drizzle-kit can load them. Queries on these tables stay inside the sourcing module.
 */
export { quotationLines, quotations } from './infrastructure/schema';
