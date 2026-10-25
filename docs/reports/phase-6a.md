## Phase 6a report: RFQ lifecycle

- Date: 2026-10-25
- Base commit: `7a75b14` (Phase 5b). Phase 6a is committed as a single commit on top of it (2026-10-25, after maintainer approval), together with this report. Not pushed: there is no remote.
- Machine: Windows 10 Enterprise 19045, Node 24.21.0, npm 11.19.0, local PostgreSQL 18.6, Microsoft Edge (Playwright `msedge` channel)
- Maintainer decisions (2026-10-25):
  1. **Phase 6 is split** into 6a (this report: the RFQ lifecycle) and 6b (quotations, comparison, award, and the settings `rfq_required_above` and `min_quotes`, which ship with the award rule that uses them).
  2. **New permission `rfq.read`** for procurement, finance, and auditor (ADR 0006 amendment).
  3. **A requisition line can be on at most one RFQ that is not cancelled.**
  4. **A quotation must cover every RFQ line** (as designed; affects 6b).
  5. The plan with P6a-AC1 to AC10 was approved as presented.
  6. Commit Phase 6a as one commit, without ignored files; do not push.

Status vocabulary: **Implemented**, **Tested**, **Verified** (run here, output observed). Nothing is **Deployed**.

### What Phase 6a adds (all implemented, tested, verified locally)

| Area | Where |
| --- | --- |
| Sourcing module: RFQ state machine (RFQ-T01 to T06; the award command is 6b), create, update, issue, close, cancel; list, detail, and the form's options | `src/modules/sourcing/**` |
| Requisitions: the approved lines with what is left to order (locked or unlocked), headers for display | `src/modules/requisitions/application/sourcing.ts` |
| Suppliers: lookups by id and the active list for other modules | `src/modules/suppliers/application/directory.ts` |
| Organization: local date-times in the org time zone (`instantOfLocalDateTime`, `localDateTimeIn`), including daylight-saving gaps and repeats | `src/modules/organization/domain/settings.ts` |
| Permission `rfq.read` (procurement, finance, auditor) | `src/modules/identity/domain/roles.ts`, ADR 0006 amendment |
| Tables `rfqs`, `rfq_lines`, `rfq_suppliers`; grants; triggers `rfqs_guard`, `rfq_lines_guard`, `rfq_suppliers_guard` (`PFB01`) | `db/migrations/0012` (generated), `0013` (hand-written) |
| Module graph: `sourcing → organization` (for the time zone) | `eslint.config.mjs`, `docs/architecture.md` |
| Screens: **RFQs** list and nav link; RFQ detail with issue, close, cancel; new and edit forms (lines with quantities, active suppliers, due time); on an approved requisition, its RFQs and **Request quotations** | `src/app/(app)/rfqs/**`, `src/app/(app)/requisitions/[id]/page.tsx` |
| Seed: *Office chairs for Operations*, approved by Bayu, with an RFQ Dewi issued to the two approved suppliers | `scripts/seed.ts` |

Decisions taken within the approved scope (please review):
1. **Due time** is entered as a local date and time in the org time zone (an HTML `datetime-local` field) and stored as an instant. A time skipped by a daylight-saving change is refused; a repeated time means the earlier one.
2. **New business-rule codes:** `REQUISITION_NOT_APPROVED`, `QUANTITY_EXCEEDS_REMAINING`, `LINE_ALREADY_IN_RFQ`, `NO_SUPPLIERS_INVITED`, `RESPONSE_DUE_IN_PAST`.
3. **Issuing re-checks** that the requisition is still approved and every invited supplier still active. A requisition cancelled while an RFQ is a draft is not blocked, but the RFQ can no longer be issued; the RFQ page says so.
4. **"Not cancelled" includes awarded** (6b): once quotations are awarded, the lines stay sourced.
5. **An RFQ may be saved without suppliers** as a draft; issuing needs at least one.
6. **Form options query** `rfq.sourcingOptions` (procurement): the requisition's lines with what is left and where each is already sourced, plus the active suppliers.

### Commands run (exact) and results

