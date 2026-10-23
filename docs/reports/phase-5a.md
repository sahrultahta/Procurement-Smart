## Phase 5a report: Organization settings, approval policies, requisition drafts

- Date: 2026-10-23
- Base commit: `e83e61c` (Phase 4). Phase 5a is committed as a single commit on top of it (2026-10-23, after maintainer approval), together with this report. Not pushed: there is no remote.
- Machine: Windows 10 Enterprise 19045, Node 24.21.0, npm 11.19.0, local PostgreSQL 18.6, Microsoft Edge (Playwright `msedge` channel)
- Maintainer decisions (2026-10-23):
  1. **Phase 5 is split** into 5a (this report) and 5b (submission and approvals).
  2. **Approval policies get an editor screen**, not only a seeded default.
  3. The plan with P5a-AC1 to AC12 was approved as presented, including "any of" permissions in the runner and the idempotency table.

Status vocabulary: **Implemented**, **Tested**, **Verified** (run here, output observed). Nothing is **Deployed**.

### What Phase 5a adds (all implemented, tested, verified locally)

| Area | Where |
| --- | --- |
| Runner: an operation may require any one of several permissions (ADR 0010 amendment) | `src/shared/application/runner.ts` |
| Idempotency keys (ADR 0008 C6) with a request hash | `src/shared/db/idempotency.ts`, table `idempotency_keys` |
| Organization module: settings (name, IANA time zone, ISO 4217 currency and scale), currency lock set by the first requisition | `src/modules/organization/{domain/settings,application/settings}.ts` |
| Approval policies: validation (overlaps, gaps, coverage, steps), resolution (department beats generic, `[min, max)`), versioned publishing under a lock, queries, `resolveApprovalRoute` for 5b | `src/modules/organization/{domain/approval-policy,application/approval-policies}.ts` |
| Requisitions module: pure state machine PR-T01 to T10; create, update, cancel (draft); list and get with visibility in SQL | `src/modules/requisitions/**` |
| Tables `org_settings`, `approval_policies`, `approval_policy_rules`, `approval_policy_steps`, `purchase_requisitions`, `requisition_lines`, `idempotency_keys`; default settings row; grants; triggers `PFO01`, `PFP01`, `PFQ01` | `db/migrations/0008` (generated), `0009` (hand-written) |
| Identity: `findApproverScope`, `findDepartmentDirectory`; `tables.ts` exports `departments` for foreign keys | `src/modules/identity/{application/directory.ts,tables.ts}` |
| Screens: Admin → Settings, Admin → Approval policy (active rules, editor, history); Requisitions (list, new, detail, edit, cancel); org time zone used for all timestamps | `src/app/(app)/admin/**`, `src/app/(app)/requisitions/**`, `src/lib/format.ts`, `src/server/organization-profile.ts` |
| Seed: organization name, default policy published by Ada, one draft requisition by Rina (all through commands) | `scripts/seed.ts` |

### Commands run (exact) and results

Final run on 2026-10-23, with `NEXT_TELEMETRY_DISABLED=1` for Next.js commands.

| Command | Exit | Result |
| --- | --- | --- |
| `npx drizzle-kit generate --name=organization_and_requisitions` | 0 | `0008`: 7 tables with CHECKs, FKs, indexes (reviewed) |
| `npx drizzle-kit generate --custom --name=organization_and_requisitions_guards` | 0 | `0009`: default settings row, grants, 6 trigger functions (hand-written) |
| `npm run db:migrate` | 0 | applied to `procureflow_dev` (and again in the final run: no-op) |
| `npm run seed` (twice) | 0 / 0 | 1st: settings updated, 1 policy published, 1 requisition created. 2nd: nothing created (idempotent) |
| `git diff --quiet HEAD -- package.json package-lock.json` | 0 | **no dependency changes** |
| `npm run lint` | 0 | no findings |
| `npm run typecheck` | 0 | no errors |
| `npm run test:unit` | 0 | 13 files, **423 passed** (was 358): policy rules 9, requisition machine and settings 55, runner +1 |
| `npm run test:integration` | 0 | 17 files, **183 passed** (was 149): organization 7, requisitions 13, permission matrix +11 operations, concurrency 3 |
| `npm run test:coverage` | 0 | **606 passed**. Thresholds met. Domain/application scope **673/675 lines (99.70%)** |
| `rm -rf .next && npm run build` | 0 | **0 warnings**; new routes `/admin/settings`, `/admin/approval-policy`, `/requisitions`, `/requisitions/new`, `/requisitions/[id]`, `/requisitions/[id]/edit` |
| `npx playwright test` (twice, back to back) | 0 / 0 | **28 passed** both times (24 earlier + 4 new) |
| 7 mutation checks (below) | — | all **killed**; originals restored byte for byte |
| `npm audit --omit=dev --audit-level=high` | 0 | 0 high/critical; the same 4 moderate as before |
| `npm audit` (full) | 1 | unchanged since Phase 1: 9 (4 moderate, 5 high) in dev tooling (`braces`, `esbuild`), accepted in the Phase 1 report |
| secret scan: 18 distinct local secrets over all 261 committable files | — | **0 hits** |
| `git add -A --dry-run` filtered for `.env`, `.local/`, credentials, keys, DLLs, build and report folders | — | **0** ignored paths would be added |
| relative-link check over `README.md` and `docs/**/*.md` | — | 0 broken (after this report was written) |
| `gitleaks`, `actionlint` | — | **BLOCKED** (not installed) |

