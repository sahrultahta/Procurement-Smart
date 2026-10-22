## Phase 4 report: Suppliers

- Date: 2026-10-22
- Base commit: `6b910c4` (Phase 3b). Phase 4 is committed as a single commit on top of it (2026-10-22, after maintainer approval), together with this report. Not pushed: there is no remote.
- Machine: Windows 10 Enterprise 19045, Node 24.21.0, npm 11.19.0, local PostgreSQL 18.6, Microsoft Edge (Playwright `msedge` channel)
- Maintainer decisions for this phase (2026-10-22):
  1. **Duplicate detection ignores punctuation**, not only case and spacing: "PT. Maju-Jaya" = "pt maju jaya", and tax IDs ignore separators. Legal suffixes (PT, CV, Ltd) still count.
  2. The plan with P4-AC1 to AC13 was approved as presented, including the new permission `supplier.block`.

Status vocabulary: **Implemented**, **Tested**, **Verified** (run here, output observed). Nothing is **Deployed**.

### What Phase 4 adds (all implemented, tested, verified locally)

| Area | Where |
| --- | --- |
| Supplier state machine SUP-T01 to T09 as a pure table; name and tax ID duplicate keys; ISO 3166-1 country list (249 codes) | `src/modules/suppliers/domain/{supplier,countries}.ts` |
| Commands `supplier.{create,update,review,block,unblock,deactivate,reactivate}` | `src/modules/suppliers/application/supplier-commands.ts`, `supplier-input.ts` |
| Queries `supplier.{list,get,selectableForPurchasing}` with field allowlists; literal, injection-safe search | `application/supplier-queries.ts`, `infrastructure/supplier-repository.ts` |
| Table `suppliers`: partial unique indexes for live names and all tax IDs; CHECKs for SOD-03 (`suppliers_maker_checker`) and AB-04 (`suppliers_active_is_reviewed`); trigger keeping code and creator fixed (`PFS01`); grants without DELETE | `infrastructure/schema.ts`, migrations `0006` (generated) and `0007` (hand-written) |
| New permission `supplier.block` for procurement and finance (ADR 0006 amendment) | `src/modules/identity/domain/roles.ts` |
| Supplier screens: list with search and status filter, register, detail with edit, review (approve/reject), block/unblock, deactivate/reactivate; confirmations survive the status change as page notices | `src/app/(app)/suppliers/**` |
| Seed: three fictional suppliers registered by Dewi, two approved by Sari, through the commands | `scripts/seed.ts` |
| `identity/tables.ts`: the identity module's table declarations, for foreign keys only (lint rule extended) | `src/modules/identity/tables.ts`, `eslint.config.mjs`, `docs/architecture.md` |
| Shared form helpers moved out of the admin area | `src/lib/action-state.ts`, `src/components/form-message.tsx` |

### Commands run (exact) and results

Final run on 2026-10-22, with `NEXT_TELEMETRY_DISABLED=1` for Next.js commands.

| Command | Exit | Result |
| --- | --- | --- |
| `npx drizzle-kit generate --name=suppliers` | 0 | `0006_suppliers.sql`: table, 11 CHECKs, 3 FKs, 3 indexes (reviewed) |
| `npx drizzle-kit generate --custom --name=suppliers_guards_and_grants` | 0 | `0007`: role check, grants, `PFS01` trigger (hand-written) |
| `npx drizzle-kit generate --name=noop_check` | 0 | "No schema changes": schema and migrations agree |
| `npm run db:migrate` | 0 | applied to `procureflow_dev` (again in the final run: no-op) |
| `npm run seed` (twice) | 0 / 0 | 1st: **3 suppliers created**, 7 users skipped. 2nd: **0 created, 3 skipped** (idempotent) |
| `git diff --quiet HEAD -- package.json package-lock.json` | 0 | **no dependency changes** |
| `npm run lint` | 0 | no findings |
| `npm run typecheck` | 0 | no errors |
| `npm run test:unit` | 0 | 11 files, **358 passed** (was 299): `supplier-domain.test.ts` 52, role matrix +7 cells |
| `npm run test:integration` | 0 | 14 files, **149 passed** (was 116): `suppliers.test.ts` 20, permission matrix +10 operations, `concurrency/suppliers.test.ts` 3 |
| `npm run test:coverage` | 0 | **507 passed**. Thresholds met. Domain/application scope **455/457 lines (99.56%)**; supplier domain and application files at 100% lines |
| `rm -rf .next && npm run build` | 0 | **0 warnings**; new dynamic routes `/suppliers`, `/suppliers/new`, `/suppliers/[id]` |
| `npx playwright test` (twice, back to back) | 0 / 0 | **24 passed** both times (21 earlier + 3 new); each run recreated `pf_e2e` and seeded 7 users and 3 suppliers into it |
| 5 mutation checks (below) | — | all **killed**; originals restored and re-verified |
| `npm audit --omit=dev --audit-level=high` | 0 | 0 high/critical; the same 4 moderate as before (drizzle-kit, an optional peer of better-auth) |
| `npm audit` (full) | 1 | unchanged since Phase 1: 4 moderate + 5 high, all GHSA-vfj7-8cjw-p6xm (`braces`) and GHSA-67mh-4wv8-2f99 (`esbuild`) in dev tooling (accepted in the Phase 1 report) |
| secret scan: 18 distinct local secrets over all 220 committable files | — | **0 hits** |
| `git add -A --dry-run` filtered for `.env`, `.local/`, credentials, keys, DLLs, build and report folders | — | **0** ignored paths would be added |
| relative-link check over `README.md` and `docs/**/*.md` | — | 0 broken (after this report was written) |
| `gitleaks`, `actionlint` | — | **BLOCKED** (not installed) |

