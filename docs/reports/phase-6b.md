## Phase 6b report: quotations, comparison, and award

- Date: 2026-10-25 (implementation); the last verification steps ran on 2026-10-26
- Base commit: `1afbab9` (form-state fix, on top of Phase 6a `4c0360a`). Phase 6b is committed as a single commit on top of it (2026-10-26, after maintainer approval), together with this report. Not pushed: there is no remote.
- Machine: Windows 10 Enterprise 19045, Node 24.21.0, npm 11.19.0, local PostgreSQL 18.6, Microsoft Edge (Playwright `msedge` channel)
- Maintainer decisions (2026-10-25):
  1. **A quotation recorded after the RFQ's due time is accepted** while the RFQ is issued, and **marked late**.
  2. **Only valid quotations count** towards `min_quotes` and the lowest price: submitted, not expired (today in the org time zone), supplier active.
  3. **Closing an RFQ discards the drafts** nobody submitted.
  4. The plan with P6b-AC1 to AC12 was approved as presented. Do not commit without permission.
  5. (2026-10-26) Commit Phase 6b as one commit, without ignored files; do not push.

Status vocabulary: **Implemented**, **Tested**, **Verified** (run here, output observed). Nothing is **Deployed**.

### What Phase 6b adds (all implemented, tested, verified locally)

| Area | Where |
| --- | --- |
| Quotation state machine (QUO-T01 to T05, plus discarding a draft), validity, lateness, and which RFQ status allows which change | `src/modules/sourcing/domain/quotation.ts` |
| Comparison (lowest valid total and lowest price per line, ties) and the award's justification rules | `src/modules/sourcing/domain/comparison.ts` |
| Commands `quotation.record`, `.update`, `.submit`, `.withdraw`; `quotation.award` (RFQ-T05); closing an RFQ discards its drafts | `src/modules/sourcing/application/{quotation-commands,award,rfq-commands}.ts` |
| One lock order for every sourcing command: requisition → RFQ → quotations | `src/modules/sourcing/application/rfq-locks.ts` |
| `rfq.get` with quotations, the comparison, the award, and the caller's actions | `src/modules/sourcing/application/rfq-queries.ts` |
| Settings `rfq_required_above` and `min_quotes` (admin, audited) | `src/modules/organization/application/settings.ts`, Admin → Settings |
| Requisitions: currency, scale, and estimated total for sourcing | `src/modules/requisitions/application/sourcing.ts` |
| Tables `quotations`, `quotation_lines`, award columns on `rfqs`, settings columns; grants; triggers `quotations_guard`, `quotation_lines_guard`, commit-time `quotations_totals` / `quotation_lines_totals` (`PFB02`), `rfqs_guard` extended (`PFB01`) | `db/migrations/0014` (generated), `0015` (hand-written) |
| Screens: on the RFQ page, **Quotations** (record, edit, submit, discard, withdraw), **Comparison**, **Award** (with a note on whether a justification is needed) and the award result; record and edit pages; two fields under **Admin → Settings → Quotations**; the close form warns about drafts | `src/app/(app)/rfqs/**`, `src/app/(app)/admin/_components/settings-form.tsx` |
| Seed: the award rule (from 500, 3 valid quotations) and two submitted quotations on the *Office chairs* RFQ, which stays issued | `scripts/seed.ts` |

