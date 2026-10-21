# ADR 0014: Identity roles, user provisioning, and sign-in hardening

- Status: Accepted (amends the role table of ADR 0006; details ADR 0005)
- Date: 2026-10-21 (Phase 3a)

## Context

Phase 3a implemented authentication with Better Auth 1.7.7 and the role model. Several facts, checked in the official docs and in the installed source, shaped the design:

- **Better Auth rate limits HTTP requests only.** Its docs say "Server-side requests made using `auth.api` aren't affected by rate limiting."
- **Rate limiting is off in development by default**, and it is stored in memory by default.
- **Better Auth 1.7.7 skips the origin/CSRF check when `NODE_ENV=test`** unless `advanced.disableOriginCheck` is set explicitly (`context/create-context.mjs`: `skipOriginCheck: … isTest() ? true : false`). Our first integration test caught this: a cross-origin sign-in returned 200.
- **`reset-password` creates the credential account if the user has none** (`api/routes/password.mjs`). **`requestPasswordReset` awaits `sendResetPassword`** in the same request (`runInBackgroundOrAwait`, no background handler configured).
- **Wrong password and unknown email return the same error**, `INVALID_EMAIL_OR_PASSWORD` "Invalid email or password".
- **The maintainer's role list** has "Procurement" (the design's `buyer`) and keeps `finance` for separation of duties (decided 2026-10-21).

## Decision

1. **Roles:** the seven roles are `admin`, `requester`, `approver`, `procurement`, `receiver`, `finance`, `auditor`. `buyer` is renamed `procurement`, with identical permissions. Every active user also gets the base permission `account.read` (their own account), even with no role. The full matrix is in `src/modules/identity/domain/roles.ts`, and `tests/unit/roles.test.ts` checks it cell by cell against an independently written table.
2. **Provisioning, no sign-up:** `disableSignUp: true`. `provisionUser` inserts the user row, profile, role assignments, and audit events in **one transaction**, as the runtime role. The user then sets a password through a **one-time link**:
   - The token comes from Better Auth's public `requestPasswordReset` and is captured with `AsyncLocalStorage` in `sendResetPassword`, so no internal token format is relied on.
   - The link is valid for 24 h and works once.
   - `revokeSessionsOnPasswordReset` is on.
   - There is no email in v1: the operator or admin passes the link on out of band.
3. **Sign-in goes through HTTP** (`/api/auth/sign-in/email` from a client form), never a Server Action, so rate limiting applies. Rate limiting is on in every environment, stored in PostgreSQL (`rate_limits`), with sign-in limited to **5 per 60 s per client IP**. Reset-password and request-reset are limited too.
4. **Origin and CSRF checks are forced on** (`disableOriginCheck: false`, `disableCSRFCheck: false`), so tests exercise production behavior. `trustedOrigins` is exactly `BETTER_AUTH_URL`.
5. **Cookies:** `HttpOnly` and `SameSite=Lax` always. `Secure` with the `__Secure-` prefix whenever `BETTER_AUTH_URL` is HTTPS. That depends on the scheme, not on `NODE_ENV`, because `next start` runs in production mode over plain HTTP locally. Cookie cache is off, so revocation takes effect on the next request.
6. **Every request re-validates:** `getRequestContext()` validates the session against the database and then requires an **active profile**. A deactivated user is treated as signed out even if a session row survives. `proxy.ts` only does an optimistic cookie-presence redirect.
7. **Authentication events are audited from Better Auth hooks:**
   - `auth.signedIn` is written in `session.create.before`, so no session is created without an audit row.
   - `auth.passwordSet` and `auth.passwordChanged` are written in account hooks.
   - `auth.signInFailed` is written in an after-hook and stores only a SHA-256 fingerprint of the attempted email.
   - `auth.signedOut` is written in `session.delete.after` and never blocks sign-out.
   These writes run in their own transaction, because Better Auth writes its rows outside ours.
8. **Module rule change:** `identity` may import `audit`, because provisioning and role changes must be audited. `audit` still imports only `shared`, so there is no cycle.
9. **UI dependencies:** shadcn/ui components are copied into `src/components/ui` (MIT, noted in `NOTICE`). The `cn` npm package that shadcn 4.21.4 tried to add was **removed**: 0.5.0 was 5 days old (below the 7-day rule), the package is new (first versions September 2026), and it duplicates `clsx` + `tailwind-merge`. Components import the local `cn` from `src/lib/utils.ts`.

## Consequences

- **The IP-based rate limit trusts `X-Forwarded-For`.** Without a reverse proxy that overwrites that header, a client can rotate it and bypass the per-IP limit. Production must run behind such a proxy, and Phase 10 configures `advanced.ipAddress.trustedProxies`. A per-account limit would be an additional control (not built).
- Auth audit rows are not in the same transaction as Better Auth's writes. Sign-in and password events fail closed (no audit, no change). Sign-out and failed-sign-in events are best effort, and their failures are logged.
- Revoking another user's sessions (deactivation, Phase 3b) is done by deleting their `sessions` rows in the same transaction as the profile update, not through the admin plugin, whose own role model conflicts with ADR 0006.

## Verification

`tests/integration/auth.test.ts` (P3a-AC1/2/3/4/5/8/10/12), `tests/integration/identity.test.ts` (AC6/AC11), `tests/unit/roles.test.ts` (AC7), and `tests/e2e/{auth,security-headers,smoke}.spec.ts` (AC1/2/3/4/6/8/9) in a real browser.
