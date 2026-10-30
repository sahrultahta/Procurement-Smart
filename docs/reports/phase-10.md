## Phase 10 report: hardening, deployment documentation, release v0.1.0

- Date: 2026-10-30
- Base commit: `c150029` (Phase 9). Phase 10 is committed as a single commit on top of it (2026-10-30, after maintainer approval), together with this report, and tagged `v0.1.0`. Not pushed: there is no remote.
- Machine: Windows 10 Enterprise 19045, Node 24.21.0, npm 11.19.0, local PostgreSQL 18.6, Microsoft Edge (Playwright `msedge` channel)
- Maintainer instructions: (2026-10-29) "Lanjutkan ke phase 10", inspect and plan; (2026-10-30) "Setujui rencana", taken as approval of the plan and its decisions 1 to 9, including downloading gitleaks and actionlint and dropping the drill database. Standing instruction: no commit without the maintainer's permission.

Status vocabulary: **Implemented**, **Tested**, **Verified** (run here, output observed). Nothing is **Deployed**.

### Plan and acceptance criteria

Phase 10 delivers PLAN.md P10-AC1 to AC4, broken down as follows.

| ID | Acceptance criterion | Covers | Verified by |
| --- | --- | --- | --- |
| P10-AC1 | Every threat-model row maps to a passing test, or is marked accepted with a rationale | P10-AC1 | review table below |
| P10-AC2 | `docs/deployment.md` followed literally in a fresh clone against a new cluster reaches a working sign-in, every step's output recorded | P10-AC2 | execution log |
| P10-AC3 | Backup → drop → restore: row counts and checksums of every table equal, the audit trail included | P10-AC3 | execution log |
| P10-AC4 | Lint, typecheck, unit, integration, concurrency, E2E, build, `npm audit`, gitleaks green; CI not verified (no remote) | P10-AC4 | command output |
| P10-AC5 | Hash-chained audit export and verification: an intact export passes; a changed, removed, added, or reordered line, a cut-off file, and database changes after the export are detected | scope | unit + integration |
| P10-AC6 | The idempotency purge deletes only keys older than the cutoff | scope | integration |
| P10-AC7 | The remaining security checklist items proven and ticked | P10-AC1 | tests + review |
| P10-AC8 | Docs: `deployment.md`, `operations.md`, `CHANGELOG.md`, README, this report | scope | review |
| P10-AC9 | Definition of done; version 0.1.0; tag `v0.1.0` after the commit is approved | scope | commands |

### Decisions taken within the plan (approved with the plan, 2026-10-30)

1. **TOTP two-factor authentication is deferred** past v0.1.0; the risk is recorded as accepted (threat model section 7).
2. **PostgreSQL row-level security is deferred**; authorization stays in the application, checked for every operation by the permission matrix.
3. **Hash-chained audit export: built** (no new dependency).
4. **Standalone build:** `output: 'standalone'` in `next.config.ts`.
5. **"Clean machine"** = a fresh clone and a new PostgreSQL cluster on another port of this machine, not a VM (no Docker or VM here). The reverse proxy is documented, not run.
6. **The restore drill drops only a drill database**, on a cluster created for the drill; the development database was not touched.
7. **gitleaks and actionlint were downloaded** (official release binaries, checksums verified) into `.local/tools` (gitignored).
8. **Idempotency keys older than 30 days are purged by an operator command**, not automatically.
9. **The tag `v0.1.0` is created after the commit is approved**; nothing is pushed.