Decisions taken within the approved scope (please review):
1. **Discarding a draft** is `quotation.withdraw` on a draft, with a reason like any withdrawal (state-machine amendment). It is possible while the RFQ is issued.
2. **Withdrawing a submitted quotation** is possible until the award, so also after the RFQ is closed. On a cancelled RFQ every quotation, drafts included, stays as recorded and can no longer change (RFQ-T06: "open quotations stay as recorded").
3. **Late** is derived, not stored: `submitted_at` > `response_due_at`. `submitted_at` comes from the application clock (not the database's `now()`), the same clock that decides lateness and expiry.
4. **The threshold compares the requisition's approved estimated total** with `rfq_required_above` (≥, as RFQ-T05 says), not a quotation total.
5. **One justification covers both reasons.** When both apply, the error is `MIN_QUOTES_JUSTIFICATION_REQUIRED`, its message explains both, and `details.reasons` lists both. A blank justification counts as none.
6. **The award stores the rule it used** (threshold, minimum, valid count, and the two flags) next to the justification and who awarded it, so lowering the minimum later leaves a trace. The database refuses an award whose "fewer than the minimum" flag does not match those stored values and the requisition's estimated total.
7. **Limits:** `min_quotes` 1 to 10 (the design said ≥ 1); lead time 0 to 365 days; supplier reference up to 100 characters; justification up to 2000.
8. **New business-rule codes** `SUPPLIER_NOT_INVITED` and `SUPPLIER_ALREADY_QUOTED`; **new SQLSTATE** `PFB02` for quotations (mapped to `INTERNAL`, like the other guards).
9. **Expiry and "lowest valid"** are checked by the application only: they depend on its clock and the org time zone. The database checks everything else (invitation, supplier status, currency, quantities, rounding, coverage, totals, transitions, award consistency).
10. **`rfq.get` returns each RFQ line's id** (needed to price the lines); the allowlist test was updated. **`quotation.update`, `.submit`, and `.withdraw` return the RFQ id**, so the screens redirect only to an id the server returned.
11. **Seed:** the settings get the award rule (500, 3); a threshold that is empty is set again on every seed run (local demo data only).

### Commands run (exact) and results

One full run of `scratchpad/verify6b/run.sh` from `npm ci` (2026-10-25 evening), with `NEXT_TELEMETRY_DISABLED=1`. The computer went to sleep during its coverage step, so coverage, build, and both E2E runs were repeated the next morning with the machine kept awake (`scratchpad/verify6b/rerun.sh`); the table shows the repeated results and "Failures" explains the interrupted ones. No source file changed between the two runs.

| Command | Exit | Result |
| --- | --- | --- |
| `npx drizzle-kit generate --name=quotations_and_award` | 0 | `0014`: 2 tables, 2 settings columns, 9 award columns on `rfqs`, CHECKs, FKs (one composite), indexes (one partial unique). Reviewed; additive only |
| `npx drizzle-kit generate --custom --name=quotations_guards_and_grants` | 0 | `0015`: grants, `rfqs_guard` replaced, 3 new trigger functions, 2 deferred constraint triggers (hand-written) |
| `git diff --stat HEAD -- package.json package-lock.json` | 0 | empty: **no dependency changes** |
| `npm ci` | 0 | 597 packages from the lockfile |
| `npm run db:migrate` | 0 | 0014 and 0015 applied to the development database |
| `npm run lint` | 0 | no findings |
| `npm run typecheck` | 0 | no errors |
| `npm run test:unit` | 0 | 16 files, **556 passed** (was 523: 33 new) |
| `npm run test:integration` | 0 | 23 files, **273 passed** (was 242: 22 quotation tests, 3 races, 1 settings test, 5 matrix operations) |
| `npx vitest run --coverage` (repeated) | 0 | **829 passed**; domain/application scope **1294/1298 lines (99.69 %)**; every sourcing domain and application file at 100 % of lines |
| `rm -rf .next && npm run build` (repeated) | 0 | **0 warnings** |
| `npx playwright test` (twice, back to back, repeated) | 0 / 0 | **38 passed** both times (36 earlier + 2 new). The full quotation flow took 44.5 s and 50.4 s (limit 150 s) |
| `npm audit --omit=dev --audit-level=high` | 0 | 0 high/critical; the same 4 moderate (`esbuild` via `drizzle-kit`) |
| `npm audit` | 1 | the same 4 moderate, nothing new |
| secret scan: 18 distinct local secrets over all 338 committable files | 0 | **0 hits** |
| relative-link check over `README.md` and `docs/**/*.md` | 0 | 53 links in 34 files, 0 broken |
| `npm run seed` (development database) | 0 | "1 settings updated, … 2 quotations created" (threshold 500, minimum 3; two submitted quotations on *Office chairs*) |
| mutation checks (`scratchpad/mut/run6b.mjs`) | — | **23/23 killed** after one test was strengthened (below) |
| `gitleaks`, `actionlint` | — | **BLOCKED** (not installed) |

### Acceptance criteria

| ID | Result | Evidence |
| --- | --- | --- |
| P6b-AC1 quotation machine | **PASS** | All 25 (status, command) pairs against a table written out by hand; terminal states; which RFQ status allows each change; validity and lateness at their edges (`tests/unit/quotation-domain.test.ts`) |
| P6b-AC2 settings | **PASS** | Threshold as a JSON number, negative, with an exponent, with 5 decimals, or empty, and a minimum of 0, 11, 2.5, "3", or null are `VALIDATION_FAILED`, as is leaving either out; only admins (requester and auditor `FORBIDDEN`); the change is audited with only the changed fields; "500.0000" after "500" writes nothing; back to "never"; CHECKs refuse 0, 11, and −1 in the database (`organization.test.ts`) |
| P6b-AC3 record | **PASS** | `SUPPLIER_NOT_INVITED` (uninvited, unknown, or pending supplier), `SUPPLIER_NOT_ACTIVE` (blocked after the invitation), `SUPPLIER_ALREADY_QUOTED` (draft or submitted; allowed again after a withdrawal); draft, closed, or cancelled RFQ → `INVALID_TRANSITION`; a missing, repeated, or foreign line and 19 kinds of bad or server-only fields refused with nothing written; 20 × 0.0125 = 0.25 and 1.5 × 0.11 = 0.165 → **0.17** (half-up; half-even would give 0.16); currency USD from the requisition; audit with line summaries; idempotency key replayed and reuse refused |
| P6b-AC4 edit, submit, withdraw | **PASS** | Edits audited field by field, an unchanged draft writes nothing, stale version `CONFLICT`, a submitted quotation `INVALID_TRANSITION`; in Asia/Jakarta, 16:59 UTC on the last day submits and 17:00 UTC (midnight local) is `QUOTATION_EXPIRED`; supplier blocked after recording → `SUPPLIER_NOT_ACTIVE`; submitted at the due minute not late, one second later late (DTO and audit); withdrawals need a reason (1–500), work after closing, not on a cancelled RFQ |
| P6b-AC5 close, cancel | **PASS** | Closing discards two drafts with the automatic reason, audited per quotation, keeps the submitted one; a cancelled RFQ keeps a submitted quotation and a draft, both without actions |
| P6b-AC6 comparison | **PASS** | With five quotations: lowest valid total, lowest price per line, validity reasons (draft, supplier not active, valid on its last day, expired the next day); the summary at its edges (estimate = threshold applies, one cent above does not; valid count = minimum is enough; null threshold); ties are all the lowest; allowlisted fields |
| P6b-AC7 award | **PASS** | Not before closing; lowest with enough valid quotations needs no justification; others not awarded, withdrawn stays withdrawn; snapshot and `awarded_by_user_id`; audit `rfq.awarded`, `quotation.awarded`, `quotation.notAwarded`; below the minimum (at the threshold itself) `MIN_QUOTES_JUSTIFICATION_REQUIRED` with the exact message and details, blank justifications refused, 2001 characters `VALIDATION_FAILED`; non-lowest `NON_LOWEST_JUSTIFICATION_REQUIRED`; both reasons in one error; `QUOTATION_EXPIRED`, `SUPPLIER_NOT_ACTIVE`, withdrawn, foreign, stale version, unknown RFQ; requisition cancelled → `REQUISITION_NOT_APPROVED`; the stored rule survives a settings change |
| P6b-AC8 access | **PASS** | 5 new operations in the matrix (51 in all), procurement only; requester, approver, finance, auditor, admin, and receiver get `FORBIDDEN` for every quotation command; finance and the auditor read quotations and the comparison without actions or user ids |
| P6b-AC9 database backstops | **PASS** | As the runtime role and as the owner: uninvited supplier `23503`; inserted as submitted, on a draft RFQ, for a blocked supplier, or in another currency `PFB02`; a draft without lines refused at commit; a second live quotation `23505`; 11 kinds of change to a submitted quotation or a draft's identity `PFB02`, plus changing terms while submitting or withdrawing; delete `42501` / `PFB02`; line quantity, rounding, moving, and foreign lines `PFB02`; header and lines out of step refused at commit, in step accepted; closing with a draft and inconsistent awards `PFB01` / `23514`; an awarded RFQ frozen |
| P6b-AC10 races | **PASS** | 3 races × 20 forced overlaps (`tests/concurrency/quotations.test.ts`): exactly one live quotation; one award and one `CONFLICT`; award vs withdrawal always consistent |
| P6b-AC11 E2E | **PASS** | `tests/e2e/quotations.spec.ts`: Dewi records two quotations (a missing price refused with the typed values kept, a draft edited, then submitted), the comparison marks the lowest total and the lowest line price, the rule summary shows, she closes, finance and the auditor read without any control (also on the record page), a non-lowest award without justification is refused with the choice kept, then awarded with one; the seeded RFQ's comparison; the settings fields are labeled (not saved); one h1 and only labeled controls; no CSP violations |
| P6b-AC12 definition of done | **PASS**, except `gitleaks`, `actionlint`, and CI (**BLOCKED**) | the table above |

### Mutation checks

Each change was applied alone, the named tests ran, and the file was restored (checked by content, and afterwards by checksum against a backup).

| ID | Mutation | Result |
| --- | --- | --- |
| M1 | record does not check the invitation | killed (the FK stops it as `INTEGRITY_CONSTRAINT`, not `SUPPLIER_NOT_INVITED`) |
| M2 | record does not check that the supplier is active | killed (trigger `PFB02` → `INTERNAL`) |
| M3 | record does not look for a live quotation | killed (unique index → `CONFLICT`) |
| M4 | record does not lock the RFQ | killed by the race: the losers reach the unique index |
| M5 | rounding to 4 decimals instead of the currency scale | killed (trigger) |
| M6 | submit ignores the validity date | killed |
| M7 | the last valid day counts as expired | killed |
| M8 | "today" in UTC instead of the org time zone | killed |
| M9 | expired and inactive-supplier quotations count | killed |
| M10 | the minimum only above the threshold | killed |
| M11 | exactly the minimum counts as too few | killed |
| M12 | a tie is not the lowest | killed |
| M13 | the award never asks for a justification | killed (CHECK `rfqs_award_justified` → `INTEGRITY_CONSTRAINT`) |
| M14 | the other quotations stay submitted | killed |
| M15 | the award does not re-check the requisition | killed (trigger `PFB01`) |
| M16 | the award ignores the RFQ version | killed (integration and race) |
| M17 | closing keeps the drafts | killed (trigger refuses the close) |
| M18 | the database stops checking the rounded line total | killed |
| M19 | the database lets terms change outside a draft | **survived the first run**, killed after adding two cases (see Failures) |
| M20 | the database lets an RFQ close with drafts | killed |
| M21 | the database stops checking the stored "fewer than the minimum" flag | killed |
| M22 | the commit-time coverage and total check does nothing | killed |
| M23 | finance gets `quotation.award` | killed (role and operation matrices, integration) |

### Failures and fixes during the phase

1. **Award CHECK tightened before first use.** The first generated `0014` allowed some award columns to be filled on an RFQ that is not awarded. Both new migrations were removed by a script that refused to touch tracked files, the CHECK was replaced by `rfqs_award_states`, and both were generated again. No database had applied the first version.
2. **Found in review before the first run:** the award's message and `details.lowestTotal` would have shown stored values ("302.3", "205.0000"); now at the currency scale. Two backstop tests were not deterministic (a "different supplier" picked with `LIMIT 1`; a shared supplier blocked by direct SQL) and were rewritten.
3. **Wrong expectation:** a negative price whose total matches the rounding rule is refused by the CHECK (`23514`), because BEFORE triggers run before CHECKs; the test expected `PFB02`.
4. **First full integration run: 7 failures**, all from the new contract: the settings command needs the two new fields, 5 operations were not in the matrix, RFQ lines now carry their id, and procurement now sees `record` and `award`. Tests updated.
5. **Race expectation:** I expected the losing side of award vs withdrawal to get `INVALID_TRANSITION` in both orders. When the award goes first, the withdrawal holds a stale quotation version and gets `CONFLICT`, which is correct; the test now checks each order.
6. **Timeouts under parallel load (no logic change):** the Phase 5a currency race (10 fresh databases, 20 s alone) went over 30 s in the full suite and now has 120 s; the Phase 5b E2E golden path went over 30 s (the trace shows every assertion passed and the time went into sign-ins) and now has 90 s, like the other long E2E tests.
7. **Mutation design found a gap:** rounding of quotation lines was proven only when the header total did not match; a case with a matching header was added before the run (M18).
8. **M19 survived:** the trigger's "terms change only in a draft" rule was never the reason a test failed, because changing a submitted quotation without a status change is already refused by the transition rule. Two cases now change terms together with a status change (submitting a draft, withdrawing a submitted quotation); M19 is killed.
9. **The computer slept during the verification run.** Coverage reported hook timeouts with durations of about 13 hours, and the first E2E run failed one startup test (`next start` was still running after 30 s, right after resume). Coverage, build, and both E2E runs were repeated with the machine kept awake: all passed (table above).
10. **Tooling:** a shell heredoc with nested quotes failed to parse (no file changed; checked); patches were written as scripts instead. The desktop app's preview reads another project's folder, so the screens were not looked at in a browser by me; a temporary launch file was created and removed again.

### Files changed

- New: `src/modules/sourcing/domain/{quotation,comparison}.ts`; `src/modules/sourcing/application/{quotation-commands,quotation-input,award,rfq-locks}.ts`; `src/modules/sourcing/infrastructure/quotation-repository.ts`; `src/app/(app)/rfqs/[id]/quotations/new/page.tsx`, `…/[quotationId]/edit/page.tsx`; `src/app/(app)/rfqs/_components/{quotation-form,quotation-actions}.tsx`; `db/migrations/0014_quotations_and_award.sql`, `0015_quotations_guards_and_grants.sql` and their snapshots; `tests/unit/quotation-domain.test.ts`, `tests/integration/quotations.test.ts`, `tests/concurrency/quotations.test.ts`, `tests/e2e/quotations.spec.ts`; this report.
- Changed: sourcing `schema.ts`, `rfq-repository.ts`, `rfq-commands.ts` (shared lock helpers, close discards drafts), `rfq-input.ts`, `rfq-queries.ts`, `index.ts`; organization `schema.ts`, `organization-repository.ts`, `settings.ts`, `index.ts`; requisitions `application/sourcing.ts`; RFQ page, RFQ actions and status components, RFQ Server Actions; settings form and admin Server Action; `src/lib/format.ts`; `scripts/seed.ts`; migration journal; tests `rfqs`, `organization`, `permission-matrix`, `concurrency/requisitions` (timeout), `e2e/approvals` (timeout); docs `PLAN`, `state-machines`, `schema`, `api-contracts`, `architecture`, `threat-model`, `user-stories`, `development`, ADR 0008, `README`.

### Known limitations

- **Residual risk (as planned):** the buyer who records quotations may also award them. The spec has no maker-checker here; the control comes in Phase 7, where SOD-06 keeps the awarding buyer (`rfqs.awarded_by_user_id`) off the purchase order's approval.
- Quotations are typed in by the buyer from what suppliers sent outside the system; ProcureFlow cannot prove that a supplier quoted a price.
- Expiry and "lowest valid" are not checked by the database (decision 9).
- A purchase order cannot be created from the award yet (Phase 7).
- `gitleaks` and `actionlint` are not installed here, and CI has not run (no remote).
- **Not verified:** a person looking at the new screens in a browser (the E2E tests check text, roles, labels, and behavior, not layout); browsers other than Microsoft Edge; screen readers.
