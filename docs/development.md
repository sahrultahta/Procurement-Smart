# Local development

## Prerequisites

- Node.js 24 LTS (`.nvmrc`). npm comes with it.
- PostgreSQL 18 server binaries (see below).
- For E2E tests on Windows: Microsoft Edge, used through Playwright's `msedge` channel, so no browser download is needed. Elsewhere, set `PLAYWRIGHT_CHANNEL` or run `npx playwright install chromium`.

`.npmrc` sets `ignore-scripts=true`, so dependency install scripts never run (ADR 0012).

```
npm ci
```

## PostgreSQL 18 (portable, no admin rights, no service)

`scripts/db-local.ts` manages a cluster in `.local/` (gitignored), bound to `127.0.0.1:54318`. **It never downloads anything.** Get the binaries yourself:

1. Download the PostgreSQL 18 **Windows x86-64 binaries** zip from EDB's binaries page: https://www.enterprisedb.com/download-postgresql-binaries
2. Extract it so that `.local/pgsql/bin/pg_ctl.exe` exists. The archive's top folder is `pgsql/`, so extract it into `.local/`.
3. On macOS or Linux, point `PG_BIN` at your PostgreSQL 18 `bin` directory instead.

Then:

```
npm run db:local -- init             # cluster + both roles + procureflow_dev database + .env
npm run db:local -- start
npm run db:migrate                   # as procureflow_owner (DATABASE_MIGRATION_URL)
npm run db:local -- status
npm run db:local -- stop
```

`init` generates random passwords. The superuser password goes to `.local/superuser-password.txt`, and the four connection URLs go into `.env`. It refuses to run if `.env` already exists.

**Database roles (ADR 0013).** `procureflow_owner` owns the schema and runs migrations. `procureflow_app` is the runtime role: it can read and write business tables but cannot run DDL, and it can only INSERT and SELECT `audit_events`. Roles are created outside migrations.

- **Cluster created before Phase 2:** run `npm run db:local -- ensure-app-role` once. It creates `procureflow_app`, backs up `.env` to `.local/env-backup-*.txt`, then points `DATABASE_URL` at the app role and adds `DATABASE_MIGRATION_URL` and `TEST_APP_DATABASE_URL`.
- **Other environments (CI, staging):** `npm run db:app-role`, with `DATABASE_ADMIN_URL` and `APP_DB_PASSWORD` set.

## First sign-in (Phase 3a)

```
npm run env:local         # adds BETTER_AUTH_SECRET (random) and BETTER_AUTH_URL to .env if missing
npm run db:migrate
npm run seed              # fictional departments + one user per role (@example.com)
npm run dev               # then open http://localhost:3000/sign-in
```

`seed` also registers three fictional suppliers as Dewi (procurement), two of them approved by Sari (finance), through the real commands. It writes random passwords for the users it creates to `.local/seed-credentials.json` (gitignored, never printed). It is idempotent, and `--reset-passwords` gives existing seed users new passwords. It refuses to run with `NODE_ENV=production`.

For a real installation, create only the first administrator: `npm run bootstrap-admin -- --email you@example.com --name "Your Name"`. It prints a one-time link (valid 24 h, single use) to set the password, and refuses to run if an admin already exists.

**Administration (Phase 3b).** Sign in as an admin (for example `ada.admin@example.com` from the seed) and open **Admin**. There you can create users (you get a one-time setup link to pass on), edit their name and department, grant and revoke roles, deactivate and reactivate users, and manage departments. An admin cannot change their own account; another admin must do it.

**Suppliers (Phase 4).** Sign in as `dewi.procurement@example.com` to register and edit suppliers, and as `sari.finance@example.com` to approve, reject, or unblock them. A supplier you registered, or whose legal name or tax ID you last changed, has to be approved by someone else. `lena.auditor@example.com` can look but not change anything.

**E2E database.** `npm run test:e2e` never touches `procureflow_dev`. Before starting the server, Playwright runs `scripts/e2e-db.ts`, which drops and recreates `pf_e2e` (with `TEST_DATABASE_URL`) and migrates it. Global setup then creates the E2E users (`e2e.*@example.com`, credentials in `.local/e2e-credentials.json`). Users cannot be deleted, so a throwaway database is the only way to keep test users out of the demo data. If a server is already listening on port 3100, Playwright reuses it, and no fresh database is made: stop that server first.

## Everyday commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Next.js dev server (needs `.env`) |
| `npm run lint` | ESLint, including architecture boundary rules |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test:unit` | Unit tests (no database) |
| `npm test` | Unit + integration + concurrency tests (needs PostgreSQL running) |
| `npm run test:coverage` | The same, plus the 85% line-coverage gate on `domain/` and `application/` code |
| `npm run build` | Production build |
| `npm run test:e2e` | Playwright against `next start` on port 3100, on its own database `pf_e2e` (run `npm run build` first) |
| `npm run db:generate` | Generate a migration from schema changes (review the SQL before committing) |
| `npm run db:migrate` | Apply migrations to `DATABASE_MIGRATION_URL` (falls back to `DATABASE_URL`) |
| `npm run db:app-role` | Create or update `procureflow_app` outside the local cluster |
| `npm run env:local` | Add missing auth settings to `.env` (never overwrites; backs up first) |
| `npm run seed` | Fictional demo data (see above) |
| `npm run bootstrap-admin -- --email … --name …` | First administrator plus a one-time password link |

Integration tests clone a migrated template database (`pf_template`) once per test file (ADR 0011). Setup uses `TEST_DATABASE_URL` (needs `CREATEDB`). Application code under test runs through `TEST_APP_DATABASE_URL`, with the runtime role's real privileges.

Custom SQL (triggers, grants) goes into migrations made with `npx drizzle-kit generate --custom --name=<name>`. Table declarations (`*/infrastructure/schema.ts`, `src/shared/db/tables.ts`) must stay free of `server-only` and I/O, because drizzle-kit loads them directly.

## Telemetry

Next.js collects anonymous telemetry by default. CI disables it with `NEXT_TELEMETRY_DISABLED=1`. To opt out locally, set the same variable in your shell, or run `npx next telemetry disable` (a per-user setting).
