## Phase 3b report: Administration (users, roles, departments)

- Date: 2026-10-22
- Base commit: `4d7bc10` (Phase 3a). Phase 3b is committed as a single commit on top of it (2026-10-22, after maintainer approval), together with this report. Not pushed: there is no remote.
- Machine: Windows 10 Enterprise 19045, Node 24.21.0, npm 11.19.0, local PostgreSQL 18.6, Microsoft Edge (Playwright `msedge` channel)
- Maintainer decisions for this phase (2026-10-22):
  1. **Org settings are deferred** to the phases that use them (5–8), so no setting exists before it has an effect.
  2. **New setup links only before the first password**, so an admin cannot take over an account in use.
  3. **Admins can edit a user's name and home department** (`admin.user.update`, new in the API contract).
  4. The plan with P3b-AC1 to AC14 was approved as presented.

Status vocabulary: **Implemented**, **Tested**, **Verified** (run here, output observed). Nothing is **Deployed**.

### What Phase 3b adds (all implemented, tested, verified locally)

| Area | Where |
| --- | --- |
| Commands: `admin.user.{create,update,deactivate,reactivate,issueSetupLink}`, `admin.role.{grant,revoke}`, `admin.department.{create,update}` | `src/modules/identity/application/admin-{users,roles,departments}.ts` |
| Queries: `admin.user.list` (status filter, cursor), `admin.user.get` (with role history), `admin.department.list`, all with DTO allowlists | `src/modules/identity/application/admin-user-queries.ts`, `admin-departments.ts` |
| SOD-05 and `LAST_ADMIN`: admin-set lock (`pg_advisory_xact_lock`) taken first, caller re-checked under it (ADR 0008 amendment C9) | `application/admin-guards.ts`, `infrastructure/admin-repository.ts` |
| Deactivation deletes all sessions and unused setup links in the same transaction | `admin-users.ts`, `admin-repository.ts` |
| Deactivated users get no session at sign-in (same 401 as a wrong password), audited `auth.signInRejected` | `src/server/auth.ts`, `src/server/auth-audit.ts` |
| Setup links: rule check + audit in one transaction, then the Better Auth token | `src/server/admin-links.ts` |
| Migration `0005`: CHECK `user_profiles_not_self_deactivated`, trigger `role_assignments_revocation_only` (`PFR01`) | `db/migrations/0005_identity_admin_guards.sql` (generated CHECK + hand-written trigger) |
| Admin UI: Users (list, filter, pages), New user (one-time link shown once, copy button), User detail (profile, access, setup link, roles + history), Departments | `src/app/(app)/admin/**` |
| Runner-backed Server Actions (thin adapters, minimal results) | `src/app/(app)/admin/actions.ts`, `action-state.ts` |
| E2E runs on its own database `pf_e2e`, recreated each run | `scripts/e2e-db.ts`, `scripts/lib/e2e-database.ts`, `playwright.config.ts` |

### Commands run (exact) and results

Final run on 2026-10-22, with `NEXT_TELEMETRY_DISABLED=1` for Next.js commands.

