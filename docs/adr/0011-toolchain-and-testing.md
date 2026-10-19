# ADR 0011: Toolchain pins and testing strategy

- Status: Accepted. The ESLint row is superseded by [ADR 0012](0012-eslint-9-and-install-script-policy.md) (ESLint 9.39.5).
- Date: 2026-10-18

## Context

The brief requires checking current official versions and compatibility before choosing dependencies. Everything below was checked on **2026-10-18** with `npm view <pkg> version dist-tags engines peerDependencies`, nodejs.org/dist/index.json, postgresql.org/support/versioning, and nextjs.org docs.

## Decision: versions

| Component | Choice | Verified facts (2026-10-18) |
| --- | --- | --- |
| Node.js | **24.x LTS ("Krypton")** | Latest 24.22.0 (2026-10-14). Dev machine has 24.21.0. Node 26.12.0 is `lts: false`, so re-evaluate once 26 is LTS. |
| npm | 11.x (bundled) | Dev machine 11.19.0. pnpm and yarn are not installed, so npm it is. |
| Next.js | **16.4.x** | `latest` 16.4.2 (published 2026-10-15). `engines.node >=20.9.0`. |
| React / React DOM | **19.3.x** | 19.3.1. Next peer `^19.0.0`. |
| TypeScript | **6.0.x (pinned, not 7.x)** | `latest` is **7.0.2**, but `typescript-eslint` 8.71.2 (what `eslint-config-next` 16.4.2 uses) declares peer `typescript >=4.8.4 <6.1.0`. 6.0.3 (2026-04-16) satisfies it. Next 16 needs TS >= 5.1. Revisit TS 7 when typescript-eslint supports it. |
| ESLint | **10.x** + `eslint-config-next` 16.4.x | ESLint 10.13.0. `eslint-config-next` peer `eslint >=9`, and the Next docs say 16.4.0+ supports ESLint 10. Flat config. |
| PostgreSQL | **18.x** | 18.6 current (ADR 0003). |
| Drizzle | `drizzle-orm` **0.45.x**, `drizzle-kit` **0.31.x** | 0.45.4 / 0.31.11. 1.0 is in RC (ADR 0004). |
| Driver | `pg` **8.x** + `@types/pg` | 8.23.1. |
| Auth | `better-auth` **1.7.x** | 1.7.10. Peers OK with next 16, react 19, drizzle 0.45, pg 8 (ADR 0005). |
| Validation | `zod` **4.x** | 4.6.7. |
| Decimal | `decimal.js` **10.6.x** | 10.6.0. |
| Unit and integration tests | `vitest` **5.0.x** | 5.0.5. `engines.node ^22.12 \|\| ^24 \|\| >=26`. Peer `vite ^6.4 \|\| ^7 \|\| ^8`. |
| E2E | `@playwright/test` **1.64.x** | 1.64.1. Next peer `^1.51.1`. |
| Styling | `tailwindcss` **4.x** | 4.3.3. A component library decision is deferred to Phase 3, with accessibility as the main criterion. |

**Pinning policy:** `package.json` uses exact versions and `package-lock.json` is committed. CI uses `npm ci`. When adding a dependency, prefer the newest patch that has been public for at least 7 days, unless a newer one fixes a security advisory. Every version is re-checked with `npm view` at install time and recorded in that phase's report. Dependabot proposes updates, and a human merges them.

## Decision: testing strategy

| Layer | Tool | Database | What it proves |
| --- | --- | --- | --- |
| Unit | Vitest | none | Domain state machines (every transition and every forbidden transition), pricing and rounding, policy functions (permission matrix, SoD), Zod schemas. Property tests via `fast-check` (version checked at install). |
| Integration | Vitest | real PostgreSQL 18; **one database per test file**, cloned with `CREATE DATABASE ... TEMPLATE pf_template` (migrated once per run) | Commands end to end through `runCommand`: validation, authorization, transactions, constraints, triggers, audit rows. |
| Concurrency | Vitest, separate pool connections | real PostgreSQL 18 | CC-01 to CC-07 (ADR 0008). |
| E2E | Playwright (Chromium in CI; Firefox and WebKit optional) | real PostgreSQL 18 with fictional seed | Login and logout, cookie flags, role-based navigation, one golden path per phase, unauthorized URL access. |
| Static | `tsc --noEmit`, ESLint (incl. boundary and banned-API rules), `npm audit --audit-level=high`, `gitleaks` | | Types, architecture rules, known-vulnerable dependencies, secrets |

Template-database cloning means the append-only audit triggers never have to be disabled for test cleanup.

**Coverage:** a reported metric, not a target to game. The gate is that `domain/` and `application/` line coverage must not drop below 85%, starting in Phase 2. More important than the number: every command has tests for success, `UNAUTHENTICATED`, `FORBIDDEN`, validation failure, invalid transition, and its audit event.

## Decision: CI (GitHub Actions)

Jobs: `lint` → `typecheck` → `unit` → `integration + concurrency` (service `postgres:18`) → `build` → `e2e`. Plus `npm audit`, `gitleaks`, and CodeQL default setup. The workflow file is written in Phase 1, but **it can't be verified until the repository has a GitHub remote.** Until then, phase reports say "CI not executed", and the same commands are run locally.

## Consequences

- Holding TypeScript at 6.0 is a deliberate lag, recorded here so nobody "fixes" it by bumping to 7.
- One database per test file costs about a second per file. Acceptable.