Three full runs of `scratchpad/verify6a/run.sh` on 2026-10-25 (from `npm ci`), with `NEXT_TELEMETRY_DISABLED=1`; the first two failed (see "Failures"), the third is the result below.

| Command | Exit | Result |
| --- | --- | --- |
| `npx drizzle-kit generate --name=rfqs` | 0 | `0012`: 3 tables, CHECKs, FKs, indexes (reviewed; additive only) |
| `npx drizzle-kit generate --custom --name=rfqs_guards_and_grants` | 0 | `0013`: grants, 3 trigger functions (hand-written) |
| `npm run db:migrate` | 0 | applied to `procureflow_dev`; no-op in the final run |
| `npm run seed` (twice) | 0 / 0 | 1st: 1 requisition approved, 1 RFQ created and issued. 2nd: nothing created (idempotent) |
| `git diff --stat HEAD -- package.json package-lock.json` | 0 | empty: **no dependency changes** |
| `npm ci` | 0 | 597 packages from the lockfile |
| `npm run lint` | 0 | no findings (module boundaries included) |
| `npm run typecheck` | 0 | no errors |
| `npm run test:unit` | 0 | 15 files, **522 passed** (was 485): RFQ machine and local times 30, role matrix +7 cells |
| `npm run test:integration` | 0 | 21 files, **242 passed** (was 216): RFQs 17, concurrency 1, permission matrix +8 operations |
| `npx vitest run --coverage` | 0 | **764 passed**. Thresholds met. Domain/application scope **1066/1070 lines (99.63 %)**; every new sourcing file 100 % of lines |
| `rm -rf .next && npm run build` | 0 | **0 warnings**; new routes `/rfqs`, `/rfqs/new`, `/rfqs/[id]`, `/rfqs/[id]/edit` |
| `npx playwright test` (twice, back to back) | 0 / 0 | **33 passed** both times (31 earlier + 2 new) |
| 12 mutation checks (below), before and after the last test changes | — | all **killed** both times; originals restored byte for byte, `git diff --stat` identical before and after |
| `npm audit --omit=dev --audit-level=high` | 0 | 0 high/critical; the same 4 moderate (`esbuild` via `drizzle-kit`) |
| `npm audit` (full) | 1 | the same 4 moderate; exit 1 because npm fails on any finding |
| secret scan: 18 distinct local secrets over all 315 committable files | — | **0 hits** |
| relative-link check over `README.md` and `docs/**/*.md` | — | 0 broken |
| `gitleaks`, `actionlint` | — | **BLOCKED** (not installed) |

### Acceptance criteria

