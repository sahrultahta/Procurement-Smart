# Architecture Decision Records

Each ADR records one decision: its context, the options considered, the choice made, and its consequences. ADRs are append-only. To change a decision, write a new ADR that supersedes the old one and update the old one's status line. Do not rewrite the old one.

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-clean-room-repository.md) | Clean-room repository, separate from any employer code | Accepted |
| [0002](0002-modular-monolith-nextjs.md) | Modular monolith on Next.js 16 App Router | Accepted |
| [0003](0003-postgresql.md) | PostgreSQL 18 as the only datastore | Accepted |
| [0004](0004-drizzle-orm.md) | Drizzle ORM with node-postgres | Accepted |
| [0005](0005-better-auth.md) | Better Auth for authentication only | Accepted |
| [0006](0006-authorization-model.md) | Code-defined RBAC, scoped assignments, separation-of-duties policies | Accepted |
| [0007](0007-money-and-quantities.md) | Money and quantities: `numeric` + decimal.js, computed server-side | Accepted |
| [0008](0008-transactions-and-concurrency.md) | Transactions and concurrency control | Accepted |
| [0009](0009-append-only-audit.md) | Append-only audit trail enforced by the database | Accepted |
| [0010](0010-application-command-layer.md) | Transport-agnostic command layer; Server Actions first, REST later | Accepted |
| [0011](0011-toolchain-and-testing.md) | Toolchain pins and testing strategy | Accepted |

"Accepted" means the decision is recorded and the plan is built on it. None of these decisions has been validated by running code yet. Each ADR's **Verification** section names the phase that will prove it or force a revision.
