## Phase 2 report: Shared kernel, database roles, audit trail, command runner

- Date: 2026-10-21
- Base commit: `0559290` (Phase 1). Phase 2 is committed as a single commit on top of it (2026-10-21, after maintainer approval), together with this report. Not pushed: there is no remote.
- Machine: Windows 10 Enterprise 19045, Node 24.21.0, npm 11.19.0, local PostgreSQL 18.6 (127.0.0.1:54318)
- No dependencies were added or changed. `decimal.js` and `fast-check` were already installed in Phase 1.

Status vocabulary: **Implemented** (code exists), **Tested** (automated tests exercise it), **Verified** (tests run and passed here, output observed), **Deployed** (none: nothing in this project is deployed).

### What Phase 2 adds

| Area | Files | Status |
| --- | --- | --- |
| Result and error contract (ADR 0010) | `src/shared/result.ts` | Implemented, tested, verified |
| Decimal money, quantities, pricing (ADR 0007) | `src/shared/decimal/{decimal,pricing,format}.ts` | Implemented, tested, verified |
| Clock, request ids | `src/shared/{clock,ids}.ts` | Implemented, tested, verified |
| Structured logger with field allowlist (threat I-05) | `src/shared/logger.ts`, used by `ping-database.ts` and the DB pool | Implemented, tested, verified |
| Transaction helper with lock/statement timeouts (ADR 0008 C7) | `src/shared/db/transaction.ts` | Implemented, tested, verified |
| Gapless document numbering (ADR 0008 C5) | `src/shared/db/{tables,document-numbers}.ts` | Implemented, tested, verified |
| Request context and command/query runner (ADR 0010) | `src/shared/application/{context,runner}.ts` | Implemented, tested, verified. No HTTP entry point uses it yet (Phase 3). |
| Audit module: append-only `audit_events`, writer, field allowlist (ADR 0009) | `src/modules/audit/**` | Implemented, tested, verified |
| Migrations | `db/migrations/0001_audit_events_and_document_sequences.sql` (generated, reviewed), `0002_audit_append_only_and_app_grants.sql` (hand-written: triggers + grants) | Applied to `procureflow_dev` and to every test database |
| Runtime role `procureflow_app` and its bootstrap (ADR 0013) | `scripts/lib/app-role.ts`, `scripts/db-app-role.ts`, `scripts/db-local.ts` (`init`, `ensure-app-role`) | Implemented, verified locally. The CI path is not executed. |

### Commands run (exact) and results

All run on 2026-10-21 against the final working tree, with `NEXT_TELEMETRY_DISABLED=1` for Next.js commands.

| Command | Exit | Result |
| --- | --- | --- |
| `npm run db:local -- start` | 0 | PostgreSQL started on 127.0.0.1:54318 |
| `npm run db:local -- ensure-app-role` | 0 | `procureflow_app` created. Previous `.env` backed up to `.local/env-backup-2026-10-21T04-04-52-926Z.txt`. `.env` now has `DATABASE_URL` (app role), `DATABASE_MIGRATION_URL` (owner), `TEST_DATABASE_URL`, `TEST_APP_DATABASE_URL`. |
| `npx drizzle-kit generate --name=audit_events_and_document_sequences` | 0 | 2 tables, 4 indexes; SQL reviewed |
| `npx drizzle-kit generate --custom --name=audit_append_only_and_app_grants` | 0 | empty file, then filled by hand |
| `npm run db:migrate` | 0 | "Migrations applied." (dev database, as owner) |
| `npm run lint` | 0 | no findings (`--max-warnings=0`) |
| `npm run typecheck` | 0 | no errors |
| `npm run test:unit` | 0 | 9 files, **133 passed** |
| `npm run test:integration` | 0 | 7 files, **57 passed** (integration + concurrency) |
| `npm run test:coverage` | 0 | 16 files, **190 passed**. Coverage thresholds met (below). |
| `rm -rf .next && npm run build` | 0 | **0 warnings** |
| `npm run test:e2e` | 0 | **4 passed**. The server now runs as `procureflow_app`, and health still reports `ok`. |
| `npm audit --omit=dev --audit-level=high` | 0 | 0 vulnerabilities |
| `npm audit` (full tree) | 1 | unchanged from Phase 1: 4 moderate + 5 high, all from GHSA-vfj7-8cjw-p6xm (`braces`) and GHSA-67mh-4wv8-2f99 (`esbuild`) in dev tooling (accepted in the Phase 1 report) |
| fallback secret pattern scan over committable files | — | hits only in `.env.example` (placeholders), `ci.yml` (throwaway), `scripts/db-local.ts` (template), two test files (fake URLs) |
| real-password scan: all 3 generated local passwords (owner, app, superuser) via `grep -qF` over every committable file | — | **0 of 103** files |
| `gitleaks`, `actionlint` | — | **BLOCKED**: not installed |