Choices made while implementing (for the maintainer's review):

- **`npm run build` packages the standalone server and deletes `.env` from it.** Next.js copies `.env` and `.env.production` into `.next/standalone` (seen in its build code and in the first build here). `npm run start` now runs `.next/standalone/server.js`, and the E2E suite tests that packaged server, the deployment artifact. The build output still holds per-build keys (preview mode, Server Action encryption); the guide treats `.next/` as confidential.
- **`TRUSTED_PROXIES` (new, optional).** ADR 0014 promised that Phase 10 would configure Better Auth's trusted proxies. Without it, a proxy that appends to `X-Forwarded-For` would put every sign-in in one shared rate-limit bucket (five wrong passwords from anyone lock out everyone for a minute), and the audit trail recorded the leftmost address, which a client can write. Now Better Auth gets the list, and the request context and the sign-in audit events resolve the client by the same rule (`src/shared/application/client-ip.ts`, built on Node's `net.BlockList`, not on a transitive Better Auth package).
- **The hash chain lives in the audit module's application layer** (`node:crypto` is not allowed in `domain/`). Event times are exported in UTC with microseconds whatever the session time zone, so an export and a later check from a different session agree.
- **New `npm run db:checksums`** (row count and md5 of the sorted rows per table, all tables in one repeatable-read snapshot) for restore checks; the runbook uses it.
- **Backups keep the grants** (`pg_dump --no-owner`, not `--no-privileges`), so a restore needs no separate grant script once the roles exist.
- **The startup-config E2E test now starts the packaged server**, and two checks were added there: a weak `BETTER_AUTH_SECRET` is refused without being echoed, and the package has no `.env` and no browser source maps.
- **S-01 in the threat model no longer mentions a common-password blocklist:** it was never built (recorded in the Phase 3a report); only the 12-character minimum is enforced.

### What Phase 10 adds (all implemented, tested, verified locally)

| Area | Where |
| --- | --- |
| Standalone build and packaging; `start` runs the packaged server; E2E against it | `next.config.ts`, `scripts/package-standalone.ts`, `package.json`, `playwright.config.ts`, `tests/e2e/startup-config.spec.ts` |
| Hash-chained audit export, verification, comparison with the database | `src/modules/audit/application/{hash-chain,audit-export}.ts`, `src/modules/audit/infrastructure/audit-repository.ts`, `scripts/audit-{export,verify}.ts` |
| Idempotency purge | `src/shared/db/idempotency.ts`, `scripts/purge-idempotency.ts` |
| Per-table checksums | `scripts/db-checksums.ts` |
| Client IP behind trusted proxies, for rate limiting and audit | `src/shared/application/client-ip.ts`, `src/shared/env.ts`, `src/server/{auth,auth-audit,request-context}.ts`, `.env.example` |
| Docs | `docs/deployment.md`, `docs/operations.md`, `CHANGELOG.md`, README, `docs/development.md`, threat model, ADR 0014, PLAN |
| Version 0.1.0 | `package.json`, `package-lock.json` (root version only) |

### Commands run (exact) and results

The full suite ran once from `npm ci` (`scratchpad/verify10/run.sh`, through Git's `bash.exe --noprofile`, because the Bash tool's shell profile fails to parse on this machine; see Known limitations). One unit test failed in that run (see Failures, 4); after the fix the unit tests and the coverage run were repeated.

| Command | Exit | Result |
| --- | --- | --- |
| `git diff --stat HEAD -- package.json package-lock.json` | 0 | scripts and version only: **no dependency changes** |
| `npm ci` | 0 | 597 packages from the lockfile |
| `npm run db:migrate` | 0 | no new migration |
| `npm run lint` / `npm run typecheck` | 0 / 0 | clean (the first draft of the hash chain in `domain/` was refused by the purity lint rule and moved) |
| `npm run test:unit` | 1, then 0 | 745 of 746, one stale expectation (Failures, 4); after the fix **746 passed** (was 729) |
| `npm run test:integration` | 0 | **407 passed** (was 400: export and purge, two proxy tests) |
| `npx vitest run --coverage` (repeated after the fix) | 0 | **1153 passed**; domain/application scope **2223/2234 lines (99.51 %)**; `hash-chain.ts`, `audit-export.ts`, `client-ip.ts` at 100 % of lines |
| `rm -rf .next && npm run build` | 0 | 0 warnings; `Removed from the build output (configuration is given at run time): .env`; `Standalone server ready` |
| `npx playwright test` (twice) | 0 / 0 | **48 passed** both times (46 + 2 new startup checks), against the packaged server |
| `npm run seed` | 0 | idempotent: created nothing |
| `npm audit --omit=dev --audit-level=high` | 0 | nothing at high or critical |
| `npm audit` | 1 | the same **4 moderate** findings as in Phases 7 to 9 (esbuild ≤ 0.24.2 through drizzle-kit, development only); accepted (threat model checklist) |
| `node scratchpad/worktree-secret-scan.mjs` | 0 | 18 secrets × 439 committable files, **0 hits** |
| `.local/tools/gitleaks/gitleaks.exe git . --redact` | 0 | 15 commits, **no leaks** |
| `.local/tools/gitleaks/gitleaks.exe dir . --redact` | 1 | 30 findings, all in gitignored files: `.env`, `.local/` credential files, `.next/` build keys, gitleaks' own README |
| `.local/tools/actionlint/actionlint.exe .github/workflows/ci.yml` | 0 | no findings |
| `node scratchpad/doc-links.mjs` | 0 | in the suite, before this report existed: 2 broken links, both to it; after writing it: **72 relative links in 40 files, 0 broken** |
| downloads | 0 | `gitleaks_8.30.1_windows_x64.zip` (8,438,883 bytes, SHA-256 `d29144de…afc4e`) and `actionlint_1.7.12_windows_amd64.zip` (2,479,065 bytes, `6e7241b5…22f6e9`) match their release checksum files |
| audit export on the development database | 0 | first run: `NOT INTACT: line 14: event 11 is out of order` (Failures, 1); after the fix 178 events exported, `File intact`, `Database matches the export` |
| `npm run maintenance:purge-idempotency -- --older-than-days 30` (development) | 0 | `Deleted 0 idempotency keys` |

