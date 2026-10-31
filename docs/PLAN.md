# ProcureFlow implementation plan

- Status: **Phase 0 approved 2026-10-18. Phase 1 committed 2026-10-19 after maintainer review ([report](reports/phase-1.md)). Phase 2 committed 2026-10-21 after maintainer review ([report](reports/phase-2.md)). Phase 3 split into 3a (sign-in and identity) and 3b (administration) on 2026-10-21. Phase 3a committed 2026-10-21 after maintainer review ([report](reports/phase-3a.md)). Phase 3b committed 2026-10-22 after maintainer review ([report](reports/phase-3b.md)). Phase 4 committed 2026-10-22 after maintainer review ([report](reports/phase-4.md)). Phase 5 split into 5a and 5b on 2026-10-23. Phase 5a committed 2026-10-23 after maintainer review ([report](reports/phase-5a.md)). Phase 5b committed 2026-10-25 after maintainer review ([report](reports/phase-5b.md)). Phase 6 split into 6a and 6b on 2026-10-25. Phase 6a committed 2026-10-25 after maintainer review ([report](reports/phase-6a.md)). Form-state fix committed 2026-10-25 after maintainer review ([report](reports/fix-form-state.md)). Phase 6b committed 2026-10-26 after maintainer review ([report](reports/phase-6b.md)). Phase 7 committed 2026-10-26 at the maintainer's request; its 13 decisions accepted by the maintainer the same day ([report](reports/phase-7.md)). Phase 8 committed 2026-10-27 after the maintainer approved its plan and the commit ([report](reports/phase-8.md)). Phase 9 committed 2026-10-28 after the maintainer approved its plan and the commit ([report](reports/phase-9.md)). Phase 10 committed and tagged v0.1.0 on 2026-10-30 after the maintainer approved its plan and the commit ([report](reports/phase-10.md)).**
- Plan date: 2026-10-18
- Inputs: [architecture](architecture.md), [ADRs](adr/README.md), [user stories](user-stories.md), [state machines](state-machines.md), [schema](schema.md), [API contracts](api-contracts.md), [threat model](threat-model.md)

## How phases work

1. Phases run **in order**. Each one ends at a **gate**: every acceptance criterion is verified by execution or direct inspection, and the phase report is written and reviewed by the maintainer. Then the next phase starts.
2. A phase may revise an earlier design doc or ADR. That revision is part of the phase diff and is called out in the report. ADRs are superseded, never silently edited.
3. Nothing is reported as working unless it was run. Anything not run is listed under "Not verified" in the report.

### Definition of done (applies to every phase from 1 on)

- `npm run lint`, `npm run typecheck`, `npm test` (unit + integration + concurrency, if present), and `npm run build` all exit 0. E2E (`npm run test:e2e`) exits 0 from Phase 3 on.
- Every new command has tests for: success, `UNAUTHENTICATED`, `FORBIDDEN` (each disallowed role), `VALIDATION_FAILED` (including a tampered or unknown field), `INVALID_TRANSITION` (each disallowed source state), each `BUSINESS_RULE` it can raise, and its audit event.
- Every new query has a cross-user visibility test (no IDOR).
- `npm audit --audit-level=high` reports nothing, or each finding is written up with a decision. `gitleaks` finds no secrets.
- Migrations are generated, reviewed, committed, and applied from scratch on an empty database in tests.
- Seed data is fictional (`example.com` emails, invented names).
- Docs updated: threat model rows, state machine or schema changes, and the ADR if a decision changed.

### Phase report template (`docs/reports/phase-N.md`)

```
## Phase N report: <title>
Date / commit:
### Commands run (exact) and results
| Command | Exit | Summary (tests passed/failed/skipped, warnings) |
### Acceptance criteria
| ID | Result (pass / fail / not verified) | Evidence (test name, output excerpt, file:line) |
### Failures and how they were resolved (or not)
### Files changed
### Dependency changes (name, version, verified date, why)
### Known limitations / not verified
### Threat-model updates
### Next steps
```

---

## Phase 0: Inspection and architecture (this phase)

**Delivered:** this repository with design docs and ADRs 0001–0011. No code.