### Acceptance criteria

| ID | Result | Evidence |
| --- | --- | --- |
| P2-AC1 money and pricing | **PASS** | `tests/unit/pricing.test.ts`: table cases (`0.1×3`, half-up `2.345→2.35` / `2.344→2.34`, scale 0 IDR and scale 2, tax per line incl. `12.5%` on `99.99 → 12.50`, rounded-line sums `0.3333×3 → 0.99`, `AMOUNT_TOO_LARGE` for line and for document totals ≥ 10^16). Two **property tests (3,000 random documents)** compared against an independent BigInt oracle. `tests/unit/decimal.test.ts`: input schemas reject floats, signs, exponents, and over-precision. |
| P2-AC2 numeric round trip | **PASS** | `tests/integration/numeric.test.ts`: `'12345678901234.5678'` in and out unchanged as a string; `'0.1' → '0.1000'`; `9999999999999999.9999` accepted; `10^16` rejected (22003). Drizzle type is `string` (`tests/unit/drizzle-api.test.ts`). |
| P2-AC3 roles and append-only audit | **PASS** | `tests/integration/audit.test.ts`: `current_user` is `procureflow_app` (non-superuser) vs `procureflow_owner`. The app role gets **42501** on UPDATE / DELETE / TRUNCATE / `DISABLE TRIGGER` / DROP of `audit_events` and on `CREATE TABLE`. The owner gets **PFA01** (trigger) on UPDATE / DELETE / TRUNCATE. A CHECK rejects a malformed action (23514). |
| P2-AC4 audit in the same transaction | **PASS** | `tests/integration/audit.test.ts` (through `runCommand`, as the app role): success leaves exactly 1 data row + 1 audit event with actor, request id, and `changes`. A crash, a business-rule failure, or a unique violation after the audit insert leaves neither row. |
| P2-AC5 runner order and errors | **PASS** | `tests/unit/runner.test.ts`: anonymous + bad input → `UNAUTHENTICATED`; no permission + bad input → `FORBIDDEN` (both before any transaction); unknown field → `VALIDATION_FAILED`; unexpected error → generic `INTERNAL`, logged with request id and command but **not** the input; SQLSTATE mapping table; retries for retry-safe commands only; strict-schema and name enforcement. `tests/integration/runner-db.test.ts`: timeouts are `5s` / `15s` inside and reset outside; queries are read-only (a write inside a query fails, nothing written). |
| P2-AC6 concurrency (CC-05, CC-07) | **PASS** | `tests/concurrency/document-numbers.test.ts`: **20 iterations × 50 parallel commands** → numbers 1–50, no duplicates or gaps. With every 5th transaction rolled back after allocating → committed numbers exactly 1–40. **Negative control:** a naive read-then-write allocator under the same load *does* produce duplicates, so the test can detect races. `tests/concurrency/lock-timeout.test.ts`: while another connection holds the row lock, the command returns `CONFLICT` after the 300 ms lock timeout, and its earlier insert and audit row are rolled back. After release, the retry succeeds with the next number. |
| P2-AC7 coverage ≥ 85% | **PASS** | `npm run test:coverage` with thresholds on `src/modules/*/{domain,application}/**` and `src/shared/{application,decimal}/**`: **143/143 lines (100%)** in scope. All of `src`: 243/259 lines (93.82%). Uncovered: `instrumentation*.ts`, `layout.tsx`, `page.tsx` (exercised only by E2E), table-declaration callbacks (run by drizzle-kit), and the unused `fail()` helper body. |
| P2-AC8 module-to-module boundaries | **PASS** | `tests/unit/eslint-rules.test.ts` (7 new cases, 18 total): a module may import `@/modules/audit` but not its internals (alias or relative path); a foundation module (`health`) may not depend on `audit` at all; `audit` may not depend on a peer; `src/shared` may not import modules; a module's own relative internals are allowed. |
| P2-AC9 definition of done | **PASS** | lint, typecheck, all tests, build, and E2E pass (table above); this report written; committed after maintainer approval (not pushed). |

### Decisions made during the phase