**Deployment drill (P10-AC2), run twice:** first on 2026-10-30 before the proxy change, then again on the final tree. Environment: `initdb` of a new PostgreSQL 18 cluster (superuser `postgres`, random password, scram-sha-256, 127.0.0.1:54330), a `git clone` of this repository into a short path (`Documents\pf-drill`; long paths are off on this machine), with the 34 uncommitted release files copied over, because `v0.1.0` does not exist yet. No `.env`, `.local/`, or `node_modules` in the clone; every `DATABASE_*`, `BETTER_AUTH_*`, and `NEXT_*` variable cleared from the shell first. Then the guide's commands in PowerShell form:

| Step | Command | Result (final tree) |
| --- | --- | --- |
| 1 | `npm ci` | exit 0 |
| 2 | the four `node -e …randomBytes…` commands | 48, 48, 64, 44 characters |
| 3 | `psql "$DATABASE_ADMIN_URL" -v ON_ERROR_STOP=1 -c "CREATE ROLE procureflow_owner …" -c "CREATE DATABASE procureflow OWNER procureflow_owner"`; `npm run db:app-role` | `CREATE ROLE`, `CREATE DATABASE`; `Role procureflow_app created.` |
| 4 | `npm run db:migrate` (owner URL) | `Migrations applied.` |
| 5 | `npm run build` with only `NEXT_TELEMETRY_DISABLED` and `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` set | exit 0: **the build needs no database and no `.env`**; the copied `opt-procureflow` holds no `.env` file |
| 6 | `node server.js` in the copy, with `NODE_ENV=production`, `DATABASE_URL` (app role), `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL=http://127.0.0.1:3200`, `HOSTNAME`, `PORT=3200`, `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`, `TRUSTED_PROXIES=127.0.0.1` | `Ready` |
| 7 | `curl -s -i http://127.0.0.1:3200/api/health` | `HTTP/1.1 200 OK`, `{"status":"ok","checks":{"database":"ok"}}` |
| 7 | `npm run bootstrap-admin -- --email drill.admin@example.com --name "Drill Admin"` | `Admin drill.admin@example.com created.` and the one-time link |
| 7 | the link in Edge (Playwright script): set a generated password, then sign in | "Your password is set."; signed in as **Drill Admin**, menu *Audit, Admin*; the same link again: "This link is invalid, already used, or expired." |

Not run: step 8 (reverse proxy, TLS) and the systemd unit. The drill clone, cluster, and secrets were deleted afterwards; the logs are in `scratchpad/p10/drill-run1` and `drill`.

**Backup drill (P10-AC3)**, on the first drill cluster, following docs/operations.md:

| Step | Result |
| --- | --- |
| Stop the server; rotate secrets as the runbook says (`ALTER ROLE procureflow_owner PASSWORD …`, `npm run db:app-role`, new `BETTER_AUTH_SECRET`) | exit 0 each |
| `npm run seed` (demo data, so every kind of row exists) | 7 users, 3 suppliers, 7 requisitions, orders, a receipt, 90 audit events |
| `npm run db:checksums` before | 30 tables, `ALL 30 tables 7e089e842bb4115e6e2d752dd140562d` (`audit_events` 90 rows) |
| `npm run audit:export -- --out audit-before-drop.jsonl` | 90 events, last id 90 |
| `pg_dump --format=custom --no-owner` | 224,485 bytes |
| `DROP DATABASE procureflow` (drill cluster) | exit 0 |
| `CREATE DATABASE procureflow OWNER procureflow_owner`; `pg_restore --exit-on-error --no-owner` | exit 0 |
| `npm run db:checksums` after | **identical**: 31 of 31 lines, the same `ALL` hash |
| `npm run audit:verify -- --file … --expect-last-hash … --against-db` | `File intact: 90 events …`; `Database matches the export for that range.` |
| As the app role `UPDATE audit_events …`; as the owner `DELETE FROM audit_events …` | `permission denied for table audit_events`; `audit_events is append-only: DELETE is not allowed` |
| Grants of `procureflow_app` on `audit_events` | `INSERT,SELECT` |
| Start the server with the rotated secrets; health; sign in again (Edge) | `{"status":"ok",…}`; signed in as Drill Admin; **Audit** lists the events |

### Acceptance criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| P10-AC1 threat-model review | **PASS** | all 35 rows of sections 5 and 6 below: 34 mapped to passing tests (S-01, D-01, and E-04 with a part accepted, each with its rationale), AB-11 accepted |
| P10-AC2 deployment | **PASS**, with the deviations stated | the drill tables above: a fresh clone and a new cluster reach a working sign-in; steps 1 to 7 literally; step 1 used the release candidate instead of the tag; step 8 not run |
| P10-AC3 backup and restore | **PASS** | identical checksums for all 30 tables (audit included), audit export verified against the restored database, triggers and grants back |
| P10-AC4 full suite | **PASS** locally; **CI not verified** (no remote) | the commands table |
| P10-AC5 audit export | **PASS** | unit (`tests/unit/audit-export.test.ts`, 8 tests): canonical JSON, intact and continued chains, a one-character change, removed, added, and reordered lines, a cut file, a wrong footer, a file rewritten from scratch caught only by the kept last hash, non-export input. Integration (`tests/integration/maintenance.test.ts`): id order, IPv6, reason, nested changes, system actor, UTC microseconds independent of the session time zone, chain continuation, and an event changed and one deleted by the owner (guards off) reported as `changed` and `missing`, one in range but not exported as `extra` |
| P10-AC6 purge | **PASS** | keys 31 days and 30 days 1 minute old deleted, 29 days kept, a second run deletes 0; as the runtime role |
| P10-AC7 checklist | **PASS** | the four open items ticked with evidence (threat model section 8); `TRUSTED_PROXIES` tested with forged addresses |
| P10-AC8 docs | **PASS** | the files listed; doc links checked |
| P10-AC9 release | **PASS** | version 0.1.0; the maintainer approved the commit and the tag on 2026-10-30 |

### Threat-model review (P10-AC1)

Each row of docs/threat-model.md sections 5 and 6, against the code as of this phase.