| ID | Acceptance criterion | Status |
| --- | --- | --- |
| P0-AC1 | Repository inspected and kept separate from employer code (ADR 0001) | Done: new repo `Documents/ProcureFlow` |
| P0-AC2 | Current versions and compatibility checked against official sources and recorded with date | Done: ADR 0011 (2026-10-18) |
| P0-AC3 | User stories, state machines, schema, API contracts, threat model, ADRs written | Done: `docs/` |
| P0-AC4 | Phased plan with verifiable acceptance criteria | Done: this file |
| P0-AC5 | Maintainer reviews and approves the plan and settles the [open decisions](#decisions) | Done: approved 2026-10-18; D1–D4 and D6 decided, D5 deferred |

**Gate:** P0-AC5.

---

## Phase 1: Toolchain, scaffold, local database, CI skeleton

**Goal:** an empty but correctly wired app with every check in place, so later phases only add features.

Scope:
- Re-check versions (`npm view`) and install the exact pins from ADR 0011. Next.js 16.4.x, React 19.3.x, TypeScript 6.0.x, ESLint 10 + `eslint-config-next`, Vitest 5, Playwright 1.64, Zod 4, Drizzle 0.45 + drizzle-kit 0.31, `pg` 8, `server-only`, `decimal.js`, `fast-check`.
- `tsconfig` strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). Folder layout from ADR 0002.
- ESLint flat config with: the module boundary rules (architecture.md), a ban on `sql.raw` outside `db/`, a ban on `dangerouslySetInnerHTML`, a ban on numeric `mode: 'number'` in Drizzle schemas, and a ban on `process.env` outside `src/shared/env.ts`.
- `src/shared/env.ts`: Zod-validated environment. The app refuses to start without required variables.
- **Local PostgreSQL 18 (portable):** `scripts/db-local.ps1` (Windows) with `init`, `start`, `stop`, and `status`. Binaries live in `.local/pgsql`, data in `.local/pgdata`, listening on `127.0.0.1:54318`. **Downloading the EDB zip requires the maintainer's explicit approval at that moment** (file name, source URL, size, and checksum stated first).
- Drizzle config, empty initial migration, `db:migrate` script, and a test-database helper (template clone per test file, ADR 0011).
- `GET /api/health`: runs `select 1` against the database. Returns 200 with `{db: 'ok'}` or 503. No version or secret leakage.
- Vitest projects (`unit`, `integration`) and Playwright config (Chromium) with one smoke test (home page renders, health returns 200).
- `.github/workflows/ci.yml` (jobs per ADR 0011), Dependabot config, `.env.example`, `.gitignore`, a `gitleaks` script.
- Confirm or deny the open technical questions: `uuidv7()` in PG 18, Drizzle `.for('update')` API, `numeric` default TypeScript type.

| ID | Acceptance criterion | Verified by |
| --- | --- | --- |
| P1-AC1 | `npm ci` succeeds from a clean clone. Installed versions match the pins (report lists `npm ls --depth=0`). | command output |
| P1-AC2 | `npm run lint`, `typecheck`, `test`, `build` exit 0 | command output |
| P1-AC3 | Boundary rule works: a fixture file importing another module's `infrastructure/` fails lint (asserted by a test using the ESLint Node API) | unit test |
| P1-AC4 | Importing a `server-only` module from a `'use client'` file fails `next build` (proven once by a temporary fixture, result recorded, fixture removed) | build output in report |
| P1-AC5 | `db-local start` runs PostgreSQL 18.x bound to 127.0.0.1. Integration test asserts `server_version_num >= 180000`, that `uuidv7()` returns a v7 UUID, and that a serializable Drizzle transaction commits. | integration test |
| P1-AC6 | Starting the app without `DATABASE_URL` fails fast with a clear message and no secret echo | E2E test that spawns `next start` (`tests/e2e/startup-config.spec.ts`) |
| P1-AC7 | `/api/health` returns 200 with the DB up and 503 with it stopped | integration + E2E smoke |
| P1-AC8 | `gitleaks` finds no secrets. `npm audit --audit-level=high` is clean or every finding is triaged in the report. | command output |
| P1-AC9 | CI workflow passes `actionlint`, if available locally. **Actually running it in GitHub Actions is "not verified" until a remote exists.** | report |