| Command | Exit | Result |
| --- | --- | --- |
| `npx drizzle-kit generate --name=identity_admin_guards` | 0 | `0005` with the CHECK; trigger appended by hand after a `statement-breakpoint` |
| `npm run db:migrate` | 0 | applied to `procureflow_dev` (and again in the final run: no-op) |
| `npx shadcn@4.21.4 add table badge textarea --yes` | 0 | 3 components. It again added `cn@0.5.0` to `package.json`; **reverted** (files restored from a copy taken just before, `npm prune --ignore-scripts` removed the package, imports changed to `@/lib/utils`) |
| `git diff --quiet HEAD -- package.json package-lock.json` | 0 | **no dependency changes** in this phase |
| `npm run lint` | 0 | no findings |
| `npm run typecheck` | 0 | no errors |
| `npm run test:unit` | 0 | 10 files, **299 passed** (unchanged) |
| `npm run test:integration` | 0 | 12 files, **116 passed** (was 79): `admin.test.ts` 21, `permission-matrix.test.ts` 14, `concurrency/admin-set.test.ts` 2 |
| `npm run test:coverage` | 0 | **415 passed**. Thresholds met. Domain/application scope **339/341 lines (99.41%)**; all `src` 62.51% (UI and `src/server` are covered by E2E, which Vitest does not measure) |
| `rm -rf .next && npm run build` | 0 | **0 warnings**. New dynamic routes `/admin`, `/admin/users`, `/admin/users/new`, `/admin/users/[id]`, `/admin/departments` |
| `npx playwright test` (twice back to back, then once more after the last UI change) | 0 / 0 / 0 | **21 passed** every time (16 from Phase 3a + 5 new). Each run recreated `pf_e2e` and seeded 7 E2E users into it. The last change (department rows keyed by id, so the "saved" message stays visible) was followed by lint, typecheck, and a clean build, all exit 0 with 0 warnings. |
| 4 mutation checks + 1 experiment (below) | — | all mutations **killed**; files restored and re-verified |
| secret scan: 18 distinct local secrets (3 DB passwords, auth secret, 7 seed + 7 E2E passwords) over all 189 committable files | — | **0 hits** |
| `git add -A --dry-run` filtered for `.env`, `.local/`, credentials, keys, DLLs, build and report folders | — | **0** ignored paths would be added |
| relative-link check over `README.md` and `docs/**/*.md` | — | 0 broken (after this report was written) |
| `npm audit --omit=dev --audit-level=high` | 1 | **NOT VERIFIED today: network timeout** to `registry.npmjs.org` (`audit endpoint returned an error`). The dependency tree is byte-identical to `4d7bc10`, where this check exited 0 (0 high/critical). |
| `npm audit` (full) | — | **NOT VERIFIED today**: no response from the registry after about 8 minutes, so I stopped it. Same network problem; same unchanged tree (it reported only the known dev-tooling advisories at `4d7bc10`). |
| `gitleaks`, `actionlint` | — | **BLOCKED** (not installed) |

### Acceptance criteria

