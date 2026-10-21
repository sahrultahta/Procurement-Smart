## Phase 3a report: Sign-in and identity

- Date: 2026-10-21
- Base commit: `2fbcf03` (Phase 2). Phase 3a is committed as a single commit on top of it (2026-10-21, after maintainer approval), together with this report. Not pushed: there is no remote.
- Machine: Windows 10 Enterprise 19045, Node 24.21.0, npm 11.19.0, local PostgreSQL 18.6, Microsoft Edge (Playwright `msedge` channel)
- Maintainer decisions for this phase (2026-10-21): seven roles with `buyer` renamed `procurement` and `finance` kept; Tailwind + shadcn/ui; Phase 3 split into 3a (this report) and 3b (administration screens).

Status vocabulary: **Implemented**, **Tested**, **Verified** (run here, output observed). Nothing is **Deployed**.

### What Phase 3a adds (all implemented, tested, verified locally)

| Area | Where |
| --- | --- |
| 7 roles + permission matrix in code (ADR 0006 / 0014) | `src/modules/identity/domain/roles.ts` |
| Better Auth 1.7.7: email/password, sign-up off, DB sessions, DB rate limit, origin/CSRF forced on, telemetry off | `src/server/auth.ts`, `src/server/auth-schema-options.ts`, `src/app/api/auth/[...all]/route.ts` |
| Tables: `users`, `sessions`, `accounts`, `verifications`, `rate_limits`, `departments`, `user_profiles`, `role_assignments` + least-privilege grants | `src/modules/identity/infrastructure/{auth-schema,schema}.ts`, migrations `0003` (generated, reviewed), `0004` (grants) |
| Request context from the session (DB-validated, deactivated profile ⇒ signed out) | `src/server/request-context.ts`, `src/modules/identity/application/actor.ts` |
| User provisioning (one transaction, audited) + one-time password-setup links (24 h, single use) | `src/modules/identity/application/provision-user.ts`, `issuePasswordSetupToken` in `src/server/auth.ts` |
| Auth audit events: signedIn, signInFailed (email fingerprint only), signedOut, passwordSet, passwordChanged | `src/server/auth-audit.ts` + Better Auth hooks |
| `account.me` query with an allowlisted DTO | `src/modules/identity/application/account.ts` |
| UI (Tailwind 4 + shadcn/ui): sign-in, set-password, home, My account, sign-out (Server Action) | `src/app/(public)/**`, `src/app/(app)/**`, `src/components/ui/*` |
| `proxy.ts`: request id, optimistic redirect, security headers, per-request CSP nonce | `src/proxy.ts` |
| Scripts: `env:local`, `seed` (fictional, idempotent), `bootstrap-admin` | `scripts/{env-local,seed,bootstrap-admin}.ts` |

### Commands run (exact) and results

Final run on 2026-10-21, with `NEXT_TELEMETRY_DISABLED=1` for Next.js commands.

| Command | Exit | Result |
| --- | --- | --- |
| `npm install better-auth@1.7.7 radix-ui@1.8.1 class-variance-authority@0.7.1 clsx@2.1.1 tailwind-merge@3.7.0` | 0 | Installed. No new lifecycle scripts (still only esbuild ×3 and unrs-resolver, which never run). 0 `ERESOLVE`. |
| `npm install -D auth@1.7.7 tailwindcss@4.3.3 @tailwindcss/postcss@4.3.3 tsx@4.23.15` | 0 | Installed. New native binary from npm: `@tailwindcss/oxide-win32-x64-msvc`. |
| `npx shadcn@4.21.4 add button input label card alert --dry-run`, then `-y` | 0 | 5 components. It also added `cn@0.5.0`, which I **removed** (see decisions). |
| `npx auth generate --config scripts/auth-cli.config.ts --adapter drizzle --dialect postgresql --output <temp>` | 0 | Schema generated, reviewed, then adapted |
| `npx drizzle-kit generate --name=auth_and_identity` / `--custom --name=auth_and_identity_grants` | 0 | Migrations 0003 and 0004 |
| `npm run db:migrate` | 0 | applied to `procureflow_dev` |
| `npm run env:local` | 0 | added `BETTER_AUTH_SECRET` (random) and `BETTER_AUTH_URL` to `.env`; previous `.env` backed up to `.local/env-backup-2026-10-21T05-23-22-376Z.txt` |
| `npm run seed` (twice) | 0 / 0 | 1st: 3 departments, 7 users, 7 passwords. 2nd: **0 created, 7 skipped** (idempotent). |
| `npm run lint` | 0 | no findings |
| `npm run typecheck` | 0 | no errors |
| `npm run test:unit` | 0 | 10 files, **299 passed** (incl. 161-cell role matrix) |
| `npm run test:integration` | 0 | 9 files, **79 passed** (incl. auth and identity) |
| `npm run test:coverage` | 0 | **378 passed**. Thresholds met. Domain/application scope **187/188 lines (99.47%)**. |
| `rm -rf .next && npm run build` | 0 | **0 warnings**. All routes dynamic (needed for CSP nonces), Proxy registered. |
| `npm run test:e2e` | 0 | **16 passed**. Run twice back to back, 16/16 both times. |
| `npm audit --omit=dev --audit-level=high` | 0 | 0 high/critical. 4 moderate (see below). |
| `npm audit` (full) | 1 | 4 moderate + 5 high, the same two dev-tooling advisories as Phases 1–2 |
| secret scan: 18 distinct local secrets (3 DB passwords, auth secret, 7 seed + 7 E2E passwords) over all 153 committable files | — | **0 hits** |
| fallback pattern scan | — | hits only in the known placeholder/throwaway files |
| `gitleaks`, `actionlint` | — | **BLOCKED** (not installed) |