**Gate:** all of P1-AC1 to AC8 pass. AC9 is reported honestly.

---

## Phase 2: Shared kernel, database roles, audit trail, command runner

Scope:
- `shared/decimal`: `Money`, `Quantity`, and `pricing.ts` (ADR 0007). `shared/result` and error codes (ADR 0010). `shared/clock`. `shared/ids`.
- Database bootstrap migration: roles `procureflow_owner` and `procureflow_app`, grants, and `document_sequences` with an allocation function.
- `audit` module: `audit_events` table, append-only triggers, the writer (in-transaction), and the redaction allowlist mechanism.
- `runCommand` / `runQuery` with auth, permission, and validation stubs (real auth arrives in Phase 3), transaction with `lock_timeout` and `statement_timeout`, error mapping, request-id propagation, and the structured logger with redaction.

| ID | Acceptance criterion | Verified by |
| --- | --- | --- |
| P2-AC1 | Pricing table tests pass: `0.1×3`, half-up boundaries, 0- and 2-scale currencies, max magnitudes, `AMOUNT_TOO_LARGE`. Property test: document total = sum of rounded lines. | unit |
| P2-AC2 | `numeric(20,4)` round-trips `'12345678901234.5678'` exactly. Drizzle's inferred type for numeric columns is `string` (type-level test). | integration + `tsc` |
| P2-AC3 | As `procureflow_app`: UPDATE, DELETE, and TRUNCATE on `audit_events` fail. As the owner: triggers reject the same. | integration |
| P2-AC4 | A command that throws after writing an audit row leaves no audit row and no data change. A successful one leaves exactly its rows. | integration |
| P2-AC5 | Runner order: anonymous with bad input gets `UNAUTHENTICATED`; forbidden with bad input gets `FORBIDDEN`; an unknown thrown error gets `INTERNAL` with a generic message, and the log line carries the request id and no input body | unit |
| P2-AC6 | CC-05: 50 parallel sequence allocations give 50 distinct consecutive numbers. CC-07: lock timeout maps to `CONFLICT` with no partial writes. | concurrency |
| P2-AC7 | `domain/` + `application/` line coverage ≥ 85% (reported) | coverage output |

---

## Phase 3: Authentication, users, roles, authorization

> **Split on 2026-10-21 (maintainer decision).**
> - **3a: sign-in and identity.** Acceptance criteria P3a-AC1 to AC12 are in [reports/phase-3a.md](reports/phase-3a.md).
> - **3b: administration screens.** Users, roles, and departments, covering P3-AC4/AC5/AC6/AC7/AC8/AC10/AC11 below for the admin commands. Acceptance criteria P3b-AC1 to AC14 are in [reports/phase-3b.md](reports/phase-3b.md).
>
> **Org settings moved out of Phase 3 (maintainer decision, 2026-10-22).** Each `org_settings` field ships with the phase whose behavior it controls, so no setting exists before it has an effect: org name, timezone, and currency (with its lock) in Phase 5; RFQ threshold and minimum quotes in Phase 6; PO approval threshold and price tolerance in Phase 7; over-receipt tolerance in Phase 8.
>
> The role `buyer` is now `procurement` (ADR 0014).

Scope: Better Auth (email/password, sign-up disabled, DB sessions, DB rate limiting, `nextCookies`); `user_profiles`; departments; `role_assignments`; code-defined role → permission map; request context; `proxy.ts` optimistic redirect; sign-in and sign-out UI; admin screens for users, roles, and departments (org settings moved to Phases 5–8, see above); bootstrap-admin CLI; fictional seed script; security headers and CSP; choice of accessible UI component approach.