### Acceptance criteria

| ID | Status | Evidence |
| --- | --- | --- |
| P5a-AC1 org settings | **PASS** | defaults from the migration; everyone reads `organization.profile`, only admins read and change settings; bad time zone, currency, scale, empty name, or an extra `currencyLockedAt` field → `VALIDATION_FAILED`; stale version → `CONFLICT`; audit before/after; a no-op writes nothing. After the first requisition, changing currency or scale → `CURRENCY_LOCKED`, while name and time zone still change. As the app role **and** the owner, changing the currency, scale, lock, or id → `PFO01`; DELETE and INSERT → `42501`. Race with the first requisition on 10 fresh databases: the requisition's currency always equals the locked org currency. |
| P5a-AC2 policy publishing | **PASS** | gaps (with the path `rules.1.minAmount`), a bounded top rule, empty steps, department-scoped finance, JSON numbers for amounts, and `purchase_order` → `VALIDATION_FAILED`; unknown or inactive departments → `UNKNOWN_DEPARTMENT`; v1 then v2: v2 active, v1 superseded, audited with version, name, and rule summaries; editing, un-superseding, adding rules or steps to a published policy → `PFP01` for app role and owner; deletes → `42501` / `PFP01`. 5 parallel publishes → versions 1 to 5, exactly one active. Unit: 6 validation tests (overlaps anywhere in the list, unbounded overlaps, per-department independence, start at 0, gaps, decimal equality of `1000` and `1000.0000`, step limits, 50-rule limit). |
| P5a-AC3 route resolution | **PASS** | unit: `[min, max)` at `0`, `999.99`, `999.9999`, `1000`, `1000.00`; department rule first, falling back to any-department rules in its gaps; no route → null. Integration: `resolveApprovalRoute` follows the active version (`499.99` → finance, `500` → approver, `1000` → approver + finance). |
| P5a-AC4 PR state machine | **PASS** | all 49 (status × command) pairs against the table in `docs/state-machines.md`; terminal states accept nothing; editable only in draft/returned; reason needed when withdrawing pending/approved |
| P5a-AC5 create and edit | **PASS** | `3 × 10.005 + 0.5 × 2.3333` → line totals `30.02` and `1.17`, total `31.19` (half-up at scale 2); number `PR-<year>-NNNNNN`, consecutive; department and name from the profile; audit with line summaries. 9 server fields sent by the client (total, line total, status, department id/code, currency, number, requester, ordered qty) and 12 malformed inputs (zero/negative/4-decimal quantity, JSON numbers, 5-decimal price, empty unit, 0 or 201 lines, invalid date, wrong date format, blank title) → `VALIDATION_FAILED`, nothing written; 200 lines accepted; huge amounts → `AMOUNT_TOO_LARGE`; no department → `NO_DEPARTMENT`; procurement, approver, admin → `FORBIDDEN`. Edit: total recomputed, audit before/after, stale version → `CONFLICT`, the same numbers spelled differently are a no-op; a requester-approver of OPS editing a colleague's PR → `FORBIDDEN`, an OPS requester → `NOT_FOUND`. |
| P5a-AC6 idempotent create | **PASS** | same key → the same result and no new row; same key with other input → `IDEMPOTENCY_KEY_REUSED`; another user's identical key is independent; a malformed key → `VALIDATION_FAILED`. **5 parallel creates with one key, 20 times**: one requisition each time, the same values for all five, numbers gapless. |
| P5a-AC7 visibility | **PASS** | requesters see their own; a department approver (and a requester who is also one) sees OPS but not FIN; an org-wide approver, procurement, finance, and auditor see all; someone else's PR by id → `NOT_FOUND`; admin and receiver → `FORBIDDEN`; filters by status, department, literal text (`%`, `_`, `'; drop table` → nothing); bad cursor, status, limit, lowercase code, extra field → `VALIDATION_FAILED`; DTO keys allowlisted and no user id anywhere in the payload |
| P5a-AC8 cancel draft | **PASS** | cancel with and without a reason, audited; again → `INVALID_TRANSITION`; edit after cancel → `INVALID_TRANSITION`; auditor → `FORBIDDEN`. Database: line insert/update/delete after cancel → `PFQ01`; number, requester, currency, department → `PFQ01` (app role and owner); delete → `42501`; `ordered_qty > quantity` → `23514` (PR-I1). |
| P5a-AC9 any-of permissions and matrix | **PASS** | runner unit test (each of two permissions passes, neither fails before any transaction, frozen copy, empty list refused); operation matrix: 34 operations × 9 callers, with the 11 new ones written from ADR 0006 |
| P5a-AC10 screens and E2E | **PASS** | E2E: an admin renames the organization, sees the currency locked, adds an OPS rule in the editor and publishes version 2, and a gap is shown under the rule and not published. Rina drafts a requisition with two lines, the preview and the server both show `$31.19`, edits it to `$41.19`, Bayu and Dewi see it read-only, and Rina cancels it. A receiver has no Requisitions link and gets "Access denied"; an unknown requisition id → HTTP 404. No CSP violations. One `h1` per page, every control labeled (requisition and admin pages). |
| P5a-AC11 seed | **PASS** | through the commands: organization name, policy "Standard approvals" published by Ada, one draft by Rina; second run creates nothing |
| P5a-AC12 documentation | **PASS** | ADR 0010 and 0008 amendments, `schema.md`, `api-contracts.md`, `state-machines.md`, `threat-model.md` (Phase 5a status), `architecture.md`, `user-stories.md`, `development.md`, `PLAN.md` (split), `README.md`, ADR index, this report |
| Definition of done | **PASS** | all checks above. Committed after maintainer approval (2026-10-23). |

### Mutation checks

Each mutation was applied to one file, the named tests were run, and the original was written back and compared byte for byte.

| Mutation | Tests run | Result |
| --- | --- | --- |
| M1: the first requisition does not lock the currency | `organization.test.ts` | **killed** (1 failed) |
| M2: department approvers see every requisition | `requisitions.test.ts` | **killed** (2 failed) |
| M3: an idempotency key with a different input is accepted | `requisitions.test.ts` | **killed** (1 failed) |
| M4: gaps in the any-department rules are accepted | `approval-policy.test.ts`, `organization.test.ts` | **killed** (4 failed) |
| M5: "any of" permissions require all of them | `permission-matrix.test.ts` | **killed** (2 failed) |
| M6: department rules no longer take priority | `approval-policy.test.ts` | **killed** (1 failed) |
| M7: policy publishing without the lock | `concurrency/requisitions.test.ts` | **killed** (1 failed) |

### Failures found and fixed during the phase

1. **I first compared money with `Number(...)`** in the edit no-op check, which ADR 0007 forbids. Replaced with decimal normalization at the currency scale before any test ran.
2. **The idempotency concurrency test reported two different answers.** The values were identical; only the key order differed, because a replayed response comes back from `jsonb`, which reorders keys. The test compared JSON strings; it now compares values.
3. **`toChoice()` was exported from a `'use client'` module and called on the server**, which Next.js refuses at runtime (caught by E2E). Moved, with the editor's other shared definitions, to a plain module.
4. **E2E client IPs above 255** (`10.x.y.310`) were not valid addresses, so the rate limiter saw one client and sign-ins hit 429. Renumbered, and `clientIp()` now refuses anything outside 1 to 254.
5. **A test helper map typed `Record<string, string>`** failed `noUncheckedIndexedAccess`; typed with explicit persona keys.
6. **Stale text on the home page** ("No procurement features are implemented yet", wrong since Phase 4) replaced with an accurate summary.

### Decisions

- **Runner "any of" permissions** (ADR 0010 amendment) instead of an umbrella read permission.
- **The currency lock is a timestamp set by the first monetary document** (requisitions may depend on organization, never the reverse), backed by a trigger.
- **Rules and steps are sealed to the publishing transaction** by a trigger comparing the policy's `created_at` with `now()` (the transaction start).
- **Finance steps are organization-wide only** (finance is not a department-scoped role).
- **Approver visibility is read fresh from role assignments** inside each query's transaction.
- **Requisition list filters:** status, department, and text now; the date-range filter in the original contract is not implemented yet (recorded in the contract).
- **Timestamps everywhere now use the organization time zone**, including the admin and supplier pages from earlier phases.

### Dependency changes

None. `package.json` and `package-lock.json` are identical to `e83e61c`.

### Files changed

New (42): `db/migrations/{0008_organization_and_requisitions.sql,0009_organization_and_requisitions_guards.sql,meta/0008_snapshot.json,meta/0009_snapshot.json}`, `src/modules/organization/{index.ts,domain/{approval-policy,settings}.ts,application/{approval-policies,settings}.ts,infrastructure/{schema,organization-repository}.ts}`, `src/modules/requisitions/{index.ts,domain/requisition.ts,application/{requisition-commands,requisition-input,requisition-queries,visibility}.ts,infrastructure/{schema,requisition-repository}.ts}`, `src/modules/identity/application/directory.ts`, `src/shared/db/idempotency.ts`, `src/server/organization-profile.ts`, `src/app/(app)/admin/{settings/page.tsx,approval-policy/page.tsx,_components/{settings-form,policy-editor}.tsx,_components/policy-choices.ts}`, `src/app/(app)/requisitions/{page.tsx,new/page.tsx,[id]/page.tsx,[id]/edit/page.tsx,actions.ts,_components/{requisition-form,cancel-form,requisition-status}.tsx}`, `tests/unit/{approval-policy,requisition-domain}.test.ts`, `tests/integration/{organization,requisitions}.test.ts`, `tests/concurrency/requisitions.test.ts`, `tests/e2e/requisitions.spec.ts`, this report.

Modified (31): `README.md`, `scripts/seed.ts`, `db/migrations/meta/_journal.json`, `src/shared/{application/runner.ts,db/tables.ts}`, `src/server/schema.ts`, `src/lib/format.ts`, `src/modules/identity/{index.ts,tables.ts,infrastructure/admin-repository.ts}`, `src/app/(app)/{layout.tsx,page.tsx}`, `src/app/(app)/admin/{actions.ts,layout.tsx,users/[id]/page.tsx}`, `src/app/(app)/suppliers/[id]/page.tsx`, `tests/unit/runner.test.ts`, `tests/integration/permission-matrix.test.ts`, `tests/support/actors.ts`, `tests/e2e/support.ts`, docs (`PLAN.md`, `adr/0008`, `adr/0010`, `adr/README.md`, `api-contracts.md`, `architecture.md`, `development.md`, `schema.md`, `state-machines.md`, `threat-model.md`, `user-stories.md`).

Local only: the development database got migrations 0008–0009, the organization name "Example Organization", the default policy, and Rina's demo draft (which locked the currency at USD 2).

### Known limitations / not verified

- **CI has never run** (no remote). **gitleaks and actionlint: BLOCKED.**
- **Nothing can be submitted for approval yet** (Phase 5b). The policy editor publishes rules that no requisition uses until then.
- **Idempotency keys never expire**; a purge job is a Phase 10 item.
- The requisition list has no date-range filter yet, and no department filter control on the screen (the query supports it).
- The policy editor only handles requisitions; purchase-order policies come with Phase 7.
- Accessibility: basics only (labels, one `h1`); no screen-reader pass; only Edge tested. The line editor is a set of inputs per line, not a data grid.
- The preview total in the form uses the shared pricing function client-side; it is display only and the server recomputes (ADR 0007), but it adds decimal.js to the page bundle.
- Two uncovered lines remain in domain/application code (defensive branches for unknown statuses).

### Threat-model updates

T-01, T-02, I-01 verified for requisitions; E-03 partly (policies immutable and audited; frozen steps in 5b); currency lock; double submission. See `docs/threat-model.md`, "Phase 5a status".

### Next steps

1. Done: maintainer review, then committed (no push; there is no remote).
2. Phase 5b: submission (`NO_APPROVAL_ROUTE`, frozen steps, rounds), the approvals module and its outcome port, inbox, decide (approve/reject/return), history, SOD-01 trigger, SOD-02 index, CC-01, CC-02, and the golden-path E2E (Rina → Bayu → Sari).
