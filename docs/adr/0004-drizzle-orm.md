# ADR 0004: Drizzle ORM with node-postgres

- Status: Accepted
- Date: 2026-10-18

## Context

The brief requires exactly one ORM. The two realistic choices are Drizzle and Prisma. Facts checked on 2026-10-18:

| | Drizzle | Prisma |
| --- | --- | --- |
| npm `latest` | `drizzle-orm` 0.45.4 (2026-10-08), `drizzle-kit` 0.31.11 | `@prisma/client` 7.10.1, but the `prisma` CLI's `latest` tag points at **8.0.0-rc.23**, a release candidate |
| Next major | 1.0.0 in RC (`rc` tag 1.0.0-rc.4) | 8.0 in RC |
| PostgreSQL drivers (peer deps) | `pg >=8`, `postgres >=3`, `@electric-sql/pglite >=0.2` | driver adapters |
| Better Auth adapter (peer dep) | `drizzle-orm ^0.45.2 \|\| >=1.0.0-rc.1 <2` | `@prisma/client ^5 \|\| ^6 \|\| ^7` |
| Transactions (docs) | `db.transaction(fn, { isolationLevel, accessMode, deferrable })`, nested savepoints, `tx.rollback()` | interactive transactions |
| `numeric` columns (docs) | supports precision/scale and `mode: 'number' \| 'bigint'` | `Decimal` (decimal.js) |

## Decision

Use **Drizzle ORM 0.45.x** with the **node-postgres (`pg`) 8.x** driver and **drizzle-kit** for SQL migrations.

Reasons:

1. **SQL-level control.** The concurrency design (ADR 0008) relies on conditional `UPDATE ... WHERE ... RETURNING`, `CHECK` constraints, triggers, and row locks. Drizzle keeps these close to SQL, and the `sql` template handles anything the builder lacks, with parameters still bound.
2. **Explicit transaction options** (isolation level) are documented.
3. **Plain SQL migrations** are generated into `db/migrations/`, reviewed in PRs, and can hold hand-written trigger and grant statements.
4. **Release hygiene.** Installing `prisma@latest` today would pull a release candidate CLI next to a 7.x client. That is avoidable with pins, but it is a real hazard.

Rules:

- `numeric` columns are read as **strings** and converted to `Decimal` in the shared kernel. `mode: 'number'` is banned by lint because it would silently use floating point. Drizzle's docs page does not state the default TypeScript type of `numeric()`, so Phase 2 proves it with a type-level test and a runtime round-trip test.
- `sql.raw()` is banned by lint outside `db/` scripts. Use the parameterized `sql` template instead.
- Row locking: Drizzle's select docs do not document `.for('update')`. Phase 1 checks the installed type definitions. If it is absent, locking uses `` sql`... for update` `` inside repository functions with a dedicated test.

## Alternatives considered

- **Prisma 7.** Viable, with a mature migration workflow and Decimal support. Rejected for the reasons above, mainly SQL-level control and the current RC `latest` tag on the CLI.
- **Kysely (query builder only).** Not an ORM, so the brief's "one ORM" would be stretched, and Better Auth's Kysely path is less direct for this setup.

## Consequences

- Drizzle 1.0 is in RC. Staying on 0.45.x means a 0.x to 1.0 migration later. That migration gets its own ADR and phase when 1.0 is stable and Better Auth supports it (its peer range already includes `>=1.0.0-rc.1`).
- Drizzle is less opinionated, so repository conventions must be written down and code-reviewed.

## Verification

- Phase 1: install, generate an empty migration, connect, and run a transaction with `isolationLevel: 'serializable'`. Confirm the row-lock API.
- Phase 2: `numeric` round-trip test (`'12345678901234.5678'` in and the same string out).