| ID | Acceptance criterion | Verified by |
| --- | --- | --- |
| P3-AC1 | US-ID-01: sign-in works. Wrong password gives a generic error. After N failures, `429`. Sign-up endpoint rejected. | integration + E2E |
| P3-AC2 | Session cookie flags `HttpOnly`, `SameSite=Lax`, and `Secure` under the production config | E2E (cookie inspection) |
| P3-AC3 | US-ID-02: after sign-out, replaying the old cookie is rejected | E2E |
| P3-AC4 | US-ID-03: deactivating a user revokes their sessions. Their next request is rejected. | integration |
| P3-AC5 | **Permission matrix test:** every registered command and query × every role × anonymous gives exactly the allow/deny in ADR 0006 | unit/integration (table-driven) |
| P3-AC6 | Every protected page redirects anonymous users to sign-in. A direct POST to a protected Server Action without a session gets `UNAUTHENTICATED` (no page-level reliance). | E2E + integration |
| P3-AC7 | SOD-05: self role change and self deactivation rejected. `LAST_ADMIN` enforced. DB CHECK backstop proven. | integration |
| P3-AC8 | Cross-origin POST to a Server Action is rejected | E2E/integration |
| P3-AC9 | Security headers present on HTML responses (list in threat-model section 8) | E2E |
| P3-AC10 | Seed script creates only fictional data (review recorded in the report). Role changes, logins, login failures, and logouts produce audit events. | integration + review |
| P3-AC11 | No DTO returned to the client contains password hashes, session tokens, or unlisted fields (allowlist test) | unit |

---

## Phase 4: Suppliers

Scope: supplier commands and queries, maker-checker review, block/unblock, deactivate/reactivate, list and search UI.

> The six criteria below were expanded into P4-AC1 to AC13 when the phase was planned (2026-10-22); they are listed with evidence in [reports/phase-4.md](reports/phase-4.md). Decision: duplicate detection ignores punctuation in names and separators in tax IDs.

| ID | Acceptance criterion | Verified by |
| --- | --- | --- |
| P4-AC1 | SUP-T01 to T09 implemented. Every unlisted (state, command) pair returns `INVALID_TRANSITION` (exhaustive domain test). | unit |
| P4-AC2 | SOD-03: the creator, or the last identity changer, cannot activate (`MAKER_CHECKER`), even when holding `finance` | integration |
| P4-AC3 | Changing `legal_name` or `tax_id` on an active supplier moves it to `pending_review` | integration |
| P4-AC4 | Duplicate normalized name or tax ID rejected, including two concurrent creates with the same tax ID (exactly one succeeds) | integration + concurrency |
| P4-AC5 | `supplier.selectableForPurchasing` returns only active suppliers | integration |
| P4-AC6 | Search filters are injection-safe (`'; drop table` strings treated literally) | integration |

---

## Phase 5: Purchase requisitions and multi-step approvals

> **Split on 2026-10-23 (maintainer decision).**
> - **5a: organization settings, approval policies (with an editor screen), requisition drafting.** P5-AC2, P5-AC3, P5-AC10, and the table half of P5-AC1; criteria P5a-AC1 to AC12 in [reports/phase-5a.md](reports/phase-5a.md).
> - **5b: submission and approvals.** P5-AC1 (commands), P5-AC4 to AC9, P5-AC11: submit and frozen routes, approval requests and steps, inbox, decide, history, SOD-01 trigger, SOD-02 index, CC-01, CC-02, the E2E golden path. Criteria P5b-AC1 to AC14 in [reports/phase-5b.md](reports/phase-5b.md) (approved 2026-10-25).

Scope: requisitions module; approval policies (publish, resolve); approvals module (requests, steps, eligibility, decide, outcome handler port); approval inbox; PR UI (create, edit, submit, cancel, detail with history); SOD-01 trigger and SOD-02 index; `org_settings` with org name, timezone, and currency, and the currency lock once a monetary document exists (moved from Phase 3, 2026-10-22).

| ID | Acceptance criterion | Verified by |
| --- | --- | --- |
| P5-AC1 | PR-T01 to T10 and AP-T01 to T05 implemented. Exhaustive invalid-transition tests for both machines. | unit |
| P5-AC2 | Totals computed server-side. A tampered `estimatedTotal` or `lineTotal` in input is rejected. Department comes from the profile. | integration |
| P5-AC3 | Policy resolution: department rule beats generic rule. Band boundaries `[min, max)` tested at exact edges. Overlapping or gapped policies rejected on publish. | unit + integration |
| P5-AC4 | `NO_APPROVAL_ROUTE` blocks submission. A PR is never auto-approved. | integration |
| P5-AC5 | SOD-01: the requester holding `approver` for their own department cannot decide (`SELF_APPROVAL`). A direct SQL update as the app role is also rejected by the trigger. | integration |
| P5-AC6 | SOD-02: the same user cannot decide two steps of one round (`DUPLICATE_APPROVER`). The unique index is proven. | integration |
| P5-AC7 | Multi-step flow: 3-step policy approves only after step 3. Reject at step 2 cancels step 3. Return resets and resubmission starts round 2 at step 1 with a new snapshot. | integration |
| P5-AC8 | Policy published after submission does not change in-flight steps | integration |
| P5-AC9 | CC-01 (concurrent decisions on one step) and CC-02 (edit vs submit race) pass 20 iterations each | concurrency |
| P5-AC10 | Visibility: requester sees own, approver sees scoped departments, buyer/finance/auditor see all. Others' PR by id → `NOT_FOUND`. | integration |
| P5-AC11 | E2E golden path: Rina creates and submits, Bayu approves step 1, Sari approves step 2, PR shows `approved` with full history | E2E |

