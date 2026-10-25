## Phase 5b report: Submission and multi-step approvals

- Date: 2026-10-25
- Base commit: `2fd99d5` (Phase 5a). Phase 5b is committed as a single commit on top of it (2026-10-25, after maintainer approval), together with this report. Not pushed: there is no remote.
- Machine: Windows 10 Enterprise 19045, Node 24.21.0, npm 11.19.0, local PostgreSQL 18.6, Microsoft Edge (Playwright `msedge` channel)
- Maintainer decisions (2026-10-25):
  1. The Phase 5b scope (submit with a frozen route, approval requests and steps, inbox, decide, history, SOD-01/02 backstops, CC-01/CC-02, withdraw/cancel/close, golden-path E2E) was approved, with the criteria P5b-AC1 to AC14 below.
  2. After the first verification found a new high advisory in `zod` 4.6.5: **pin `zod` 4.6.7**, then re-run the full verification.
  3. Commit Phase 5b as one commit, without ignored files; do not push.

Status vocabulary: **Implemented**, **Tested**, **Verified** (run here, output observed). Nothing is **Deployed**.

### What Phase 5b adds (all implemented, tested, verified locally)

| Area | Where |
| --- | --- |
| Approvals module: pure step and request machines, eligibility (role + scope), SoD rules; open a round at submit (AP-T01), cancel it on withdrawal (AP-T05), `approval.decide` (AP-T02 to T04), `approval.inbox`, history | `src/modules/approvals/**` |
| Document port: approvals never imports requisitions; the requisition handler (lock, PR-T04 to T06) is registered by the composition root | `src/modules/approvals/application/document-port.ts`, `src/modules/requisitions/application/approval-document.ts`, `src/server/approvals.ts` |
| Requisitions: `requisition.submit` (PR-T03), `requisition.cancel` for every state (PR-T07 to T09, any of `requisition.create` / `po.create`), `requisition.close` (PR-T10); `requisition.get` returns history, the caller's open decision, and the actions they can use | `src/modules/requisitions/application/*` |
| Identity: `findRoleScope(user, role)` (fresh role scopes for eligibility) | `src/modules/identity/application/directory.ts` |
| Tables `approval_requests`, `approval_steps`; approval and close columns on `purchase_requisitions` with CHECKs; grants (no DELETE); triggers `approval_requests_guard`, `approval_steps_guard`, `approval_steps_no_self_approval` (`PFD01`) | `db/migrations/0010` (generated), `0011` (hand-written) |
| Screens: Submit for approval, the decision form (approve / return for changes / reject, with comment), withdraw, cancel after approval, close, approval history per round; **Approvals** inbox and nav link | `src/app/(app)/requisitions/**`, `src/app/(app)/approvals/page.tsx` |
| Seed: one more requisition by Rina, submitted, waiting for Bayu then Sari | `scripts/seed.ts` |

Decisions taken within the approved scope (please review):
1. **Snapshot columns.** Besides the schema design, an approval request also freezes the document number, title, currency, and policy version, so the inbox and history show what the approvers were asked to approve. Steps record `activated_at` (when they opened), for the inbox order and the later approval-aging report.
2. **History lives in the document.** `requisition.get` returns `approvalHistory` after its own visibility check; there is no separate `approval.history` query (the API contract is updated).
3. **New business-rule codes** for PR-T03 and PR-T09 guards the design left unnamed: `ZERO_TOTAL`, `NEEDED_BY_IN_PAST`, `ALREADY_ORDERED`.
4. **Order of checks in `approval.decide`:** state before version, so of two approvers clicking at once the second is told "already decided" (US-AP-02) instead of a generic conflict.
5. **One decision form, on the requisition page.** The inbox links there; the form is three radio choices plus one button, and the comment is required for return and reject.
6. **Inbox paging:** the 50 oldest open steps, with a `more` flag; no cursor yet.

### Commands run (exact) and results