| Row | Status | Evidence (all passing in the run above) |
| --- | --- | --- |
| S-01 brute force | tested; per-account limit and password blocklist **accepted** as not built | `tests/integration/auth.test.ts` (5 per minute per client, 429, other clients unaffected, stored in PostgreSQL; behind proxies with forged addresses), `tests/e2e/auth.spec.ts` (generic message). Rationale: a 12-character minimum and per-client limits; per-account limits would let anyone lock a known user out |
| S-02 session theft via XSS | tested | `tests/e2e/security-headers.spec.ts` (nonce CSP), lint rule `react/no-danger` (`tests/unit/eslint-rules.test.ts`), HttpOnly cookies (`auth.test.ts`) |
| S-03 fixation, replay | tested | `auth.test.ts` (new session per sign-in, sign-out and replay), `tests/integration/admin.test.ts` (deactivation revokes sessions) |
| S-04 self-registration | tested | `auth.test.ts` (sign-up refused, no user) |
| T-01 tampered fields | tested | strict schemas enforced at definition (`tests/unit/runner.test.ts`); tamper cases per command in every module's integration tests |
| T-02 edit after approval | tested | state-machine unit tests per document; database guards per module (`PFR01`… `PFG01`) in the integration tests |
| T-03 SQL injection | tested | `sql.raw` banned (`eslint-rules.test.ts`); injection strings in searches (`suppliers.test.ts` and others) |
| T-04 races | tested | `tests/concurrency/*` (CC-01 to CC-10, 20 forced overlaps each) |
| T-05 CSRF | tested | `auth.test.ts` cross-origin, `tests/e2e/admin.spec.ts` replayed Server Action from another origin |
| T-06 CSV injection | tested | `tests/unit/reporting.test.ts`, `tests/integration/reports.test.ts` |
| R-01 repudiation | tested | `tests/integration/audit.test.ts`; every command's audit event asserted in its tests |
| R-02 audit tampering via the app | tested | `audit.test.ts` (privileges, triggers); `maintenance.test.ts` and the restore drill (detection of owner changes) |
| I-01 IDOR | tested | cross-user reads per entity (requisitions, orders, receipts, reports history) |
| I-02 over-exposed data | tested | DTO allowlists (`*_KEYS`) in every module's tests; report and export permissions |
| I-03 error leakage | tested | `runner.test.ts` (`INTERNAL` generic, details only in the log); `startup-config.spec.ts` (no secret echoed) |
| I-04 secrets in the repo | tested | gitleaks over history (0) and the worktree scan (0 committable) |
| I-05 PII in logs | tested | `tests/unit/clock-and-logger.test.ts` |
| D-01 oversized input | tested; Server Action body limit **accepted** at the Next.js default (1 MB), not tested | 200 lines and length limits in validation tests; pagination capped at 100 |
| D-02 long locks | tested | `tests/concurrency/lock-timeout.test.ts`, `tests/integration/runner-db.test.ts` |
| D-03 audit flood | tested | rate limit before audit (`auth.test.ts`); denied operations logged, not audited (`runner.test.ts`) |
| E-01 missing role | tested | `tests/integration/permission-matrix.test.ts`, 77 operations × 7 roles, no role, anonymous |
| E-02 admin escalation | tested | `admin.test.ts` (SOD-05, `LAST_ADMIN`), `tests/concurrency/admin-set.test.ts` (CC-08) |
| E-03 threshold manipulation | tested | `approvals.test.ts` (route frozen at submit, `NO_APPROVAL_ROUTE`), settings and policy audit events, the split report shows the thresholds |
| E-04 malicious dependency | tested; 4 moderate advisories **accepted** | exact pins, `npm ci`, `ignore-scripts`, Dependabot config, `npm audit` (no high or critical) |
| AB-01 own approval | tested | SOD-01, `approvals.test.ts` + trigger |
| AB-02 one approver clears all steps | tested | SOD-02, unique index |
| AB-03 fake supplier | tested | SOD-03, `suppliers.test.ts`, CC-09 |
| AB-04 identity swap | tested | `suppliers.test.ts`, CC-10 |
| AB-05 inflated PO prices | tested | `purchase-orders.test.ts` |
| AB-06 over-ordering | tested | `OVER_ORDER`, CC-03 |
| AB-07 skipped sourcing | tested | `RFQ_REQUIRED`, award justification tests |
| AB-08 fake receipt | tested | SOD-04, `goods-receipts.test.ts` |
| AB-09 over-receipt | tested | `OVER_RECEIPT`, CC-04 |
| AB-10 split purchases | tested (detection) | `reports.test.ts`, `reporting.test.ts` |
| AB-11 collusion | **accepted** | not preventable by separation of duties; detectable through audit search, document history, aging, and spend reports |

### Failures and fixes during the phase