### Acceptance criteria

| ID | Status | Evidence |
| --- | --- | --- |
| P4-AC1 state machine, exhaustive | **PASS** | `supplier-domain.test.ts`: all 32 (status × command) pairs against a table written from `docs/state-machines.md`; every unlisted pair is `null`. Integration: unlisted transitions through the commands (block a pending supplier, unblock/deactivate/reactivate from the wrong status, review an active one, edit an inactive one) → `INVALID_TRANSITION`, with the row unchanged. |
| P4-AC2 maker-checker | **PASS** | a user holding procurement **and** finance cannot approve or reject a supplier they registered (`MAKER_CHECKER`), nor one whose identity they last changed; `callerIsMaker` is true only for them; another finance user can. As the app role: self-review → `23514`, "active without review" → `23514`, rewriting the creator or code → `PFS01`, `DELETE` → `42501`. |
| P4-AC3 identity change → review | **PASS** | contact edit on an active supplier: still active, review kept. Legal-name edit (even case only) or tax-ID edit: `pending_review`, review cleared, `identity_changed_by` = editor, audited with the status change. A blocked supplier stays blocked on an identity edit and needs a fresh review after unblocking. A no-op writes nothing. |
| P4-AC4 duplicates | **PASS** | "pt.  MAJU-jaya" vs "PT Maju Jaya", and "012345678901000" / "0123 4567 8901 000" vs "01.234.567.8-901.000" → `SUPPLIER_DUPLICATE`, naming the existing code; "CV Maju Jaya" is allowed. Also on edit and reactivation; an inactive supplier frees its name but never its tax ID; the unique index rejects a direct SQL duplicate (`23505`). **CC-09**: 5 parallel creates with one tax ID, and 5 with one name punctuated differently, 20 times each: exactly 1 succeeds, 4 get `SUPPLIER_DUPLICATE`, and `SUP-` codes stay gapless. |
| P4-AC5 selectable for purchasing | **PASS** | suppliers in all four statuses: only the active ones are returned, the count equals the active rows, keys = `SELECTABLE_SUPPLIER_KEYS` |
| P4-AC6 search is literal | **PASS** | found by code (any case), by name ignoring punctuation, by tax ID however formatted. `'; drop table suppliers; --`, `%`, `_`, `%%`, `\`, `' OR '1'='1` → 0 results, table intact. `SUP-%` returns exactly the suppliers whose name contains "sup", not every code. Bad cursor, unknown status, `limit: 0`, a 101-character query, and an unknown `sort` field → `VALIDATION_FAILED`. |
| P4-AC7 block / unblock / deactivate / reactivate | **PASS** | blank reason → `VALIDATION_FAILED`; stale version → `CONFLICT`; each transition audited with reason and before/after status; procurement and finance can both block, only finance unblocks (procurement → `FORBIDDEN`); unblock and reactivate go to `pending_review` with the review cleared; reject needs a note (`fieldErrors.note`), which becomes the status reason |
| P4-AC8 AB-04 race | **PASS** | **CC-10**: approval and identity change on the same version, forced to overlap (a third connection holds the row until both wait on it), 20 times: always one `ok` and one `CONFLICT`, version 2, and either "active with the old name, reviewed" or "pending review with the new name, no reviewer". 0 active suppliers without a reviewer. |
| P4-AC9 matrices | **PASS** | role matrix: 7 roles × 24 permissions (168 cells) including `supplier.block` = procurement + finance; operation matrix: 23 operations × 9 callers, with the 10 supplier operations written from ADR 0006 |
| P4-AC10 strict inputs, allowlisted outputs | **PASS** | 14 tampered or malformed inputs (status, code, creator, reviewer, normalized name, a `bankAccount` field, country `XX` / `us`, `---` name, 201-character name, bad email, bad tax ID characters, too-short tax ID, bad phone) → `VALIDATION_FAILED` with nothing written; blank optional fields stored as null; detail keys = `SUPPLIER_DETAIL_KEYS`, user **names** instead of ids (no user id in the payload); unknown ids → `NOT_FOUND`; a requester gets `FORBIDDEN` on list, get, and selectable; an auditor cannot create |
| P4-AC11 UI and E2E | **PASS** | E2E: Dewi registers (pending review, no Approve button for her) → a differently punctuated duplicate is refused → Sari finds it by tax ID typed differently and approves (notice shown, status Active) → Dewi renames it (back to pending review) → Sari approves again → Dewi blocks with a reason (no Unblock button for her) → Sari unblocks (pending review). No CSP violations. An auditor sees the list and details with no controls; a requester has no Suppliers link and gets "Access denied". One `h1` per supplier page, every control labeled. |
| P4-AC12 seed | **PASS** | three fictional suppliers (example.com contacts, 555-01xx numbers, made-up tax IDs) created through the commands, two approved by a different user than the creator; the second run skipped all three |
| P4-AC13 documentation | **PASS** | ADR 0006 amendment (`supplier.block`, SOD-03 backstops), ADR 0008 (CC-09, CC-10), `schema.md`, `api-contracts.md`, `state-machines.md` §3 (implemented + notes), `threat-model.md` Phase 4 status, `architecture.md` (`tables.ts`), `user-stories.md`, `development.md`, `PLAN.md`, `README.md`, this report |
| Definition of done | **PASS** | all checks above. Committed after maintainer approval (2026-10-22). |

### Mutation checks

Each mutation was applied to one file, the named tests were run, the original was restored from a copy, and the tests were run again (green).

| Mutation | Test run | Result |
| --- | --- | --- |
| M1: no maker-checker check in `supplier.review` | `suppliers.test.ts` | **killed** (2 failed). The self-review was still refused, by the database CHECK (`INTEGRITY_CONSTRAINT` instead of `MAKER_CHECKER`): the backstop works on its own. |
| M2: every edit treated as a contact edit | `suppliers.test.ts` | **killed** (2 failed) |
| M3: LIKE wildcards not escaped | `suppliers.test.ts` | **killed**: a search for `%` returned all 19 suppliers |
| M4: no duplicate pre-check on create | `suppliers.test.ts` | **killed**: the insert's `ON CONFLICT` still refused it, but without naming the existing supplier |
| M5: no version check | `concurrency/suppliers.test.ts` | **killed**: CC-10 saw both the approval and the identity change succeed |

### Failures found and fixed during the phase

1. **Lint blocked the supplier schema from importing `users`** (module boundary rule). The foreign key is required for referential integrity, so the identity module now exposes `tables.ts` (declarations only), and the rule allows exactly that file. Recorded in `docs/architecture.md`.
2. **Confirmations vanished after a status change.** For example, after "Approve" the review form is no longer shown for an active supplier, so its success message disappeared with it (the first E2E run caught this). Status changes now reload the page with a notice (`role="status"`) from a fixed list.
3. **CC-10 could not see the waiting transactions**: `pg_stat_activity` hides other roles' wait events from non-superusers. The test now counts ungranted locks in `pg_locks`, limited to its own database.
4. **One search test expected the wrong thing**: `SUP-%` normalizes to the name key "sup", which legitimately matches "Example **Sup**plies". The test now proves what matters (the `%` in the code is literal; the results are exactly the name matches).
5. **A test helper looped over two queries with different input types** (`tsc` error, Vitest itself did not mind): replaced with two explicit calls.

### Decisions

- **`supplier.block` permission** instead of "any of" permissions in the runner (ADR 0006 amendment).
- **Identity change = any edit of the legal name or tax ID as typed**, even case only. Conservative on purpose (AB-04).
- **Identity edits are allowed while pending review or blocked**: the status stays, the review is cleared, and the editor becomes a maker.
- **Tax IDs are unique across all suppliers**, including inactive ones (a rejected supplier cannot be re-registered under a new record; reactivate it instead). Names are unique only among non-inactive suppliers, as designed.
- **Reasons are required** for reject, block, unblock, and deactivate.
- **`supplier.get` returns user names, not ids**, plus `callerIsMaker` so the page can explain why it shows no Approve button. The server still decides.

### Dependency changes

None. `package.json` and `package-lock.json` are identical to `6b910c4`.

### Files changed

New (31): `db/migrations/{0006_suppliers.sql,0007_suppliers_guards_and_grants.sql,meta/0006_snapshot.json,meta/0007_snapshot.json}`, `src/modules/suppliers/{index.ts,domain/{supplier,countries}.ts,application/{supplier-commands,supplier-input,supplier-queries}.ts,infrastructure/{schema,supplier-repository}.ts}`, `src/modules/identity/{tables.ts,application/user-names.ts}`, `src/app/(app)/suppliers/{page.tsx,new/page.tsx,[id]/page.tsx,actions.ts,country-options.ts,notices.ts,_components/{supplier-form,supplier-actions,supplier-status}.tsx}`, `src/app/(app)/admin/_components/setup-link.tsx`, `src/components/form-message.tsx`, `tests/unit/supplier-domain.test.ts`, `tests/integration/suppliers.test.ts`, `tests/concurrency/suppliers.test.ts`, `tests/e2e/suppliers.spec.ts`, `tests/support/actors.ts`, this report.

Moved (1): `src/app/(app)/admin/action-state.ts` → `src/lib/action-state.ts`. Deleted (1): `src/app/(app)/admin/_components/form-message.tsx`, split into `src/components/form-message.tsx` and `admin/_components/setup-link.tsx`.

Modified (25): `README.md`, `eslint.config.mjs`, `scripts/seed.ts`, `db/migrations/meta/_journal.json`, `src/server/schema.ts`, `src/app/(app)/layout.tsx` (Suppliers link), `src/app/(app)/admin/{actions.ts,_components/{create-user-form,department-forms,user-forms}.tsx}` (imports), `src/modules/identity/{index.ts,domain/roles.ts}`, `tests/unit/roles.test.ts`, `tests/integration/permission-matrix.test.ts`, docs (`PLAN.md`, `adr/0006`, `adr/0008`, `adr/README.md`, `api-contracts.md`, `architecture.md`, `development.md`, `schema.md`, `state-machines.md`, `threat-model.md`, `user-stories.md`).

Local only: the development database got migrations 0006–0007 and the 3 seed suppliers; `pf_e2e` is recreated per E2E run.

### Known limitations / not verified

- **CI has never run** (no remote). **gitleaks and actionlint: BLOCKED.**
- **Look-alike names** that differ in letters ("Maju Jaya" / "Maju Jaja") or drop a legal suffix ("PT Maju Jaya" / "Maju Jaya") are not caught by normalization. That stays a judgment call for the reviewer.
- **No supplier history screen.** Every change is in the audit trail, but only auditors and admins can read it, and the audit UI comes in Phase 9.
- **Supplier pages render their query for anyone signed in**; users without `supplier.read` get "Access denied" (`FORBIDDEN`), and nothing else.
- The list is ordered by code only; there is no sorting by name yet.
- `supplier.selectableForPurchasing` returns all active suppliers at once; it will need search or paging if the list grows large (Phase 6 is its first user).
- Accessibility: basics only (labels, one `h1`). No screen-reader pass; only Edge tested.
- No bank or payment details, by design (schema note).

### Threat-model updates

AB-03 and AB-04 controlled (maker-checker with DB backstops, identity change → review, CC-09/CC-10); T-03 verified for supplier search; E-01 extended to supplier operations; residual risk: look-alike names. See `docs/threat-model.md`, "Phase 4 status".

### Next steps

1. Done: maintainer review, then committed (no push; there is no remote).
2. Phase 5: purchase requisitions and multi-step approvals, plus org name, timezone, and currency settings.