Two full runs on 2026-10-25, with `NEXT_TELEMETRY_DISABLED=1`: the first with `zod` 4.6.5 (`scratchpad/verify5b/run.sh`), the second, final one after pinning `zod` 4.6.7 (`scratchpad/verify5b-2/run.sh`, starting from `npm ci`). Both runs gave the same results everywhere except the audit rows; the table shows the final run, and the first run's audit result is kept as its own row.

| Command | Exit | Result |
| --- | --- | --- |
| `npx drizzle-kit generate --name=approvals_and_submission` | 0 | `0010`: 2 tables, 6 new requisition columns, CHECKs, FKs, indexes (reviewed; additive only) |
| `npx drizzle-kit generate --custom --name=approvals_guards_and_grants` | 0 | `0011`: grants, 3 trigger functions (hand-written) |
| `npm run db:migrate` | 0 | applied to `procureflow_dev` (existing drafts satisfy the new CHECKs); no-op in the final run |
| `npm run seed` (twice) | 0 / 0 | 1st: 1 requisition created and submitted. 2nd: nothing created (idempotent) |
| `npm install zod@4.6.7` (`save-exact`, `ignore-scripts` from `.npmrc`) | 0 | `package.json` `4.6.5` → `4.6.7`; `package-lock.json`: only the `zod` entry (4 lines), integrity equals `npm view zod@4.6.7 dist.integrity`; `npm ls zod`: one deduplicated copy for ProcureFlow, Better Auth, and better-call |
| `git diff --stat HEAD -- package.json package-lock.json` | 0 | 2 files, 5 lines: the `zod` pin only |
| `npm ci` | 0 | 597 packages installed from the lockfile |
| `npm run lint` | 0 | no findings (module boundaries included) |
| `npm run typecheck` | 0 | no errors |
| `npm run test:unit` | 0 | 14 files, **485 passed** (was 423): approval machines and rules 62 |
| `npm run test:integration` | 0 | 19 files, **216 passed** (was 183): approvals 26, concurrency 3, permission matrix +4 operations |
| `npm run test:coverage` | 0 | **701 passed**. Thresholds met. Domain/application scope **866/870 lines (99.54%)**; every new approvals file 100% of lines except `domain/approval.ts` 97.22% |
| `rm -rf .next && npm run build` | 0 | **0 warnings**; new route `/approvals` |
| `npx playwright test` (twice, back to back) | 0 / 0 | **31 passed** both times (28 earlier + 3 new) |
| 12 mutation checks (below), run after each verification | — | all **killed** both times; originals restored byte for byte, `git diff --stat` identical before and after |
| `npm audit --omit=dev --audit-level=high`, first run (`zod` 4.6.5) | 1 | **1 high: `zod` < 4.6.6, GHSA-mrhx-c7xc-m3w5** (new advisory, see "Resolved finding"), plus the 4 moderate below |
| `npm audit --omit=dev --audit-level=high`, final run (`zod` 4.6.7) | **0** | **0 high/critical**; the same 4 moderate as in Phase 5a (`esbuild` ≤ 0.24.2 via `@esbuild-kit/*` in `drizzle-kit`) |
| `npm audit` (full), final run | 1 | 4 moderate, the same chain; exit 1 because npm audit fails on any finding. The dev-tooling advisories accepted in Phase 1 (`braces`, older `esbuild`) are no longer reported |
| secret scan: 18 distinct local secrets over all 287 committable files | — | **0 hits** |
| `git add -A --dry-run` filtered for `.env`, `.local/`, credentials, keys, DLLs, build, coverage, and report folders | — | **0** ignored paths would be added |
| relative-link check over `README.md` and `docs/**/*.md` | — | 0 broken |
| `gitleaks`, `actionlint` | — | **BLOCKED** (not installed) |

### Acceptance criteria

