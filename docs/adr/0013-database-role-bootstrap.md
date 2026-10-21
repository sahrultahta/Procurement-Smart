# ADR 0013: Database roles are bootstrapped outside migrations; migrations only grant

- Status: Accepted (refines the "Database roles" bullet of ADR 0003)
- Date: 2026-10-21 (Phase 2)

## Context

ADR 0003 planned two roles, `procureflow_owner` (schema owner, runs migrations) and `procureflow_app` (runtime, least privilege), "created by migration bootstrap". Building Phase 2 surfaced three problems with creating roles inside migrations:

- **Roles are cluster-level objects.** A migration runs per database, but integration tests clone a template database once per test file, so a `CREATE ROLE` in a migration would run against a role that already exists.
- **Creating a role needs `CREATEROLE`.** The local owner role was deliberately created without it. Managed PostgreSQL providers also restrict which roles can create roles.
- **A role password inside a migration file is a committed secret.**

## Decision

1. **Roles are created by a bootstrap step, outside migrations**, by an administrator connection:
   - local: `npm run db:local -- init` (new cluster) or `npm run db:local -- ensure-app-role` (existing cluster). The latter backs up `.env` to `.local/` before updating it.
   - CI and other environments: `npm run db:app-role` with `DATABASE_ADMIN_URL` and `APP_DB_PASSWORD` (`scripts/db-app-role.ts`, shared logic in `scripts/lib/app-role.ts`).
   - `procureflow_app` attributes: `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`. It owns nothing.
2. **Migrations only grant table privileges**, explicitly per table, in the same migration that creates the table. A migration that grants first checks that `procureflow_app` exists and fails with instructions if it doesn't.
3. **Connections:**
   - `DATABASE_URL` is the runtime connection, as `procureflow_app`.
   - `DATABASE_MIGRATION_URL` is used for migrations only, as `procureflow_owner`.
   - Tests use `TEST_DATABASE_URL` (owner, to create and drop per-file databases) and `TEST_APP_DATABASE_URL` (app role, to run application code with the real privileges).

## Consequences

- A fresh environment needs one extra bootstrap step before `db:migrate`. `docs/development.md` and the CI workflow include it.
- Application code is tested under the same privileges it runs with in production. That is how Phase 2 proves the runtime role cannot UPDATE, DELETE, or TRUNCATE `audit_events`, disable its triggers, or run DDL.
- Verified in Phase 2: inserting into a `GENERATED ALWAYS AS IDENTITY` column needs **no** grant on the identity sequence. So the runtime role gets no sequence privileges, which is tighter than ADR 0009's wording ("and its identity sequence").

## Verification

`tests/integration/audit.test.ts` (privilege and trigger tests, `current_user` check) and `tests/support/global-setup.ts` (fails clearly if the role is missing).