| ID | Status | Evidence |
| --- | --- | --- |
| P3b-AC1 create user + one-time link | **PASS** | `admin.test.ts`: user, profile, scoped roles; `user.provisioned` + 2 × `role.granted` by the admin; link expires in 24 h, works once; the token appears nowhere in `audit_events`. `EMAIL_TAKEN` (any case), `UNKNOWN_DEPARTMENT` (unknown and inactive), `ROLE_NOT_SCOPABLE`, with no rows written. 7 tampered inputs (unknown fields, `id`, fake role, `grantedBy`, duplicate role, bad email, blank name) → `VALIDATION_FAILED`. Anonymous → `UNAUTHENTICATED`. E2E golden path. |
| P3b-AC2 edit user | **PASS** | name and department change, version +1, `user.updated` with before/after; stale version → `CONFLICT`; no-op writes nothing; inactive new department → `UNKNOWN_DEPARTMENT`; self → `SELF_ADMINISTRATION`; unknown → `NOT_FOUND`; `email` field → `VALIDATION_FAILED` |
| P3b-AC3 deactivation revokes sessions and links | **PASS** | two live sessions: `revokedSessions: 2`, both cookies get no session, 0 session rows, actor null; audit has reason and counts; unused link stops working (400); again → `INVALID_TRANSITION`; blank reason → `VALIDATION_FAILED`; stale version → `CONFLICT`; self → `SELF_ADMINISTRATION`. E2E: the user's next page load goes to sign-in. |
| P3b-AC4 deactivated sign-in refused; reactivation | **PASS** | correct password of a deactivated user: same status and body as a wrong password, no cookie, no session row, `auth.signInRejected` and no `auth.signedIn`; reactivate with stale version → `CONFLICT`, then OK (`user.reactivated`), sign-in works again; reactivate an active user → `INVALID_TRANSITION`. E2E: sign-in shows "Invalid email or password." |
| P3b-AC5 links only before first password | **PASS** | second link invalidates the first (`invalidatedSetupLinks: [null, 1]`), second works; then `PASSWORD_ALREADY_SET`; self → `SELF_ADMINISTRATION`; unknown → `NOT_FOUND`; extra field → `VALIDATION_FAILED`; deactivated → `USER_DEACTIVATED` |
| P3b-AC6 grant / revoke | **PASS** | scoped grant takes effect on the next `resolveActor`; same role in another department allowed; same scope → `ROLE_ALREADY_ASSIGNED`; revoke keeps the row with `revoked_by` and reason; history shows active then revoked; revoke again → `INVALID_TRANSITION`; regrant after revoke works; `ROLE_NOT_SCOPABLE`, `UNKNOWN_DEPARTMENT`, fake role, `grantedBy` tamper, `NOT_FOUND` (user, assignment), blank reason, `USER_DEACTIVATED`. E2E: revoking shows on the user's next page load. |
| P3b-AC7 SOD-05 + LAST_ADMIN | **PASS** | all 6 self-commands → `SELF_ADMINISTRATION`; as the app role, self-grant, self-revoke, and self-deactivation are each rejected by a CHECK (`23514`); the guard refuses to remove the only admin (`LAST_ADMIN`); a request authorized before its caller lost admin is refused under the lock (`FORBIDDEN`). **CC-08**: negative control (plain SQL, both commit) leaves **0 admins**; with the commands, 20 forced overlaps over 3 combinations: exactly one succeeds every time and exactly 1 admin remains. |
| P3b-AC8 assignments immutable except one revocation | **PASS** | as the app role **and** the owner: changing `role`, `granted_by`, `granted_at`, `user_id` → `PFR01`; after revocation, rewriting the reason or un-revoking → `PFR01`; `DELETE` → `42501` |
| P3b-AC9 departments | **PASS** | create (`department.created`), `DEPARTMENT_CODE_TAKEN`, 4 malformed codes → `VALIDATION_FAILED`; update name + deactivate (version 2, audited), stale → `CONFLICT`, `code` in update → `VALIDATION_FAILED`, no-op writes nothing, `NOT_FOUND`; inactive code refused for a new user; list keys = `DEPARTMENT_DTO_KEYS` |
| P3b-AC10 permission matrix | **PASS** | `permission-matrix.test.ts`: the registry equals the hand-written table (13 operations) and equals the operations exported by all modules (`import.meta.glob`); each operation × 7 roles + no role + anonymous gives exactly the expected allow / `FORBIDDEN` / `UNAUTHENTICATED` (117 cells) |
| P3b-AC11 Server Actions do not rely on pages | **PASS** | E2E captures the browser's real `admin.department.create` POST (aborted before it reaches the server), then replays it: no cookie → `307` to sign-in (proxy); forged cookie → `UNAUTHENTICATED` from the runner; requester session → `FORBIDDEN`; admin from `https://evil.example` → aborted by Next.js (≥ 400); the admin's own replay → created once (positive control). Server log shows `command.denied` for both refusals. Non-admins see no Admin link and get "Access denied" on all admin URLs, with no email addresses on the page. |
| P3b-AC12 strict inputs and allowlisted outputs | **PASS** | every new command has an unknown/tampered-field test (above); `admin.user.list` paged with `limit: 2` through all users (sorted, no duplicates, count matches), keys = `ADMIN_USER_SUMMARY_KEYS`; `admin.user.get` keys = `ADMIN_USER_DETAIL_KEYS`, assignments = `ADMIN_ASSIGNMENT_KEYS`; the user's session tokens and password hash appear nowhere in the serialized results; no `password`/`hash`/`token`/`session*` keys; bad cursors, `limit: 101`, `status: 'pending'` → `VALIDATION_FAILED` |
| P3b-AC13 E2E admin flow on a separate database | **PASS** | admin creates a user → copies the link → user sets a password in their own browser → signs in → sees "Requester · OPS" → link fails a second time → admin revokes → user sees no roles → admin deactivates → user is sent to sign-in and cannot sign in. Own account: no deactivate/revoke controls. Basic accessibility: one `h1` per admin page, every visible form control labeled, keyboard Enter activates "New user", no CSP violations. All of it runs against `pf_e2e`. |
| P3b-AC14 documentation | **PASS** | `schema.md` repaired (below) and updated (0005, set lock, org settings deferred); `api-contracts.md` (new commands, rules, audit names, `PFR01`, idempotency note); `state-machines.md` §7 user account; `threat-model.md` Phase 3b status; ADR 0008 amendment C9 + CC-08; `PLAN.md` (3b scope, org settings moved to Phases 5–8); `user-stories.md`; `development.md`; `README.md`; this report |
| Definition of done | **PASS, except the network-dependent audit** | all checks above. Committed after maintainer approval (2026-10-22). |

