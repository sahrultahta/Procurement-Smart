## Phase 1 report: Toolchain, scaffold, local database, CI skeleton

- Date: 2026-10-18 (updated the same day after a pre-commit verification pass; see [Verification pass](#verification-pass-before-commit))
- Base commit: `c55d166` (Phase 0). Phase 1 is committed as a single commit on top of it (2026-10-19, after maintainer review), together with this report. Not pushed: there is no remote.
- Machine: Windows 10 Enterprise 19045, Node 24.21.0, npm 11.19.0

### Commands run (exact) and results

`npm ci` was run from the lockfile. The other rows reflect the final tree, after fix 8 below. Every Next.js command ran with `NEXT_TELEMETRY_DISABLED=1`.

| Command | Exit | Summary |
| --- | --- | --- |
| `npm ci` | 0 | 427 packages. Lifecycle scripts disabled by `.npmrc`. |
| `npm ls --depth=0` | 0 | 21 direct dependencies, all at the pinned versions below. `npm install --dry-run`: 0 `ERESOLVE`. `npm ls --all`: 0 invalid. |
| `npm run lint` | 0 | `eslint --max-warnings=0 .`, no findings |
| `npm run typecheck` | 0 | `tsc --noEmit`, no errors |
| `npm run test:unit` | 0 | 4 files, **20 passed** |
| `npm run test:integration` | 0 | 2 files, **7 passed** (local PostgreSQL 18.6) |
| `npm run build` | 0 | Next.js 16.4.2 (Turbopack), clean `.next`. **0 warnings** (an Edge-runtime warning existed before fix 8). Routes: `/` static, `/api/health` dynamic. |
| `npm run test:e2e` | 0 | **4 passed** (Playwright 1.64.0, local Microsoft Edge via `channel: 'msedge'`) |
| `npm run db:local -- init` | 0 | PostgreSQL 18.6 cluster, `procureflow_owner` role, `procureflow_dev` DB, `.env` generated |
| `npm run db:migrate` | 0 | "Migrations applied." (baseline) |
| `npm audit --omit=dev --audit-level=high` | 0 | **0 vulnerabilities** in production dependencies |
| `npm audit --audit-level=high` | 1 | 9 findings (4 moderate, 5 high), all in dev tooling. Triaged below. |
| fallback secret grep over tracked + untracked files | — | Only placeholders, the throwaway CI password, a template variable, and fake test URLs. `gitleaks` itself **not run** (see limitations). |
| real-password scan: both generated 48-character local passwords (from `.env` and `.local/superuser-password.txt`) searched with `grep -qF` in every file from `git ls-files -co --exclude-standard` | — | found in **0 of 69** committable files |

### Acceptance criteria

| ID | Result | Evidence |
| --- | --- | --- |
| P1-AC1 | **Pass** | `npm ci` exit 0. `npm ls --depth=0` matches the pins. |
| P1-AC2 | **Pass** | lint, typecheck, test, build all exit 0 (table above). The build is warning-free since fix 8. |
| P1-AC3 | **Pass, with a gap** | `tests/unit/eslint-rules.test.ts`, 11 tests: routes → module internals (alias and relative) rejected; routes → `@/shared/db/client` rejected; routes → `pg` rejected; domain → `drizzle-orm` rejected; `process.env` outside `env.ts`, `sql.raw`, numeric `mode:'number'`, and `dangerouslySetInnerHTML` all rejected; public API import allowed. **Gap:** module → module zones are configured but not yet exercised, because only one module (`health`) exists. Phase 2 (with `audit`) must add that test. |
| P1-AC4 | **Pass** | Temporary fixture `src/app/probe-server-only/` (a client component importing `@/shared/env`) made `next build` exit 1 with "It should only be used from a Server Component", traced through `client-probe.tsx [Client Component Browser]`. Fixture deleted, and the rebuild exits 0. |
| P1-AC5 | **Pass** | `tests/integration/database.test.ts`: `server_version_num >= 180000`; `uuidv7()` returns a v7 UUID; a Drizzle transaction with `isolationLevel: 'serializable'` reports `serializable` and commits; a throwing transaction rolls back; the migration journal is fully applied to the template. Local server is **18.6**, bound to 127.0.0.1:54318. |
| P1-AC6 | **Pass** | `tests/e2e/startup-config.spec.ts` (spawns `next start`): exit code 1 for a `mysql://` URL and for an empty URL, with the message naming `DATABASE_URL` and never printing the value. Plus `tests/unit/env.test.ts` (4 tests). Re-run and passing after fix 8 moved the check into `src/instrumentation-node.ts`. |
| P1-AC7 | **Pass** | `tests/integration/health-route.test.ts`: 200 `{status:'ok',checks:{database:'ok'}}` with `Cache-Control: no-store`; 503 `{status:'unavailable',...}` against an unreachable DB, with no password or host in the body. E2E: 200 against the real server. |
| P1-AC8 | **Partial** | `npm audit --omit=dev` clean. Full audit triaged (below). **gitleaks BLOCKED**: not installed, and the maintainer declined the binary download. A regex fallback scan and the real-password scan found no secrets. gitleaks runs in the CI `secrets` job, which hasn't run yet (no remote). |
| P1-AC9 | **Not verified (BLOCKED)** | `.github/workflows/ci.yml` is written. `actionlint` isn't installed (another binary download) and there is no GitHub remote, so CI has **not executed**. |

Open technical questions from Phase 0, now settled against the installed versions:

| Question | Answer | Evidence |
| --- | --- | --- |
| `uuidv7()` built into PG 18? | Yes | P1-AC5 test |
| Drizzle row locks? | Yes: `.for('update' \| 'no key update' \| 'share' \| 'key share', { noWait?, skipLocked?, of? })` | `select.d.ts:586`, `tests/unit/drizzle-api.test.ts` (renders `for update`, `for update nowait`) |
| Drizzle `numeric()` TypeScript type | `string` for select and insert | `expectTypeOf` in `tests/unit/drizzle-api.test.ts`, checked by `tsc` |

### Failures hit during the phase and how they were resolved

1. **ESLint 10 peer conflicts.** `eslint-plugin-import@2.32.0`, `eslint-plugin-react@7.37.5`, and `eslint-plugin-jsx-a11y@6.10.2` (all latest, all pulled in by `eslint-config-next`) declare ESLint ≤ 9. Next's bundled docs say the same. → Switched to **ESLint 9.39.5**, recorded in **ADR 0012**. Peer tree is now clean.
2. **Lint "Resolve error: typescript with invalid interface".** My config replaced `eslint-config-next`'s resolver settings, which it wires by absolute path. → Removed the override.
3. **`drizzle-kit generate` with no schema files.** → Added the composition root `src/server/schema.ts` (re-exports module tables from Phase 2 on) and pointed `drizzle.config.ts` at it.
4. **Next.js keeps running after `register()` throws.** It logs "Failed to prepare server", prints "Ready", and keeps serving (observed for 60 s). → The startup check now logs the variable names and calls `process.exit(1)` (in `src/instrumentation-node.ts` since fix 8). Covered by the E2E startup test.
5. **First PostgreSQL extraction incomplete.** `unzip 'pgsql/share/*'` skipped subdirectories (timezonesets), so `initdb` failed. → Extracted the full archive and removed `pgAdmin 4`, `StackBuilder`, `doc`, `include` (957 MB → 145 MB).
6. **PostgreSQL crashed (0xC0000005) on anything using ICU.** This made `initdb` fail in post-bootstrap. Windows event log: faulting module `C:\Windows\System32\MSVCP140.dll` **14.36.32532**. The EDB 18.6 binaries are linked with MSVC **14.44** (PE linker version of `postgres.exe` and `icuuc77.dll`), which needs a newer VC++ runtime. → With the maintainer's approval, copied Microsoft-signed `msvcp140.dll`, `vcruntime140.dll`, `vcruntime140_1.dll` **14.51.36247.0** from `C:\Program Files (x86)\Microsoft\Edge\Application\155.0.4283.62\` into `.local/pgsql/bin` only (app-local deployment; Authenticode status Valid, signer Microsoft Corporation). No system change. Undo by deleting the three files. The system-wide fix is updating the Visual C++ 2015–2022 Redistributable (x64).
7. **ESLint unit test timeout (33 s first lint).** It happened once, right after extracting ~3,000 PostgreSQL files (most likely an antivirus scan). Re-runs took ~3.5 s. → ESLint warm-up moved to `beforeAll` with a 120 s timeout. Rule assertions unchanged.
8. **Build warning missed in the first draft of this report.** The pre-commit verification pass found that `next build` exited 0 but printed: `./src/instrumentation.ts:16:7 Warning: A Node.js API is used (process.exit at line: 16) which is not supported in the Edge Runtime` … `Ecmascript file had an error`.
   - **Cause: application code** (not a dependency, not framework configuration). Next.js compiles `instrumentation.ts` for every runtime. The bundled guide (`node_modules/next/dist/docs/01-app/02-guides/instrumentation.md`, "Importing runtime-specific code") says "Next.js calls `register` in all environments, so it's important to conditionally import any code that doesn't support specific runtimes." Our early-return guard (`if (NEXT_RUNTIME !== 'nodejs') return;`) protected the code at runtime, but `process.exit` was still in the file Turbopack analyzes for Edge.
   - **Actual impact before the fix:** none. The emitted Edge chunk (`.next/server/edge/chunks/_1s0wgnupch4sb._.js`, source map → `src/instrumentation.ts`) contained only an empty `async function t(){}`, and `middleware-manifest.json` listed no Edge functions.
   - **Fix (the guide's documented pattern):** the Node-only check (same logic: `getEnv()`, on `EnvError` log and `process.exit(1)`, rethrow anything else) moved into `assertValidConfiguration()` in `src/instrumentation-node.ts`, which `register()` imports only inside `if (process.env.NEXT_RUNTIME === 'nodejs')`. No runtime or config changes.
   - **Result:** a clean build (`rm -rf .next && npm run build`) shows 0 warnings. The startup check appears in 1 Node server bundle and 0 Edge bundles. lint, typecheck, unit 20/20, integration 7/7, and E2E 4/4 (including both refuse-to-start tests) pass.

### Downloads and binaries (all with maintainer approval)

| Item | Source | Size | SHA-256 |
| --- | --- | --- | --- |
| `postgresql-18.6-5-windows-x64-binaries.zip` | `https://get.enterprisedb.com/postgresql/` (via EDB binaries page) | 384,620,317 B | `e2246ba91d22345bc3d017586c09ede52d9df180b1eeb480f050445f1cad84e2` (computed; EDB publishes none) |
| `msvcp140.dll` 14.51.36247.0 (copied, not downloaded) | local Edge install | | `14447a4e5593e482adda23a615c451ccd62fe5850c8f8d31643491b0be970a43` |
| `vcruntime140.dll` 14.51.36247.0 (copied) | local Edge install | | `03ace324db6329112dffcf50409048ce64dc2378246f8686512a00b639976ace` |
| `vcruntime140_1.dll` 14.51.36247.0 (copied) | local Edge install | | `cd94474bf6dd5617ede6a1cc8363e79afe656d42538e8d350e5c52ae1cf354e0` |

The npm install (approved as part of Phase 1) brought platform-native packages **from the npm registry only**: `@next/swc-win32-x64-msvc`, `@esbuild/win32-x64`, `@rolldown/binding-win32-x64-msvc`, `lightningcss-win32-x64-msvc`, `@unrs/resolver-binding-win32-x64-msvc`, `@img/sharp-win32-x64`. Lifecycle scripts never ran (`esbuild` ×3 and `unrs-resolver` declare `postinstall`, and everything works without it). **No Playwright browsers were downloaded**: `%LOCALAPPDATA%\ms-playwright` does not exist.

### Dependency pins (checked 2026-10-18 with `npm view`)

| Package | Version | Published | Note |
| --- | --- | --- | --- |
| next / eslint-config-next | 16.4.2 | 2026-10-15 | Exception to the 7-day rule: **16.4.1 (2026-10-14) fixes GHSA-673q-mjm6-r5xr and GHSA-2464-fhr4-w9xw (critical, unauthenticated RCE) and GHSA-p3m5-59mp-jv5r (high, DoS)**. 16.4.2 adds only bug-fix backports. |
| react / react-dom | 19.3.0 | 2026-09-09 | 19.3.1 is 4 days old and not a security release |
| typescript | 6.0.3 | 2026-04-16 | Not 7.x: typescript-eslint peer `<6.1.0` (ADR 0011) |
| eslint | 9.39.5 | 2026-07-10 | ADR 0012 |
| drizzle-orm / drizzle-kit | 0.45.4 / 0.31.11 | 2026-10-08 / 2026-09-21 | |
| pg / @types/pg | 8.23.1 / 8.23.1 | 2026-09-30 / 2026-08-17 | |
| zod | 4.6.5 | 2026-09-13 | |
| decimal.js | 10.6.0 | 2025-07-06 | installed, not used until Phase 2 |
| vitest / @vitest/coverage-v8 / vite | 5.0.3 / 5.0.3 / 8.3.4 | 2026-09-30 / 2026-09-30 / 2026-10-08 | |
| @playwright/test | 1.64.0 | 2026-10-07 | |
| fast-check | 4.10.2 | 2026-09-19 | installed, not used until Phase 2 |
| server-only | 0.0.1 | 2022-09-03 | |
| @types/node / @types/react / @types/react-dom | 24.19.2 / 19.3.0 / 19.3.0 | | |
| CI: actions/checkout, actions/setup-node | v7.0.1 `3d3c42e…`, v7.1.0 `949feb2…` (commit-pinned) | 2026-07-20 / 2026-10-08 | |
| CI: gitleaks image | `ghcr.io/gitleaks/gitleaks:v8.30.1` | 2026-03-21 | |

### `npm audit` triage (dev dependencies only)

| Advisory | Path | Decision |
| --- | --- | --- |
| GHSA-vfj7-8cjw-p6xm, `braces` (high): stack-exhaustion DoS through deeply nested patterns. **No fixed version** (`range: *`). | eslint-config-next → @next/eslint-plugin-next → fast-glob → micromatch → braces | **Accepted.** Lint-time only. Patterns come from our own config. npm's suggested "fix" (downgrade to eslint-config-next 14) is not acceptable. Re-check when a fixed `braces` ships. |
| GHSA-67mh-4wv8-2f99, `esbuild` ≤ 0.24.2 (moderate): dev-server CORS | drizzle-kit → @esbuild-kit/esm-loader → @esbuild-kit/core-utils → esbuild 0.18 | **Accepted.** drizzle-kit uses esbuild to load its config, not to serve. Goes away with drizzle-kit 1.0 (ADR 0004). |

CI blocks on `npm audit --omit=dev --audit-level=high` and reports the full audit without blocking.

### Files changed

New: `package.json`, `package-lock.json`, `.npmrc`, `.nvmrc`, `.gitattributes`, `.env.example`, `tsconfig.json`, `next.config.ts`, `eslint.config.mjs`, `vitest.config.ts`, `playwright.config.ts`, `drizzle.config.ts`, `src/app/{layout.tsx,page.tsx,api/health/route.ts}`, `src/instrumentation.ts`, `src/instrumentation-node.ts`, `src/shared/env.ts`, `src/shared/db/client.ts`, `src/modules/health/{index.ts,application/check-health.ts,infrastructure/ping-database.ts}`, `src/server/schema.ts`, `db/migrations/{0000_baseline.sql,meta/_journal.json,meta/0000_snapshot.json}`, `scripts/{db-local.ts,db-migrate.ts}`, `tests/support/{global-setup.ts,test-db.ts,server-only-stub.ts}`, `tests/unit/{env,eslint-rules,drizzle-api,health}.test.ts`, `tests/integration/{database,health-route}.test.ts`, `tests/e2e/{smoke,startup-config}.spec.ts`, `.github/workflows/ci.yml`, `.github/dependabot.yml`, `docs/development.md`, `docs/adr/0012-eslint-9-and-install-script-policy.md`, this report.

Modified: `docs/adr/README.md`, `docs/adr/0011-toolchain-and-testing.md` (status line → superseded row), `docs/architecture.md` (health module, graph location, composition root), `docs/PLAN.md` (status).

Not tracked (gitignored): `.env` (generated credentials), `.local/` (PostgreSQL binaries, data, download, superuser password file), `.next/`, `next-env.d.ts`.

### Verification pass before commit

Run on 2026-10-18 against the final working tree (after fix 8), with `NEXT_TELEMETRY_DISABLED=1`. Statuses: PASS, FAIL, BLOCKED (cannot run here), NOT RUN (no check exists yet).

| Check | Exact command | Status | Evidence |
| --- | --- | --- | --- |
| Lint | `npm run lint` | PASS | exit 0, `--max-warnings=0` |
| Type-check | `npm run typecheck` | PASS | exit 0 |
| Unit tests | `npm run test:unit` | PASS | 4 files, 20/20 |
| Integration tests | `npm run test:integration` | PASS | 2 files, 7/7 (PostgreSQL 18.6, 127.0.0.1:54318) |
| Production build | `rm -rf .next && npm run build` | PASS | exit 0, 0 warnings (fix 8) |
| E2E | `npm run test:e2e` | PASS | 4/4 |
| Prod dependency audit | `npm audit --omit=dev --audit-level=high` | PASS | 0 vulnerabilities |
| Full dependency audit | `npm audit --audit-level=high` | FAIL (expected) | exit 1. 4 moderate + 5 high, all from GHSA-vfj7-8cjw-p6xm (`braces`) and GHSA-67mh-4wv8-2f99 (`esbuild`) in dev tooling. Triaged and accepted above. |
| Secret patterns (fallback) | `git ls-files -co --exclude-standard \| xargs grep -lIE '<private-key / cloud-token / postgres-URL patterns>'` | PASS | hits only in `.env.example`, `ci.yml`, `scripts/db-local.ts`, two test files, all placeholders, throwaway, or templated |
| Real local passwords | `grep -qF` of both generated passwords over every committable file | PASS | 0 of 69 files |
| gitleaks | n/a | BLOCKED | not installed. Download declined. |
| actionlint | n/a | BLOCKED | not installed. No download requested. |
| CI (GitHub Actions), Dependabot config | n/a | BLOCKED | no GitHub remote, no Docker locally |
| Module-to-module boundary test | n/a | NOT RUN | needs a second module (Phase 2) |
| Coverage gate | n/a | NOT RUN | starts in Phase 2 (P2-AC7) |

**Local PostgreSQL DLLs.** `.local/pgsql/bin/{msvcp140,vcruntime140,vcruntime140_1}.dll` (14.51.36247.0, Microsoft signature Valid, hashes as listed above) are **machine-specific, not project artifacts**:

- They are matched by `.gitignore:18` (`.local/`), are not in the index (`git ls-files .local` → 0 entries), and no repository file depends on them.
- Removing them would not change the commit. Locally, PostgreSQL would fall back to the System32 runtime (still 14.36): `initdb` fails, and any ICU collation use crashes a backend, which makes PostgreSQL restart and drop all connections.
- Keep them until the Visual C++ 2015–2022 Redistributable (x64) is updated system-wide. Then they can be deleted.

### Known limitations / not verified

- **CI has never run** (BLOCKED: no GitHub remote). The workflow, the Dependabot `cooldown` keys, and the gitleaks Docker step are unverified.
- **gitleaks and actionlint not run locally** (BLOCKED: neither is installed; the gitleaks download was declined, and an actionlint download was never requested). Only the regex fallback and real-password scans were done.
- **Module-to-module boundary zones untested** until a second module exists (Phase 2).
- **Integration tests use the owner role**, not a restricted app role. The `procureflow_app` role and grants arrive in Phase 2 (P2-AC3).
- **Next.js telemetry:** the first `next build` ran before `NEXT_TELEMETRY_DISABLED=1` was set, so Next.js may have sent its anonymous usage telemetry once. Every later run in this session had it disabled. To opt out permanently on this machine: `npx next telemetry disable`.
- Local PostgreSQL relies on the app-local VC++ runtime copy (failure 6). If Edge's copy is ever needed again, take it from the then-current Edge version, or update the system redistributable.
- `.local/downloads/` keeps the 367 MB zip for re-extraction. It is safe to delete.
- Coverage is not measured yet. The ≥ 85% gate starts in Phase 2 (P2-AC7).

### Threat-model updates

- E-04 (malicious dependency): mitigation strengthened. Lifecycle scripts are disabled project-wide (ADR 0012), and CI actions are pinned by commit SHA.
- I-04 (secrets): `.env` is generated with random 48-hex passwords and gitignored. A local gitleaks run is still outstanding.

### Next steps

1. Maintainer review of this report. Commit Phase 1.
2. Optional: add a GitHub remote so CI (P1-AC9, gitleaks) can run.
3. Phase 2: shared kernel (decimal/money), DB roles (`procureflow_owner` / `procureflow_app`), document sequences, append-only `audit_events`, command runner, structured logger, module-to-module boundary test.
