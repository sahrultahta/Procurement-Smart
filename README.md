# ProcureFlow

An open-source procurement workflow system: suppliers, purchase requisitions with multi-step approvals, quotations, purchase orders, goods receipts, an append-only audit trail, and reporting.

## Status

**Phase 0 (planning) is approved. Implementation starts with Phase 1. Until a phase report says otherwise, nothing here is working software.** Implementation happens in gated phases, and each phase ends with a report of exactly what was run and what passed (`docs/reports/`).

## Design documents

| Document | Contents |
| --- | --- |
| [docs/PLAN.md](docs/PLAN.md) | Phases, acceptance criteria, definition of done, report template, open decisions |
| [docs/architecture.md](docs/architecture.md) | Modules, dependency rules, request lifecycle, cross-cutting concerns, deployment target |
| [docs/adr/](docs/adr/README.md) | Architecture decision records 0001–0011 |
| [docs/user-stories.md](docs/user-stories.md) | Personas and stories with acceptance criteria |
| [docs/state-machines.md](docs/state-machines.md) | Requisition, approval, supplier, RFQ, quotation, PO, goods-receipt lifecycles |
| [docs/schema.md](docs/schema.md) | PostgreSQL schema design and constraints |
| [docs/api-contracts.md](docs/api-contracts.md) | Application commands and queries, error codes |
| [docs/threat-model.md](docs/threat-model.md) | STRIDE analysis and procurement abuse cases |

## Planned stack (versions checked 2026-10-18, see ADR 0011)

Next.js 16 (App Router, Node.js runtime) · React 19 · TypeScript 6.0 · PostgreSQL 18 · Drizzle ORM · Better Auth · Zod 4 · decimal.js · Vitest 5 · Playwright · GitHub Actions

## Principles

- Server-side authorization on every operation, least privilege, separation of duties (no self-approval).
- Every state transition validated on the server against the locked current state.
- Money computed on the server with decimal arithmetic. Client-sent totals are never trusted.
- Database constraints back up application rules (no over-ordering, no over-receipt).
- Append-only audit trail written in the same transaction as the change.
- No hardcoded metrics, no fake functionality, fictional seed data only, no secrets in the repo.

## License

[Apache License 2.0](LICENSE). Copyright 2026 ProcureFlow contributors (see [NOTICE](NOTICE)).