| ID | Status | Evidence |
| --- | --- | --- |
| P6a-AC1 RFQ machine | **PASS** | `tests/unit/rfq-domain.test.ts`: all 25 (status × command) pairs against a table written from docs/state-machines.md §4; awarded and cancelled are terminal; only cancelled RFQs free their lines. Local times: UTC, Jakarta, Kolkata, Kiritimati (across the date line), New York (skipped 02:30 refused, repeated 01:30 the earlier instant), Lord Howe (30-minute shift), malformed and impossible values refused. |
| P6a-AC2 create | **PASS** | `tests/integration/rfqs.test.ts`: lines copy description and unit; numbers `RFQ-YYYY-NNNNNN` consecutive; invitations; audit `rfq.created` with lines and due time; form options show where each line is sourced. Due time read in Asia/Jakarta (`17:00` → `10:00Z`), New York's skipped hour refused on `responseDueAt`. `REQUISITION_NOT_APPROVED` for draft and pending; `NOT_FOUND`; `QUANTITY_EXCEEDS_REMAINING` with `details`, also after an ordered quantity; another requisition's line on `lines.0.requisitionLineId`; a line twice; bad quantities; `LINE_ALREADY_IN_RFQ` naming the other RFQ, while another line of the same requisition is fine; `SUPPLIER_NOT_ACTIVE` (pending, unknown); a supplier twice; status, number, creator, issue time, description, unit, a UTC time, and an impossible date refused with nothing written; an idempotency key replays, and a different input with it is `IDEMPOTENCY_KEY_REUSED`. |
| P6a-AC3 update | **PASS** | title, due time, lines (reordered), invitations replaced; a kept invitation keeps its time; audit lists exactly the changed fields; the same values with invitations in another order write nothing; stale version `CONFLICT`; its own lines are not "on another RFQ"; the create rules apply; after issue `INVALID_TRANSITION`. |
| P6a-AC4 issue | **PASS** | `NO_SUPPLIERS_INVITED`; `RESPONSE_DUE_IN_PAST` at the due minute, fine one minute before; a supplier blocked after being invited → `SUPPLIER_NOT_ACTIVE` naming it; a requisition withdrawn after drafting → `REQUISITION_NOT_APPROVED`. Issued: issuer recorded, actions now close and cancel, audit `draft → issued`. Then line, invitation, title, and due-time changes by direct SQL → `PFB01` as app role **and** owner. |
| P6a-AC5 close and cancel | **PASS** | close only from issued (draft `INVALID_TRANSITION`, stale `CONFLICT`, twice `INVALID_TRANSITION`); cancel from draft, issued, and closed, with a required reason (missing, empty, blank, 501 characters refused), audited with the reason; cancelled is terminal; afterwards the same requisition lines go on a new RFQ. |
| P6a-AC6 access | **PASS** | procurement, finance, and auditor list and read every RFQ; `q` literal (`100%` matches only its title, `_` nothing); filters by requisition and status; cursor paging; bad filters, a SQL string as cursor, `limit` 101, and unknown fields refused; DTO allowlists for summaries, detail, lines, suppliers, form options; names instead of user ids; readers get no actions; unknown id `NOT_FOUND`. Requester, approver, finance, auditor, admin, receiver cannot create, issue, or read the form options (`FORBIDDEN`); requester, approver, admin, receiver cannot read RFQs. Permission matrix: 46 operations. |
| P6a-AC7 database backstops | **PASS** | RFQs: inserting as issued or for a draft requisition, changing number, requisition, or creator, skipping a state, awarding without the command, reopening a cancelled RFQ, issuing for a requisition no longer approved → `PFB01`; delete → `42501` (app) / `PFB01` (owner); issued without its time → `23514`. Lines: another requisition's line, a changed description or unit, more than is left → `PFB01`; quantity 0 → `23514`; the same line twice on one RFQ → `23505`; a line on another live RFQ → `PFB01`. Invitations: a pending supplier → `PFB01`; updating → `42501`. |
| P6a-AC8 concurrency | **PASS** | `tests/concurrency/rfqs.test.ts`: 5 parallel creates for one requisition line, forced to overlap (a third connection holds the requisition row until all 5 wait), 20 times: exactly one succeeds, the others `LINE_ALREADY_IN_RFQ`, one RFQ line per requisition line, `RFQ-` numbers 1 to 20 without gaps. |
| P6a-AC9 screens | **PASS** | `tests/e2e/rfqs.spec.ts`: Rina's requisition approved by Bayu in the UI; Dewi opens it (no RFQ yet), **Request quotations**, title prefilled, due time, more than is left refused with the server message and nothing created, then 2 suppliers, draft created, edited to 1 supplier, issued; the requisition lists the RFQ and its lines can no longer be picked; Sari and Lena read it without actions and get *Access denied* on the form; Dewi closes it; cancel without a reason is refused. A requester has no RFQs link and gets *Access denied*. `/rfqs`, an RFQ, and the new-RFQ form have one h1 and only labeled controls; no CSP violations. |
| P6a-AC10 definition of done | **PASS** | command table above. |

**Mutation checks** (`scratchpad/mut/run6a.mjs`):