---

## Phase 6: Sourcing (RFQ, quotations, award)

> **Split on 2026-10-25 (maintainer decision).**
> - **6a: the RFQ lifecycle.** Create from an approved requisition, edit, invite suppliers, issue, close, cancel; new read permission `rfq.read`; a requisition line on at most one RFQ that is not cancelled. Criteria P6a-AC1 to AC10 in [reports/phase-6a.md](reports/phase-6a.md).
> - **6b: quotations, comparison, award.** P6-AC1 (quotation machine and award), P6-AC2 to AC5, and the settings `rfq_required_above` and `min_quotes`, which ship with the award rule that uses them. A quotation covers every RFQ line. Criteria P6b-AC1 to AC12 in [reports/phase-6b.md](reports/phase-6b.md). Maintainer decisions (2026-10-25): a quotation after the due time is accepted and marked late; only valid quotations (submitted, not expired, supplier active) count towards the minimum and the lowest price; closing an RFQ discards the drafts nobody submitted.

Also adds the `org_settings` fields `rfq_required_above` and `min_quotes`, with their admin screen (moved from Phase 3).

| ID | Acceptance criterion | Verified by |
| --- | --- | --- |
| P6-AC1 | RFQ-T01 to T06 and QUO-T01 to T05 implemented, with exhaustive invalid-transition tests | unit |
| P6-AC2 | Only invited and active suppliers can quote (FK + rule). One live quotation per supplier per RFQ, also under concurrency. | integration + concurrency |
| P6-AC3 | Comparison matrix computed server-side. The lowest-valid flag ignores expired and withdrawn quotations. | unit + integration |
| P6-AC4 | Justification required for fewer than `min_quotes` above the threshold, and for non-lowest awards. Justification text is audited. | integration |
| P6-AC5 | Expired quotation cannot be awarded (`QUOTATION_EXPIRED`) | integration |

---

## Phase 7: Purchase orders

> **Implemented 2026-10-26** (maintainer: "lanjut mulai implementasi nya", without a separate plan stop). Criteria P7-AC1 to AC14 and the decisions taken are in [reports/phase-7.md](reports/phase-7.md); the maintainer accepted all 13 decisions on 2026-10-26. Changes to this plan: `over_receipt_tolerance_pct` moves here from Phase 8 (PO-T05 needs it); `po.receivable` moves to Phase 8; ADR 0006 gains `po.read.department` for approvers.

Also adds the `org_settings` fields `po_approval_threshold` and `po_price_tolerance_pct`, with their admin screen (moved from Phase 3).

| ID | Acceptance criterion | Verified by |
| --- | --- | --- |
| P7-AC1 | PO-T01 to T09 implemented, with exhaustive invalid-transition tests | unit |
| P7-AC2 | Quantity reservation: `OVER_ORDER` when exceeding remaining PR line quantity. Release on cancel, reject, and close is correct. PO-I1 holds after every test. | integration |
| P7-AC3 | CC-03: N concurrent POs on one PR line never over-order. CC-06: idempotent create. | concurrency |
| P7-AC4 | `RFQ_REQUIRED` above threshold. With a quotation, unit prices come from it (client prices ignored, proven by test). | integration |
| P7-AC5 | Approval requirement computed correctly for amount threshold and price variance (edge values). Below threshold → `approved` with audited reason `BELOW_THRESHOLD`. | unit + integration |
| P7-AC6 | SOD-01 and SOD-06 on PO approval (creator and awarding buyer excluded), app + trigger | integration |
| P7-AC7 | Issue snapshots `max_receivable_qty` with tolerance (floor to 3 dp). Issued PO lines immutable. | integration |
| P7-AC8 | Tax and total computation matches ADR 0007 (table tests with tax rates 0, 11, and 12.5%) | unit |
| P7-AC9 | Print view renders only for users who can read the PO | E2E |