### Acceptance criteria

| ID | Result | Evidence |
| --- | --- | --- |
| P3a-AC1 sign-up closed; generic failures | **PASS** | `auth.test.ts`: `/sign-up/email` → 4xx and 0 users. Correct password → 200 + session cookie. Case-insensitive email. Wrong password and unknown email → identical status (401) and body. E2E: both show "Invalid email or password." |
| P3a-AC2 rate limit 429 | **PASS** | `auth.test.ts`: 5 × 401 then **429**. Even the correct password gets 429 while limited. Another IP is unaffected. Rows exist in `rate_limits`. E2E: UI shows the wait message. Also observed: counters persisted across E2E runs (see failure 5). |
| P3a-AC3 cookie attributes | **PASS** | `auth.test.ts`: HTTP gives `HttpOnly; SameSite=Lax`. HTTPS base URL gives `__Secure-…; Secure; HttpOnly; SameSite=Lax`. E2E: browser cookie `httpOnly: true`, `sameSite: 'Lax'`. |
| P3a-AC4 sign-out + replay | **PASS** | `auth.test.ts`: `get-session` with the old cookie returns `null` after sign-out. E2E: a copied cookie in a fresh browser context is redirected to sign-in. |
| P3a-AC5 deactivated profile | **PASS** | `auth.test.ts`, `identity.test.ts`: session row still valid, but `resolveActor` returns null |
| P3a-AC6 anonymous redirect; queries self-enforce | **PASS** | E2E: `/` → `/sign-in`, `/account` → `/sign-in?next=%2Faccount`. A forged cookie is rejected by the DB check. `identity.test.ts`: `account.me` without an actor → `UNAUTHENTICATED`, no page involved. *Note:* the only Server Action so far is sign-out, which uses Better Auth's own session check. Runner-backed Server Actions arrive with the admin commands in 3b. |
| P3a-AC7 role matrix | **PASS** | `roles.test.ts`: 7 roles × 23 permissions = 161 cells against an independent table. Admin has no business permissions. |
| P3a-AC8 cross-origin rejected | **PASS** | `auth.test.ts`: sign-in with `Origin: https://evil.example` → **403**, no session (after fix 3). E2E: a forged cross-origin POST to the sign-out Server Action → ≥400 ("Invalid Server Actions request" in the server log), and the user is still signed in. |
| P3a-AC9 security headers | **PASS** | `security-headers.spec.ts`: CSP with a `'nonce-…' 'strict-dynamic'` that changes per request, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri`, `form-action`, no `unsafe-eval` in the production build; `nosniff`, `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options`, `x-request-id`. HSTS absent over HTTP and present behind `x-forwarded-proto: https`. **0 CSP violations** in the browser console on sign-in and after sign-in. |
| P3a-AC10 seed + one-time links | **PASS** | Seed: only `@example.com`, idempotent (2nd run created 0). `auth.test.ts`: token TTL ≈ 24 h (checked against `verifications.expires_at`), single use (2nd use → 400), short password → 400, unknown email → no token |
| P3a-AC11 DTO allowlist | **PASS** | `identity.test.ts`: `account.me` keys equal `ACCOUNT_DTO_KEYS`. Deep scan: no password/hash/token/session/id keys, no UUIDs, no `salt:hash` strings. |
| P3a-AC12 auth audit without secrets | **PASS** | `auth.test.ts`: `user.provisioned`, `auth.passwordSet`, `auth.signedIn`, `auth.signInFailed`, `auth.signedOut` in order. The failed sign-in has a null actor, IP, and user agent, and **no email** (fingerprint only). Neither password appears anywhere in `audit_events`. |
| Definition of done | **PASS** | All checks above. ADR 0014. This report. Committed after maintainer approval (2026-10-21). |

### Failures found and fixed during the phase

1. **`session.modelName` lost:** a runtime `session` block overrode the shared schema options. Better Auth refused to start ("Drizzle schema mismatch… session"). → The shared options are now merged explicitly.
2. **`cn` npm package:** `shadcn add` added `cn@0.5.0` (published 2026-10-16, five days old, and the package is new). → Uninstalled it and pointed components at the local `cn` (clsx + tailwind-merge).
3. **Cross-origin sign-in accepted (200) in tests: a real finding.** Better Auth 1.7.7 skips its origin check when `NODE_ENV=test` unless `advanced.disableOriginCheck` is set (`context/create-context.mjs`). → Set `disableOriginCheck: false` and `disableCSRFCheck: false` explicitly. The test now gets 403. This **strengthens** the configuration and does not weaken any test.
4. **Design correction: secure cookies and HSTS were keyed on `NODE_ENV`.** `next start` is production mode even over local HTTP. → They are now keyed on HTTPS: the `BETTER_AUTH_URL` scheme for cookies, the request scheme or `x-forwarded-proto` for HSTS and `upgrade-insecure-requests`. `NODE_ENV` only controls dev relaxations.
5. **E2E: rate-limit counters from a previous run** made sign-in tests fail. That is evidence the limit is DB-persisted. → E2E uses random client IPs per run. Two consecutive full runs both passed 16/16.
6. **E2E selectors:** Next.js's route announcer is also `role="alert"`, so selectors are now scoped to the form. **Accessibility fix:** auth pages had no heading (shadcn `CardTitle` is a `div`) and now use a real `<h1>`.
7. Type and lint: the module-boundary rule forbade `identity` → `audit`. The architecture was updated deliberately (see decisions). Smaller fixes: `IdentityActor.roles` narrowed to `Role[]`, stale `.next/types` cleared.

### Decisions (ADR 0014, ADR 0006 amended)

- `buyer` → `procurement`. A base permission `account.read` for every active user.
- Provisioning happens in one transaction. The password comes from a Better Auth one-time token captured via `AsyncLocalStorage` (public API only).
- Sign-in goes through HTTP so rate limiting applies. Better Auth's docs: server-side `auth.api` calls bypass it.
- `identity` may import `audit` (`audit` still imports only `shared`, so there is no cycle).
- Auth audit writes run in their own transaction, because Better Auth writes outside ours. Sign-in and password events fail closed. Sign-out and failed-sign-in events are best effort and logged on failure.

### Dependency pins added (checked 2026-10-21, newest version ≥ 7 days old)

| Package | Version | Published | Note |
| --- | --- | --- | --- |
| better-auth / auth (CLI, dev) | 1.7.7 | 2026-09-30 | security release (GHSA-965c-763c-88jm, Magic Link). 1.7.8+ were under 7 days old at install. |
| tailwindcss / @tailwindcss/postcss (dev) | 4.3.3 | 2026-07-16 | |
| radix-ui | 1.8.1 | 2026-10-12 | |
| class-variance-authority / clsx / tailwind-merge | 0.7.1 / 2.1.1 / 3.7.0 | 2024-11 / 2024-04 / 2026-09-12 | |
| tsx (dev) | 4.23.15 | 2026-09-20 | was already present via drizzle-kit, now explicit |
| shadcn CLI (via `npx`, not a dependency) | 4.21.4 | 2026-10-07 | |

**Audit note:** `npm audit --omit=dev` now lists 4 **moderate** findings. They come from the same `drizzle-kit → @esbuild-kit → esbuild` chain (GHSA-67mh-4wv8-2f99) as before. It now counts as "production" only because `better-auth` declares `drizzle-kit` as an *optional peer*. It is not loaded at runtime, and the CI gate (`--audit-level=high`) passes.

### Files changed

New (51): `components.json`, `postcss.config.mjs`, `db/migrations/{0003_auth_and_identity.sql,0004_auth_and_identity_grants.sql,meta/0003_snapshot.json,meta/0004_snapshot.json}`, `docs/adr/0014-identity-and-sign-in.md`, `scripts/{auth-cli.config,bootstrap-admin,env-local,seed}.ts`, `scripts/lib/env-file.ts`, `src/app/(app)/{layout.tsx,page.tsx,actions.ts,account/page.tsx}`, `src/app/(public)/sign-in/{page,sign-in-form}.tsx`, `src/app/(public)/set-password/{page,set-password-form}.tsx`, `src/app/api/auth/[...all]/route.ts`, `src/app/globals.css`, `src/components/ui/{alert,button,card,input,label}.tsx`, `src/lib/{auth-client,utils}.ts`, `src/modules/identity/{index.ts,domain/roles.ts,application/{account,actor,provision-user}.ts,infrastructure/{auth-schema,schema,identity-repository}.ts}`, `src/proxy.ts`, `src/server/{auth,auth-audit,auth-schema-options,request-context}.ts`, `tests/e2e/{auth.spec,security-headers.spec,global-setup,support}.ts`, `tests/integration/{auth,identity}.test.ts`, `tests/support/auth.ts`, `tests/unit/roles.test.ts`, this report.

Modified (22): `.env.example`, `.github/workflows/ci.yml` (auth env vars), `NOTICE` (shadcn/ui MIT attribution), `README.md`, `package.json`, `package-lock.json`, `playwright.config.ts` (global setup, server env, health-gated start), `eslint.config.mjs` (identity → audit allowed, proxy env exemption), `scripts/db-local.ts` (shared env helper), `src/app/layout.tsx` (CSS, dynamic rendering), `src/server/schema.ts`, `src/shared/env.ts` (`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`), `tests/e2e/smoke.spec.ts`, `tests/unit/env.test.ts`, `db/migrations/meta/_journal.json`, docs (`PLAN.md`, `adr/README.md`, `adr/0006`, `architecture.md`, `development.md`, `schema.md`, `threat-model.md`).

Deleted (1): `src/app/page.tsx` (home moved to `src/app/(app)/page.tsx` behind sign-in).

Local only (gitignored): `.env` (auth settings added; backup in `.local/`), `.local/seed-credentials.json`, `.local/e2e-credentials.json`, the dev database (7 demo users + 7 E2E users).

### Known limitations / not verified

- **CI has never run** (no remote). The new CI env vars and the E2E global-setup seed step are unverified in CI. **gitleaks and actionlint: BLOCKED.**
- **The rate limit trusts `X-Forwarded-For`.** Without a reverse proxy that overwrites it, a client can rotate the header to evade the per-IP limit (the E2E tests rely on exactly this to isolate runs). Production needs such a proxy plus `trustedProxies` (Phase 10). No per-account lockout yet.
- **No email delivery.** Setup links are shown to the operator (bootstrap) or will be shown to the admin (3b). A self-service "forgot password" request issues a token nobody receives (logged as `auth.password_reset_not_delivered`).
- **Admin screens are not built** (Phase 3b): creating users and granting roles in the UI, deactivation with session revocation, departments, settings, and the per-command permission matrix.
- **No common-password blocklist** (threat model S-01 mentions one). Only the 12-character minimum is enforced.
- **Vitest coverage of all `src` fell to 66%**, because UI pages and `src/server/*` are exercised by E2E, which Vitest does not measure. The 85% gate on domain/application code is met (99.47%).
- **Browser coverage:** only Chromium-based Edge locally. Firefox and WebKit are not run.
- `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` for multi-instance deployments is not documented yet (Phase 10).

### Next steps

1. Maintainer review. Commit Phase 3a on approval.
2. Phase 3b: admin screens for users (create with one-time link, deactivate/reactivate with session revocation), roles (grant/revoke, SOD-05, `LAST_ADMIN`), departments, settings, and runner-backed Server Actions with the full command × role matrix test.