| # | Mutation | Result |
| --- | --- | --- |
| M1 | "line already on another live RFQ" not checked by the application | killed: the trigger turns it into `INTERNAL` (2 tests, including the concurrency test) |
| M2 | the trigger no longer refuses a line on two live RFQs | killed (direct-SQL test) |
| M3 | quantity left to order not checked by the application | killed (2 tests) |
| M4 | issue does not re-check the requisition | killed |
| M5 | the trigger lets an RFQ of a requisition no longer approved be issued | killed (direct-SQL test) |
| M6 | lines editable after issue in the database | killed |
| M7 | issue does not check the due time | killed |
| M8 | cancelled RFQs keep holding their requisition lines | killed |
| M9 | finance loses `rfq.read` | killed (role matrix and operation matrix, 3 tests) |
| M10 | invited suppliers not checked by the application | killed (2 tests) |
| M11 | due time read as UTC instead of the org time zone | killed |
| M12 | create does not lock the requisition | killed: the 4 losers slip past the application check and are stopped by the trigger (`PFB01` → `INTERNAL`) instead of getting `LINE_ALREADY_IN_RFQ`. Integrity held because of the trigger; the lock is what gives the right answer. |

### Failures and how they were resolved

1. Supplier fixtures used tax IDs shorter than 5 characters; fixed in the test (`EX-1000-000N`).
2. Two test mistakes (a fixture spread overwrote the requisition number with the RFQ number; an input with one id passed two lines). Fixed in the test.
3. **E2E: the RFQ form lost the due time after a server error.** React 19 resets uncontrolled form fields after every form action, also one that returns an error. The title and due time are now controlled fields. **The same pattern exists in older forms** (for example, the requisition form's title, justification, and needed-by date): not changed here, see "Known limitations".
4. **Verification run 1:** `tests/integration/identity.test.ts` listed the auditor's permissions without `rfq.read` (a correct consequence of decision 2, so the expectation was updated); and the long E2E test went over Playwright's 30-second default while the suite ran in parallel (alone: 9.6 s). It now has 90 s and takes 30.8 to 41.1 s in parallel runs.
5. **Verification run 2:** a test database drop failed with `42501` "permission denied to terminate process": a closed app-role connection's server backend can outlive `pool.end()` for a moment, and `DROP DATABASE … WITH (FORCE)` may not end another role's backend. A flake in the test harness since Phase 2, unrelated to RFQs; the drop now waits and retries, as creating a test database already did. Run 3 is green.

### Files changed

- New: `src/modules/sourcing/**`, `src/modules/requisitions/{application/sourcing.ts,tables.ts}`, `src/modules/suppliers/{application/directory.ts,tables.ts}`, `src/app/(app)/rfqs/**`, migrations `0012`, `0013` with snapshots, tests `tests/unit/rfq-domain.test.ts`, `tests/integration/rfqs.test.ts`, `tests/concurrency/rfqs.test.ts`, `tests/e2e/rfqs.spec.ts`, this report.
- Changed: roles (`rfq.read`), organization settings domain and index, requisitions and suppliers indexes, supplier repository, `src/server/schema.ts`, `eslint.config.mjs`, nav and requisition detail page, seed, tests (`roles`, `permission-matrix`, `identity`, `tests/support/test-db.ts`), migration journal, docs (state machines, schema, API contracts, architecture, ADR 0006 amendment, ADR 0008 notes, ADR index, threat model, user stories, PLAN, development, README).

### Dependency changes

None.

### Known limitations / not verified

- **Not verified:** CI (no remote), `gitleaks`, `actionlint` (not installed).
- ProcureFlow does not send RFQs to suppliers; the buyer contacts them outside the system.
- Quotations, the comparison, award, and the RFQ settings are Phase 6b.
- **Older forms reset uncontrolled fields after a server error** (found while testing this phase; for example, a requisition rejected by the server comes back with an empty title and date, while its lines are kept). Not fixed here because it is outside the approved scope; it is a small, separate fix.
- The requisition-line check is under the requisition lock; a requisition cancelled while its RFQ is a draft leaves that draft in place (it can be cancelled, not issued).

### Threat-model updates

`docs/threat-model.md`, new "Phase 6a status": AB-07 first half (RFQs only from approved requisitions, within what is left, active suppliers, one live RFQ per line), T-01, T-02 after issue, T-03 search, E-01, residual (no delivery to suppliers).

### Next steps

1. Phase 6b: quotations, comparison, award with justifications, `rfq_required_above` and `min_quotes`.