---

## Phase 8: Goods receipts

> **Implemented 2026-10-27** (the maintainer approved the plan and its decisions 1 to 8 before implementation). Criteria P8-AC1 to AC11 and the decisions are in [reports/phase-8.md](reports/phase-8.md). Changes to this plan: `po.receivable` and the new query `receipt.formOptions` need `receipt.create`; a new business rule `PO_NOT_RECEIVABLE`; cancelling an order with anything received answers `RECEIPTS_EXIST` before the transition check.

The `org_settings` field `over_receipt_tolerance_pct` and its admin screen arrived in Phase 7 (issuing a PO fixes the receivable quantities with it). Phase 8 adds `po.receivable` and the receipt-driven PO statuses (PO-T06), which the Phase 7 trigger still refuses.

| ID | Acceptance criterion | Verified by |
| --- | --- | --- |
| P8-AC1 | GR-T01 to T04 implemented, with exhaustive invalid-transition tests | unit |
| P8-AC2 | `OVER_RECEIPT` rejects the whole receipt and names the lines. DB CHECK backstop proven by a direct SQL attempt as the app role. | integration |
| P8-AC3 | **CC-04:** N concurrent postings on the last units never exceed `max_receivable_qty`. GR-I1 holds after every iteration (20+). | concurrency |
| P8-AC4 | SOD-04: the PO creator cannot create or post a receipt (`ORDER_RECEIVE_CONFLICT`) | integration |
| P8-AC5 | PO status derivation (issued, partially received, received) correct after posts and reversals | integration |
| P8-AC6 | Reversal creates a new document, decrements counters, can happen only once (also under concurrency), and is blocked on closed POs | integration + concurrency |
| P8-AC7 | E2E golden path: PR → approvals → PO (issued) → partial receipt → final receipt → PO `received` | E2E |

---

## Phase 9: Audit trail UI and reporting