1. **The audit export sorted ids as text** (found by its own verifier on the development database: `event 11 is out of order (after 109)`): `ORDER BY id` named the output column `id::text`. It now orders by `audit_events.id`. The same mistake had already been made once in a Phase 9 test; it is easy to make with text casts.
2. **Bash broke mid-phase:** every Bash tool call failed with `unexpected EOF while looking for matching '` at line 67, before running anything: a shell profile on this machine no longer parses. Work continued in PowerShell, and the suite ran through Git's `bash.exe --noprofile --norc`, which works. The profile was not touched.
3. **`pg_ctl start` from PowerShell held the shell's pipes open** and the call timed out; stopping that call also killed a server process and left the drill cluster's postmaster in a bad state ("could not reserve shared memory"). It was stopped (`-m immediate`), and the cluster is now started from a small Node script that spawns `pg_ctl -w` with ignored stdio, as `scripts/db-local.ts` does.
4. **One unit test failed in the full run:** `env.test.ts` expected the exact parsed configuration, which now has `TRUSTED_PROXIES: []`. The expectation was updated; the unit tests and coverage were run again (746 and 1153 passed).
5. **Windows PowerShell 5.1 treated npm's stderr warnings as errors** with `$ErrorActionPreference = 'Stop'` in the first drill attempt (stopped at `npm ci`, nothing else ran); the drill scripts judge steps by exit codes instead.
6. **Long paths:** the scratchpad path plus the deepest `node_modules` path exceed 260 characters and long paths are off, so the drill clone went to `Documents\pf-drill` (deleted afterwards).
7. **The deployment drill ran before the proxy change**, so it was run a second time on the final tree, with `TRUSTED_PROXIES` set.

### Files changed

- New: `src/modules/audit/application/{hash-chain,audit-export}.ts`, `src/shared/application/client-ip.ts`; `scripts/{package-standalone,audit-export,audit-verify,purge-idempotency,db-checksums}.ts`; `docs/deployment.md`, `docs/operations.md`, `CHANGELOG.md`, this report; `tests/unit/{audit-export,client-ip}.test.ts`, `tests/integration/maintenance.test.ts`.
- Changed: `next.config.ts`, `package.json` (scripts, version), `package-lock.json` (version), `playwright.config.ts`, `.env.example`; `src/modules/audit/{index.ts,infrastructure/audit-repository.ts}`, `src/shared/{env.ts,db/idempotency.ts}`, `src/server/{auth,auth-audit,request-context}.ts`; tests `e2e/startup-config.spec.ts`, `integration/auth.test.ts`, `support/auth.ts`, `unit/env.test.ts`; docs README, `development.md`, `threat-model.md`, ADR 0014, PLAN.

### Dependency changes

None. Two tools outside the dependency tree, in gitignored `.local/tools`: gitleaks 8.30.1 and actionlint 1.7.12 (release checksums verified).

### Known limitations / not verified

- **Not a clean machine:** the drill used this machine's Node, npm cache, and PostgreSQL binaries; a different operating system or a container was not tried. The guide's commands are POSIX; the drill ran their PowerShell form.
- **Reverse proxy, TLS, HSTS through a proxy, and the systemd unit were not run.** HSTS over `X-Forwarded-Proto` is covered by the existing header tests.
- **CI has never run** (no remote). The workflow passes actionlint.
- **Deferred:** TOTP two-factor authentication, row-level security, a per-account sign-in limit, a common-password blocklist, email delivery of setup links.
- The audit export is evidence, not prevention; it depends on the operator keeping each export's last hash elsewhere.
- Backups are logical (`pg_dump`); point-in-time recovery is the database platform's job and was not set up.
- The Bash tool's shell profile on this machine is broken (Failures, 2); it needs a look outside this project.
- **Not verified:** a person reading the guide and the runbook cold; restoring onto a different PostgreSQL major version; browsers other than Edge.

### Threat-model updates

`docs/threat-model.md` "Phase 10 status": S-01 residual closed (`TRUSTED_PROXIES`); R-02 tamper evidence; A8 build output; I-04 and E-04 with gitleaks and `npm audit`; TOTP and RLS deferred and accepted; section 7 and the checklist (section 8) completed.

### Next steps

- Done (2026-10-30): the maintainer asked to commit Phase 10 and create the tag `v0.1.0`; not pushed.
- Maintainer review of the choices made inside the plan (above); any change is a follow-up commit.
- After a remote exists: push, let CI run, and record the result (D5, P1-AC9, P10-AC4).
- Optional later phases (PLAN.md): two-factor authentication, email, REST API, and the rest of that list.