### Mutation checks (do the new tests catch real breakage?)

Each mutation was applied to one file, the named test file was run, and the original was restored from a copy and re-verified (`grep` for the original line, then the test passes again).

| Mutation | Test run | Result |
| --- | --- | --- |
| M1: deactivation no longer deletes sessions | `admin.test.ts` | **killed** (1 failed) |
| M2: deactivated users may sign in again | `admin.test.ts` | **killed** (1 failed) |
| M3: no re-check of the caller under the lock | `admin.test.ts` | **killed** (1 failed) |
| M4: no admin-set lock | `concurrency/admin-set.test.ts` | **killed**, but only because the test waits for lock waiters that never appear |
| M4b (experiment): no lock, and the test does not wait | `concurrency/admin-set.test.ts` | **both removals succeeded on the first iteration** (0 admins left): the lock is what keeps the invariant |

### Failures found and fixed during the phase

1. **`docs/schema.md` was corrupted in commit `4d7bc10`** (found while inspecting): rewriting the identity section with JavaScript's `String.replace` treated `$'` inside the regex `'^[A-Z0-9-]{2,16}$'` as a replacement pattern, which cut one line and pasted the rest of the file into it (287 → 530 lines, 243 duplicated lines). Repaired by rejoining the cut line and deleting the duplicate, which was verified to be byte-identical to the real remainder before removal. Edits in this phase use split/join or the Edit tool, never `replace` with `$` in the text.
2. **Deactivated users could still create a session** (found while inspecting): Better Auth signed them in and the app then bounced them to sign-in, and the audit log recorded a successful sign-in. Now refused in the session hook before any session exists.
3. **shadcn CLI added `cn@0.5.0` again** (5 days old, not an approved dependency): reverted as in Phase 3a.
4. **The permission-matrix setup hit the `/reset-password` rate limit (429)**: it now provisions users without passwords. The matrix only needs real role assignments, and the rate limit stays as it is.
5. **The new self-deactivation CHECK broke a Phase 3a test**: P3a-AC5 set up a deactivated profile with raw SQL using the user's own id as `deactivated_by`. The test now uses another user's id. What it proves is unchanged (a deactivated profile is refused even with a live session row); no check was relaxed.
6. **Lint (`no-html-link-for-pages`)**: "Create another user" used a plain link to reload the page; it now remounts the form instead.
7. **The first anonymous E2E replay only exercised the proxy**, because without a cookie `proxy.ts` redirects before any action code runs. Added the forged-cookie replay, which passes the proxy and is refused by the runner itself.
8. **The CC-08 negative control first rolled back**, so it showed less than it claimed. It now commits both transactions and asserts that zero admins remain, then restores them.

### Decisions

- **ADR 0008 amended (C9):** a database advisory lock for set-level invariants, taken first, held to commit, bounded by `lock_timeout`; the caller is re-resolved under it.
- **Two-step setup links:** the command (rules, invalidating old links, audit) commits first; then Better Auth creates the token, because it writes through its own connection and must see the committed user. ADR 0014's choice (Better Auth's own reset flow, no hand-written tokens) is kept.
- **Departments are referred to by code** in user and role inputs (as the Phase 3a provisioning already did); the code is immutable once created.
- **`idempotencyKey` is not accepted yet** by the 3b create commands: unique email and code already make a repeat harmless. Recorded in `api-contracts.md`.
- **Times are shown in UTC**, labeled, until the org timezone exists (Phase 5).

### Dependency changes

None. `package.json` and `package-lock.json` are identical to `4d7bc10`. The shadcn/ui components `table`, `badge`, and `textarea` were copied into `src/components/ui/` as source (MIT, already attributed in `NOTICE`); `native-select.tsx` is our own.

### Files changed

New (36): `db/migrations/{0005_identity_admin_guards.sql,meta/0005_snapshot.json}`, `scripts/e2e-db.ts`, `scripts/lib/e2e-database.ts`, `src/app/(app)/admin/{action-state,actions,role-options}.ts`, `src/app/(app)/admin/{layout,page}.tsx`, `src/app/(app)/admin/users/{page,new/page,[id]/page}.tsx`, `src/app/(app)/admin/departments/page.tsx`, `src/app/(app)/admin/_components/{create-user-form,department-forms,form-message,status-badge,user-forms}.tsx`, `src/components/ui/{badge,native-select,table,textarea}.tsx`, `src/lib/format.ts`, `src/modules/identity/application/{admin-departments,admin-guards,admin-roles,admin-user-queries,admin-users,audit-policies}.ts`, `src/modules/identity/infrastructure/admin-repository.ts`, `src/server/admin-links.ts`, `tests/concurrency/admin-set.test.ts`, `tests/e2e/admin.spec.ts`, `tests/integration/{admin,permission-matrix}.test.ts`, this report.

Modified (21): `README.md`, `db/migrations/meta/_journal.json`, `playwright.config.ts` (E2E database), `src/app/(app)/layout.tsx` (Admin link), `src/modules/identity/{index.ts,application/provision-user.ts,infrastructure/schema.ts}`, `src/server/{auth,auth-audit}.ts`, `tests/e2e/global-setup.ts`, `tests/integration/auth.test.ts` (see failure 5), docs (`PLAN.md`, `adr/0008`, `adr/README.md`, `api-contracts.md`, `architecture.md` (stale `buyer` label), `development.md`, `schema.md`, `state-machines.md`, `threat-model.md`, `user-stories.md`).

Local only (gitignored or outside the repo): the `pf_e2e` database (recreated per E2E run), `.local/e2e-credentials.json`. The development database got migration 0005; its data is unchanged (it still holds the 7 E2E users from Phase 3a runs, which cannot be deleted).

### Known limitations / not verified

- **CI has never run** (no remote). **gitleaks and actionlint: BLOCKED.** **`npm audit` could not reach the registry today** (network timeout); the dependency tree is unchanged since it last passed.
- **`LAST_ADMIN` is never the observed outcome through the commands.** An admin cannot remove themselves (SOD-05), and under the lock a removed admin's pending request fails with `FORBIDDEN`. So the rule is tested on the guard directly and stays as a backstop for future role definitions. CC-08 accepts either outcome and checks the invariant: exactly one admin left.
- **Two-step link issuance:** if Better Auth fails after the command commits, the audit shows `user.setupLinkIssued` without a usable link, and the admin issues another. Two admins issuing at the same moment can leave two valid links, both audited.
- **Residual risk T5:** the admin sees the setup link (no email in v1). See the threat model.
- **No "forgot password"** for users who already set one: that needs email delivery.
- Admin pages run their queries even for non-admins (who get `FORBIDDEN` and see "Access denied"); harmless, but it shows up as `query.denied` warnings in the log.
- **Accessibility** is checked only for the basics (labels, one `h1`, Enter activation). There was no screen-reader pass and no full keyboard audit. Only Edge was tested.
- One uncovered line: `admin.user.create` refuses initial roles without `admin.roles`, which no current role can trigger (only admin holds `admin.users`).
- A server already running on port 3100 is reused by Playwright **without** recreating `pf_e2e`.
- E2E global setup prints Node's `DEP0190` warning (`shell: true` on Windows), unchanged since Phase 3a.
- Org settings (US-AD-04) and approval policies (US-AD-03) are not built (Phases 5–8).

### Threat-model updates

E-01 verified per operation; E-02 verified (SOD-05 + DB backstops + set lock); S-03 completed (deactivation and refused sign-in); new accepted residual T5 risk for visible setup links. See `docs/threat-model.md`, "Phase 3b status".

### Next steps

1. Done: maintainer review, then committed (no push; there is no remote).
2. When the network allows: re-run `npm audit --omit=dev --audit-level=high`.
3. Phase 4: suppliers (maker-checker review, block/unblock, SOD-03).