> **Implemented 2026-10-28** (the maintainer approved the plan and its decisions 1 to 9 before implementation). Criteria P9-AC1 to AC10 and the decisions are in [reports/phase-9.md](reports/phase-9.md). Changes to this plan: no `audit.entityHistory` query (each document's get query embeds its history); a new query `audit.filterOptions`; `asOf` is the application clock, not the database `now()`.

| ID | Acceptance criterion | Verified by |
| --- | --- | --- |
| P9-AC1 | Audit search (filters, cursor pagination) visible only to `audit.read`. Entity history shown only to users who can see the entity. | integration + E2E |
| P9-AC2 | Every report is a live SQL view or query. A fixture dataset with independently hand-computed expected values matches exactly (string-equal decimals). | integration |
| P9-AC3 | Empty ranges return empty results and the UI shows an explicit empty state. A grep check confirms no literal metric values in report components. | integration + E2E + review |
| P9-AC4 | `asOf` present on every report response | integration |
| P9-AC5 | CSV export prevents formula injection (unit test with `=`, `+`, `-`, `@`, TAB, CR prefixes) and respects report permissions | unit + integration |
| P9-AC6 | Potential-split-purchases report finds the seeded split case and no false positive in the control case | integration |

---

## Phase 10: Hardening, deployment documentation, release v0.1.0

> **Implemented 2026-10-30** (the maintainer approved the plan and its decisions 1 to 9 before implementation). Criteria P10-AC1 to AC9, the decisions, and the threat-model review are in [reports/phase-10.md](reports/phase-10.md). TOTP 2FA and row-level security were deferred; the hash-chained audit export was built; a new optional setting `TRUSTED_PROXIES` fulfils ADR 0014.

Scope: threat-model review against the code; dependency and secret audit; optional TOTP 2FA (required for admins if adopted); optional PostgreSQL RLS as a second layer; optional hash-chained audit export; backup/restore and audit-archival procedures; deployment guide (standalone build, environment, roles, migration job, reverse proxy, health checks, multi-instance key); operations runbook; `CHANGELOG`; tag v0.1.0.

| ID | Acceptance criterion | Verified by |
| --- | --- | --- |
| P10-AC1 | Every threat-model row maps to a passing test, or is marked accepted with a rationale | review table in report |
| P10-AC2 | A fresh deployment by following `docs/deployment.md` literally on a clean machine (or clean VM) reaches a working sign-in, with every step's output recorded | execution log |
| P10-AC3 | Backup → drop → restore drill restores data and audit rows exactly (row counts and checksums compared) | execution log |
| P10-AC4 | Full suite (lint, typecheck, unit, integration, concurrency, E2E, build, audit, gitleaks) green locally, **and in CI if a remote exists** | command output / CI link |

---

## Roadmap after v0.1.0

Agreed with the maintainer on 2026-10-31, in this order:

1. **Done 2026-10-31. GitHub:** private remote, CI run (D5).
2. **Done 2026-10-31. Vercel + Neon demo (D7):** live with fictional data at https://procurement-smart.vercel.app; a demo sign-in was confirmed by the maintainer (moved ahead of the manual test at the maintainer's choice).
3. **Manual test** by the maintainer, online: one full purchase through the demo accounts.
4. **v0.1.1:** fixes from that test, and the open review items of Phases 8 to 10.
5. **v0.2.0: Dashboard.** It was in the original brief and was not built; the home page shows only the user's access. Real figures per role.
6. **Portfolio:** screenshots, README summary, demo video.

## Optional later phases (not scheduled)

REST `/api/v1` + OpenAPI (ADR 0010); email notifications; attachments (needs malware scanning and content-type validation design); supplier portal; invoices and three-way match; budgets; multi-currency; SSO/OIDC; Drizzle 1.0 migration; TypeScript 7 once typescript-eslint supports it.

## Decisions

Settled by the maintainer on 2026-10-18 unless marked open.

| # | Question | Decision |
| --- | --- | --- |
| D1 | License | **Apache-2.0** (`LICENSE`, official text from apache.org, SHA-256 `cfc7749b…3d30`) |
| D2 | Copyright holder | **"ProcureFlow contributors"** (`NOTICE`) |
| D3 | Default currency for seed data and demos | **USD (scale 2).** Tests also cover a 0-scale currency (IDR). |
| D4 | UI language for v1 | **English**, with strings externalized for later translation |
| D5 | GitHub remote (needed to run CI and for P1-AC9 / P10-AC4) | **Private repository** `sahrultahta/Procurement-Smart` (2026-10-31). `main` and `v0.1.0` pushed; the maintainer reported the first CI run green on GitHub Actions. |
| D6 | Git author identity | Repo-local `Sahrul Tahta <sahrul.onederland@gmail.com>`. Never use the HRGA team address. |
| D7 | Hosting of the public demo | **Vercel with Neon PostgreSQL** (maintainer, 2026-10-31). The original brief named Vercel; v0.1.0 was documented for self-hosting and has not been tried there. Neon: PostgreSQL 18 is generally available, and the migrations need it (`uuidv7()`). Supabase's PostgreSQL 18 status could not be confirmed. Better Auth stays. Demo data is fictional only. Live since 2026-10-31 (docs/deployment.md, "Vercel with Neon"). |

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Portable PostgreSQL blocked by corporate endpoint policy on this machine | Integration and concurrency tests can't run locally | Fall back to the official installer or Docker (ADR 0003). CI still runs them once a remote exists. |
| Better Auth API differs from docs for the installed version (e.g. sign-up disabling, rate-limit storage) | Phase 3 rework | Verify each assumption with a test first. Pin the version. |
| Drizzle 0.x → 1.0 migration | Later rework | Isolated in `infrastructure/`. Planned as its own phase. |
| Scope creep (notifications, attachments, invoices) | Delay, untested surface | Explicit out-of-scope list. Each addition needs a story, threat-model update, and phase. |
| Next.js minor upgrades changing Server Action or proxy behavior | Security regressions | Pinned versions. The permission-matrix and CSRF tests run on every upgrade. |