| ID | Status | Evidence |
| --- | --- | --- |
| P5b-AC1 machines | **PASS** | `tests/unit/approval-domain.test.ts`: all 30 (step status × event) and 20 (request status × event) pairs against tables written from docs/state-machines.md §2; decided steps accept nothing; route application (open next step, last step approves, reject/return cancel later steps, withdrawal cancels open steps only, unsorted input, inconsistent route throws); eligibility and SoD rules. The PR machine stays covered by the 49-pair test from 5a. |
| P5b-AC2 submit | **PASS** | `approvals.test.ts` "submitting": without a policy `NO_APPROVAL_ROUTE` and nothing created; round 1 freezes amount `30.0200`, department, number, title, currency, policy version, submitter; step 1 pending with its scope; from 1,000 two steps; lines read-only after submit (`INVALID_TRANSITION`, trigger `PFQ01`); `ZERO_TOTAL`; `NEEDED_BY_IN_PAST` at 20:00 UTC on the due date with the org in Asia/Jakarta, accepted in UTC; FORBIDDEN / NOT_FOUND / CONFLICT / tampered fields / submit twice / cancelled; audit `approval.requested` and `requisition.submitted` with the route. |
| P5b-AC3 decide | **PASS** | approve only step → requisition approved with audit and history; reject/return need a comment (missing, empty, blank, 2001 characters), stored trimmed, audited as the reason; invisible approver and unknown request or step → `NOT_FOUND`; finance on an approver step, approvers on a finance step → `NOT_ELIGIBLE_APPROVER`; waiting step → `INVALID_TRANSITION`; a role revoked after the session was resolved no longer counts; stale version → `CONFLICT`; decided step and completed request → `INVALID_TRANSITION`. |
| P5b-AC4 SOD-01 | **PASS** | a requester holding `approver` for OPS cannot approve or reject their own (`SELF_APPROVAL`), it is not in their inbox, and Bayu sees it; a direct `UPDATE approval_steps` deciding as the submitter → `PFD01` as the app role **and** the owner. |
| P5b-AC5 SOD-02 | **PASS** | a user holding approver (OPS) and finance approves step 1, then step 2 → `DUPLICATE_APPROVER`; step 2 leaves their inbox but stays in Sari's; a direct write → `23505` (unique index). |
| P5b-AC6 multi-step | **PASS** | 3-step route (OPS approver, org-wide approver, finance): pending after steps 1 and 2, approved after 3, versions 2 → 4; an OPS approver cannot take the org-wide step; reject at step 2 → steps `approved, rejected, cancelled`, requisition rejected and terminal; return at step 2 → editable again, round 2 with a new request, steps from 1, new amount `60.0400`, the same approver may decide step 1 again; history shows both rounds with the return comment. |
| P5b-AC7 frozen route | **PASS** | submitted under v(n), v(n+1) published as "finance only": the in-flight request keeps its single approver step (finance gets `NOT_ELIGIBLE_APPROVER`, Bayu approves); a new submission gets the finance step and v(n+1). |
| P5b-AC8 withdraw / cancel / close | **PASS** | withdraw without reason → `VALIDATION_FAILED` on `reason`; procurement and approvers cannot withdraw (`FORBIDDEN`); withdrawal cancels the request and both steps, audited `approval.cancelled`, leaves the inbox, a later decision → `INVALID_TRANSITION`; approved requisitions cancelled by the requester and by procurement, with a reason only, auditor `FORBIDDEN`; `ALREADY_ORDERED` with an ordered quantity (set directly; purchase orders are Phase 7); close: pending → `INVALID_TRANSITION`, no or blank reason → `VALIDATION_FAILED`, stale → `CONFLICT`, closed with reason and audit, closing again → `INVALID_TRANSITION`. |
| P5b-AC9 inbox and history | **PASS** | OPS approver sees OPS steps only, Sales approver Sales only, org-wide approver both; finance sees step 2 only once open; after a decision the step leaves both OPS approvers' inboxes; item fields and key allowlist; oldest first; `limit` 1 with `more`; `limit` 101 and unknown fields refused. History identical for requester, approver, finance, procurement, auditor; others `NOT_FOUND`; DTO key allowlists for detail, rounds, steps, open decision; no user ids in the payload; the auditor gets no decision and no actions. |
| P5b-AC10 concurrency | **PASS** | `tests/concurrency/approvals.test.ts`, every race forced (a third connection holds the requisition until all contenders wait): CC-01, 2 to 10 approvers × 20: one success, one decider, one audit row, consistent states; CC-02 × 20, alternating order: one success, the other `CONFLICT`, both outcomes seen, no lost update; withdrawal vs last approval × 20: one wins, never a deadlock. |
| P5b-AC11 matrix, DTOs, audit | **PASS** | permission matrix: 38 operations (new: `requisition.submit` requester, `requisition.cancel` requester + procurement, `requisition.close` procurement, `approval.decide` and `approval.inbox` approver + finance); allowlists above; audit events asserted for every transition (`requisition.submitted/approved/rejected/returned/cancelled/closed`, `approval.requested/decided/cancelled`). |
| P5b-AC12 database backstops | **PASS** | snapshot changes (amount, submitter, title, round) → `PFD01` for app role and owner; deletes → `42501` (app) / `PFD01` (owner); a second pending request for one document → `23505`; reopening or touching a completed request → `PFD01`; route changes, skipping `waiting → approved`, adding a step later, moving `approved → pending`, changing `activated_at` → `PFD01`; reject without comment → `23514`; requisition status without its approval columns → `23514`. |
| P5b-AC13 screens | **PASS** | `tests/e2e/approvals.spec.ts`: golden path (Rina submits 1,200; Bayu finds it in **Approvals**, step "1 of 2: Approver for OPS", approves; it leaves his inbox; Sari approves step 2; Rina sees *Approved* and a history with both names and Sari's comment; Dewi closes it after a missing-reason error); return with a required comment, edit, resubmit (round 2 shown above round 1), approval; withdrawal needs a reason and removes it from Bayu's inbox; a requester has no inbox link and gets *Access denied*; `/approvals` and the requisition page with the decision form have one h1 and only labeled controls; no CSP violations. |
| P5b-AC14 definition of done | **PASS** | command table above (final run after the `zod` pin). `npm audit --audit-level=high` reports nothing for production dependencies; `gitleaks` and CI stay BLOCKED as in every phase. |

**Mutation checks** (`scratchpad/mut/run5b.mjs`: apply one change, run the named tests, restore, compare bytes):

| # | Mutation | Result |
| --- | --- | --- |
| M1 | SOD-01 no longer checked in the application | killed (2 tests: the trigger then turns it into `INTERNAL`) |
| M2 | SOD-01 trigger stops checking the submitter | killed (direct-SQL test) |
| M3 | SOD-02 no longer checked in the application | killed (the unique index turns it into `CONFLICT`) |
| M4 | step scope ignored | killed (3 tests) |
| M5 | approving a step does not open the next one | killed (12 tests) |
| M6 | withdrawal leaves the approval request open | killed |
| M7 | the decision does not lock the requisition first (lock order C8) | killed: the withdrawal race deadlocks (`40P01`, "The action conflicted with another change"), which the test now tells apart from a version conflict. CC-01 also fails, but for a technical reason (it waits for every contender to queue on the requisition row). |
| M8 | needed-by compared in UTC instead of the org time zone | killed |
| M9 | inbox lists steps barred by SOD-02 | killed |
| M10 | a completed request can be reopened in the database | killed |
| M11 | a stale request version accepted | killed |
| M12 | role scopes taken from the session instead of read fresh | killed (revocation test) |

### Resolved finding: `zod` advisory GHSA-mrhx-c7xc-m3w5 (high)

- Published 2026-10-01 (updated 2026-10-23), after the Phase 5a audit. Zod below 4.6.6 can use unbounded memory when a large array fails validation element by element (CWE-770, denial of service). ProcureFlow pinned `zod` 4.6.5 until this change; Better Auth uses the same copy.
- Exposure here: every command validates input with Zod, including line arrays from Server Actions. Next.js limits a Server Action body to 1 MB by default, which bounds the input, but the advisory names no workaround besides upgrading.
- Fixed in `zod` 4.6.6 (released 2026-10-11); 4.6.7 (2026-10-12) is the newest patch, 13 days public, so it meets the 7-day rule (ADR 0011). The first verification run reported the finding; the maintainer chose to pin 4.6.7. After the pin, the production audit reports no high or critical finding, and the whole suite passes unchanged (same test counts, coverage, E2E, and mutation results).

### Failures and how they were resolved

1. `requisition.get` failed with `INTERNAL` ("relation counted does not exist"): a Drizzle alias was used inside a raw SQL subquery for the step count. Rewritten as plain SQL with its own alias.
2. node-postgres warned about overlapping queries on one transaction client (`Promise.all` on the same `tx`, which pg@9 will reject). The pattern also existed in Phase 5a code (`requisition.get`, `admin.approvalPolicy.getActive`); all such calls now run one after another.
3. Integration tests cascaded after one failure, because a test that publishes another policy had not restored the standard one. Each group now publishes the policy it needs, and version numbers are taken from the publish result, not hard-coded.
4. E2E: a URL comparison included `?notice=…`; and `requisitions.spec.ts` (running in parallel) may publish an OPS rule for 0 to 500 that routes to finance. Single-step cases now use amounts between 500 and 1,000, where every policy version routes to the OPS approver (commented in the spec).
5. M7 first passed through the race test for the wrong reason: a deadlock is also reported as `CONFLICT`. The test now asserts which loser gets which message.
6. Patch scripts written through shell heredocs failed on quoting; they were written as files instead (no repository damage; `git diff` reviewed).
7. The first full verification failed the production audit gate on a new `zod` advisory (no dependency had changed). Resolved by pinning `zod` 4.6.7 on the maintainer's decision and re-running everything from `npm ci`.

### Files changed

- New: `src/modules/approvals/**` (domain, application, infrastructure, `tables.ts`, `index.ts`), `src/modules/organization/tables.ts`, `src/modules/requisitions/application/approval-document.ts`, `src/server/approvals.ts`, `src/app/(app)/approvals/page.tsx`, `src/app/(app)/requisitions/_components/{approval-history,workflow-forms}.tsx`, migrations `0010`, `0011` with snapshots, tests `tests/unit/approval-domain.test.ts`, `tests/integration/approvals.test.ts`, `tests/concurrency/approvals.test.ts`, `tests/e2e/approvals.spec.ts`, this report.
- Changed: `package.json` and `package-lock.json` (`zod` pin), requisitions (schema, repository, commands, input, queries, index), identity (role-scope lookup), organization (sequential queries), `src/server/schema.ts`, requisition pages, actions, and components, nav and home page, seed, permission matrix, migration journal, docs (state machines, schema, API contracts, architecture, ADR 0006 and 0008 implementation notes, ADR index, threat model, user stories, PLAN, development, README).

### Dependency changes

| Name | From | To | Published | Checked | Why |
| --- | --- | --- | --- | --- | --- |
| `zod` | 4.6.5 | **4.6.7** | 2026-10-12 | `npm view zod time` and `dist.integrity` on 2026-10-25 | GHSA-mrhx-c7xc-m3w5 (high, fixed in 4.6.6); newest patch, older than 7 days. No install scripts (and `ignore-scripts=true`). Better Auth (`^4.5.4`) and better-call (`^4.0.0`) accept it, so one copy is used. |

### Known limitations / not verified

- **Not verified:** CI (no remote), `gitleaks`, `actionlint` (not installed).
- The inbox shows the 50 oldest open steps, with no cursor yet. There are no notifications: approvers must open their inbox.
- A step nobody is eligible for stays pending; nothing is skipped (the approval-aging report is Phase 9).
- `ALREADY_ORDERED` is tested by setting an ordered quantity directly; purchase orders arrive in Phase 7. SOD-06 (`awarded_by_user_id`) is in the application rule and the trigger, but stays NULL until then.
- The E2E single-step cases depend on the amount band chosen around the parallel 5a spec's policy change (documented in the spec).

### Threat-model updates

`docs/threat-model.md`, new "Phase 5b status": AB-01 and AB-02 controlled (app + trigger / unique index); E-03 in-flight snapshot; T-02 after submit; T-04 races; I-01 for decisions, inbox, and history; R-01 audit; approval history tamper-resistant in the database; residual: steps with no eligible approver, no notifications.

### Next steps

1. Phase 6: sourcing (RFQ, quotations, comparison, award), with the `rfq_required_above` and `min_quotes` settings.