- **ADR 0013 (new):** roles are bootstrapped outside migrations, and migrations only grant per table. Found: roles are cluster-level, need `CREATEROLE`, and a password in a migration would be a committed secret. Also verified that identity inserts need **no** sequence grant, so `procureflow_app` has none.
- **ADR 0007 amendment:** an oversized total is `BUSINESS_RULE` / `AMOUNT_TOO_LARGE` (matching `docs/api-contracts.md`), not `VALIDATION_FAILED`. Document totals are checked too.
- **Runner design:** handlers are stored in a module-private `WeakMap`, so an operation object exposes no `handler` property (asserted by test). Inputs must be `z.strictObject` (enforced at definition time). Queries use `READ ONLY` transactions.
- **Audit-trigger SQLSTATE `PFA01`:** distinguishes "append-only violation" from a privilege error (42501). The runner maps it to `INTERNAL`, because it can only result from a programming error.
- **Table declaration files have no `server-only` import:** drizzle-kit loads them directly in plain Node.js, where `server-only` would throw. They contain no I/O.

### Files changed

New (35): `src/shared/{result,clock,ids,logger}.ts`, `src/shared/decimal/{decimal,pricing,format}.ts`, `src/shared/db/{tables,transaction,document-numbers}.ts`, `src/shared/application/{context,runner}.ts`, `src/modules/audit/{index.ts,domain/audit-event.ts,application/record-audit-event.ts,infrastructure/schema.ts,infrastructure/audit-repository.ts}`, `db/migrations/{0001_audit_events_and_document_sequences.sql,0002_audit_append_only_and_app_grants.sql,meta/0001_snapshot.json,meta/0002_snapshot.json}`, `scripts/{db-app-role.ts,lib/app-role.ts}`, `tests/unit/{decimal,pricing,clock-and-logger,audit-event,runner}.test.ts`, `tests/integration/{numeric,audit,runner-db}.test.ts`, `tests/concurrency/{document-numbers,lock-timeout}.test.ts`, `docs/adr/0013-database-role-bootstrap.md`, this report.

Modified (22): `docs/PLAN.md` (status line), `.env.example`, `.github/workflows/ci.yml` (app-role bootstrap step, new env vars, `test:coverage`), `package.json` (scripts `db:app-role`, `test:coverage`), `vitest.config.ts` (coverage thresholds), `db/migrations/meta/_journal.json`, `scripts/db-local.ts`, `src/server/schema.ts`, `src/shared/env.ts` (`readLogLevel`), `src/shared/db/client.ts` and `src/modules/health/infrastructure/ping-database.ts` (structured logger), `tests/support/{global-setup,test-db}.ts`, `tests/unit/eslint-rules.test.ts`, docs (`adr/README.md`, `adr/0003`, `adr/0007`, `api-contracts.md`, `architecture.md`, `development.md`, `schema.md`, `threat-model.md`).

Local only (gitignored, not part of any commit): `.env` (updated; backup in `.local/`), `.local/` (PostgreSQL data now includes `procureflow_app` and the migrated dev database).

### Known limitations / not verified

- **CI has never run** (no GitHub remote). The new CI steps (`npm run db:app-role`, `test:coverage`) are unverified. **gitleaks and actionlint: BLOCKED** (not installed).
- **Nothing calls the runner from HTTP yet.** Session-to-actor resolution, Server Actions, and request-id generation in `proxy.ts` are Phase 3. Until then `Permission` is a plain string.
- **The logger records PostgreSQL error messages** (≤ 500 characters). For some errors, such as invalid input syntax, these can contain a fragment of the rejected value. PostgreSQL `detail`, SQL text, and query parameters are never logged.
- **`Intl.NumberFormat` precision with string input is verified in Node.js only**, not yet in browsers (no money is displayed in the UI yet).
- **Document numbers take the year from the caller.** The organization timezone comes with org settings in Phase 3 (`businessYear()` is ready).
- **The schema owner can still disable the audit triggers** (DBA-level; ADR 0009 limit, unchanged).
- Dev-only `npm audit` advisories are unchanged (no upstream fix).
- Local PostgreSQL is still running, and still depends on the app-local VC++ runtime DLLs (Phase 1 report, failure 6).

### Threat-model updates

- Section 8: "app connects as `procureflow_app`; migrations as `procureflow_owner`" is now checked, with evidence. Deployment wiring remains Phase 10.
- R-02 (audit tampering through the app): mitigation implemented and verified (grants + triggers).
- I-03 (error leakage) and I-05 (secrets in logs): mitigations implemented and verified (runner `INTERNAL` mapping, logger allowlist).
- T-04 (races): document numbering verified, including the negative control.

### Next steps

1. Phase 3: authentication (Better Auth), users, roles and permissions, request context from the session, Server Actions through the runner, security headers. Decide the role list then (design `buyer` = "Procurement"; `finance` is in the design but not in the maintainer's list).
