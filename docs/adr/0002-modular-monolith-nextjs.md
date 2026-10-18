# ADR 0002: Modular monolith on Next.js 16 App Router

- Status: Accepted
- Date: 2026-10-18

## Context

The brief asks for a modular monolith in TypeScript and Next.js. The domain has clear subdomains (identity, suppliers, requisitions, approvals, sourcing, purchasing, receiving, audit, reporting) that share one database and need cross-module transactions. For example, posting a goods receipt updates purchase-order lines and writes audit events atomically.

Verified on 2026-10-18 against the npm registry and nextjs.org docs:

- `next` latest is 16.4.2. It requires Node `>=20.9.0` and peers React `^19`.
- In Next.js 16, `middleware` is deprecated and renamed `proxy`. `proxy` runs only on the Node.js runtime.
- `next lint` is removed. ESLint runs directly through the ESLint CLI.
- Turbopack is the default bundler for `dev` and `build`.
- Request APIs (`cookies()`, `headers()`, `params`, `searchParams`) are async only.
- Next.js docs recommend a server-only **Data Access Layer** for new projects. They warn that Server Actions are reachable by direct POST and must re-check authentication and authorization inside each action.

## Decision

One deployable Next.js 16 application (App Router, Node.js runtime only, no Edge runtime) structured as a modular monolith:

```
src/
  app/                      # routes only: thin pages, layouts, server actions, route handlers
  modules/
    <module>/
      domain/               # pure TS: types, state machines, invariants, policies. No I/O.
      application/          # commands & queries: validate -> authenticate -> authorize -> transaction -> domain -> persist -> audit
      infrastructure/       # Drizzle tables & repositories for this module
      index.ts              # the module's public API; other modules import only this
  shared/                   # kernel: decimal/money, errors/result, ids, clock, db/transaction helper, validation helpers
  server/                   # composition root: wires modules, auth context, request context
db/migrations/              # generated SQL, reviewed and committed
tests/{unit,integration,concurrency,e2e}/
scripts/                    # local Postgres, seed, bootstrap-admin
```

Rules:

1. `app/` never imports `infrastructure/` or the database. It calls module `application/` functions through `index.ts`.
2. A module never imports another module's internals, only its `index.ts`. ESLint `no-restricted-imports` patterns enforce this. Phase 1 includes a test that proves the rule fires.
3. `domain/` has no imports from Next.js, Drizzle, or Node I/O, so it can be unit-tested without a database.
4. Every file under `application/` and `infrastructure/` starts with `import 'server-only'`.
5. Client Components receive only DTOs built by the application layer, never database rows.

## Alternatives considered

- **Separate backend service (e.g. NestJS) plus Next.js frontend.** Rejected for v1: two deployables and a network boundary with no current scaling need. The command layer (ADR 0010) keeps that split possible later.
- **Microservices per subdomain.** Rejected: cross-module invariants (over-receipt, over-ordering) need single-database transactions.

## Consequences

- Module boundaries are enforced by lint, not by process isolation, so discipline and CI matter.
- Next.js upgrade cadence affects the whole app. Pin exact versions and upgrade deliberately.

## Verification

- Phase 1: scaffold builds with `next build`, the boundary lint rule fails on a fixture violation, and `server-only` import from a client file fails the build.
